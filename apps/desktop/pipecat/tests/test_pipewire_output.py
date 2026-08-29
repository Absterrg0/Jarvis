from __future__ import annotations

import asyncio
import unittest

from pipecat.frames.frames import OutputAudioRawFrame, StartFrame
from pipecat.transports.base_output import BaseOutputTransport

from jarvis_voice_runtime.output import PipeWireAudioOutputTransport


class _Writer:
    def __init__(self) -> None:
        self.audio = bytearray()
        self.closed = False
        self.close_called = asyncio.Event()
        self.wait_closed_allowed = asyncio.Event()
        self.wait_closed_allowed.set()
        self.drain_started = asyncio.Event()
        self.drain_allowed = asyncio.Event()
        self.drain_allowed.set()
        self.drain_error: Exception | None = None

    def write(self, audio: bytes) -> None:
        self.audio.extend(audio)

    async def drain(self) -> None:
        self.drain_started.set()
        await self.drain_allowed.wait()
        if self.drain_error is not None:
            raise self.drain_error

    def close(self) -> None:
        self.closed = True
        self.close_called.set()

    async def wait_closed(self) -> None:
        await self.wait_closed_allowed.wait()


class _Process:
    def __init__(self) -> None:
        self.stdin = _Writer()
        self.stderr = asyncio.StreamReader()
        self.stdout = None
        self.returncode: int | None = None
        self.terminated = False
        self.killed = False
        self._exited = asyncio.Event()

    async def wait(self) -> int:
        await self._exited.wait()
        assert self.returncode is not None
        return self.returncode

    def complete(self, returncode: int, stderr: bytes = b"") -> None:
        self.returncode = returncode
        self.stderr.feed_data(stderr)
        self.stderr.feed_eof()
        self._exited.set()

    def terminate(self) -> None:
        self.terminated = True
        self.complete(-15)

    def kill(self) -> None:
        self.killed = True
        self.complete(-9)


class PipeWireOutputTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.process = _Process()
        self.argv: tuple[object, ...] | None = None
        self.options: dict[str, object] | None = None

        async def spawn(*argv: object, **options: object) -> _Process:
            self.argv = argv
            self.options = options
            return self.process

        self.output = PipeWireAudioOutputTransport(
            sample_rate=24_000,
            executable="pw-play",
            process_factory=spawn,  # type: ignore[arg-type]
            drain_timeout=0.2,
            terminate_timeout=0.05,
        )
        await BaseOutputTransport.start(self.output, StartFrame(audio_out_sample_rate=24_000))
        self.output.reset_utterance()

    async def asyncTearDown(self) -> None:
        await self.output.cleanup()

    def frame(self, audio: bytes = b"\x01\x00\x02\x00") -> OutputAudioRawFrame:
        return OutputAudioRawFrame(audio=audio, sample_rate=24_000, num_channels=1)

    async def test_uses_exact_raw_pcm_without_pin_to_a_device(self) -> None:
        self.assertTrue(await self.output.write_audio_frame(self.frame()))
        self.assertEqual(
            self.argv,
            ("pw-play", "--raw", "--rate", "24000", "--channels", "1", "--format", "s16", "-"),
        )
        assert self.argv is not None
        self.assertNotIn("--target", self.argv)
        self.assertEqual(bytes(self.process.stdin.audio), self.frame().audio)
        self.process.complete(0)
        self.assertTrue(await self.output.finish_utterance())

    async def test_completion_waits_for_pipewire_drain_exit(self) -> None:
        await self.output.write_audio_frame(self.frame())
        finishing = asyncio.create_task(self.output.finish_utterance())
        await self.process.stdin.close_called.wait()
        self.assertTrue(self.process.stdin.closed)
        self.assertFalse(finishing.done())
        self.process.complete(0)
        self.assertTrue(await finishing)

    async def test_nonzero_exit_is_a_failure_not_completion(self) -> None:
        await self.output.write_audio_frame(self.frame())
        self.process.complete(1, b"no default sink")
        self.assertFalse(await self.output.finish_utterance())
        self.assertIsNotNone(self.output.output_error)
        self.assertIn("no default sink", str(self.output.output_error))

    async def test_interruption_terminates_and_reaps_while_write_is_blocked(self) -> None:
        self.process.stdin.drain_allowed.clear()
        writing = asyncio.create_task(self.output.write_audio_frame(self.frame()))
        await self.process.stdin.drain_started.wait()
        await self.output.abort_utterance()
        self.assertTrue(self.process.terminated)
        self.process.stdin.drain_allowed.set()
        self.assertFalse(await writing)
        self.assertIsNone(self.output.output_error)

    async def test_caller_cancellation_cannot_orphan_the_owned_child(self) -> None:
        await self.output.write_audio_frame(self.frame())
        finishing = asyncio.create_task(self.output.finish_utterance())
        await self.process.stdin.close_called.wait()
        finishing.cancel()
        await asyncio.gather(finishing, return_exceptions=True)
        await self.output.cleanup()
        self.assertTrue(self.process.terminated)
        self.assertIsNotNone(self.process.returncode)

    async def test_abort_absorbs_an_inflight_spawn_failure(self) -> None:
        started = asyncio.Event()
        release = asyncio.Event()

        async def failing_spawn(*_argv: object, **_options: object) -> _Process:
            started.set()
            await release.wait()
            raise OSError("pw-play disappeared")

        output = PipeWireAudioOutputTransport(
            sample_rate=24_000,
            executable="pw-play",
            process_factory=failing_spawn,  # type: ignore[arg-type]
        )
        await BaseOutputTransport.start(output, StartFrame(audio_out_sample_rate=24_000))
        output.reset_utterance()
        writing = asyncio.create_task(output.write_audio_frame(self.frame()))
        await started.wait()
        aborting = asyncio.create_task(output.abort_utterance())
        release.set()
        await aborting
        self.assertFalse(await writing)
        output.reset_utterance()
        await output.abort_utterance()

    async def test_late_broken_pipe_after_abort_is_not_a_fresh_output_failure(self) -> None:
        self.process.stdin.drain_allowed.clear()
        writing = asyncio.create_task(self.output.write_audio_frame(self.frame()))
        await self.process.stdin.drain_started.wait()
        await self.output.abort_utterance()
        self.process.stdin.drain_error = BrokenPipeError("intentional termination")
        self.process.stdin.drain_allowed.set()
        self.assertFalse(await writing)
        self.assertIsNone(self.output.output_error)

    async def test_stuck_pipe_close_is_bounded_and_reaped(self) -> None:
        await self.output.write_audio_frame(self.frame())
        self.process.stdin.wait_closed_allowed.clear()
        self.assertFalse(await self.output.finish_utterance())
        self.assertTrue(self.process.terminated)
        self.assertIsNotNone(self.output.output_error)

    async def test_stuck_stderr_reader_is_bounded_and_reaped(self) -> None:
        await self.output.write_audio_frame(self.frame())
        self.process.returncode = 0
        self.process._exited.set()
        self.assertFalse(await self.output.finish_utterance())
        self.assertIsNotNone(self.output.output_error)

    async def test_rejects_pcm_shape_changes(self) -> None:
        with self.assertRaisesRegex(ValueError, "sample rate changed"):
            await self.output.write_audio_frame(
                OutputAudioRawFrame(audio=b"\x00\x00", sample_rate=16_000, num_channels=1)
            )
        self.assertIsNotNone(self.output.output_error)


if __name__ == "__main__":
    unittest.main()
