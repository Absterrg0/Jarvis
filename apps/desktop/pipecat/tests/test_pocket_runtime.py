from __future__ import annotations

import asyncio
import base64
import struct
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from pipecat.frames.frames import OutputAudioRawFrame, StartFrame
from pipecat.transports.base_output import BaseOutputTransport
from pipecat.transports.base_transport import TransportParams

from jarvis_voice_runtime.pocket import (
    DaemonError,
    JarvisPocketTTSService,
    PocketDaemon,
    create_pocket_tts,
    validate_pocket_root,
)
from jarvis_voice_runtime.runtime import Runtime


def _write_float_wav(path: Path, samples: list[float], sample_rate: int = 24_000) -> None:
    """Write a true IEEE-float chunk like the daemon emits (stdlib wave cannot)."""
    import struct

    data = struct.pack(f"<{len(samples)}f", *samples)
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + len(data),
        b"WAVE",
        b"fmt ",
        16,
        3,
        1,
        sample_rate,
        sample_rate * 4,
        4,
        32,
        b"data",
        len(data),
    )
    path.write_bytes(header + data)


def _int16_audio(samples: list[float]) -> bytes:
    import array

    return array.array(
        "h",
        (round(sample * (32_768 if sample < 0 else 32_767)) for sample in samples),
    ).tobytes()


SPEECH = [0.2] * 480
LEADING_SILENCE = [0.0] * 2400


class _FakeDaemon:
    """Deterministic stand-in for the Pocket daemon process."""

    def __init__(self) -> None:
        self.start_count = 0
        self.close_count = 0
        self.cancel_requests: list[str] = []
        self.running = True
        self.started = threading.Event()
        self.release = threading.Event()
        self.release.set()
        self.fail_message: str | None = None
        self.chunks: list[list[float]] | None = None
        self.syntheses = 0

    def start(self) -> None:
        self.start_count += 1

    def ensure_running(self) -> None:
        if not self.running:
            self.running = True
            self.start()

    def synthesize(
        self,
        request_id: str,
        text: str,
        output_directory: str,
        cancelled: threading.Event,
        on_chunk,
    ) -> dict[str, object] | None:
        del text
        self.syntheses += 1
        self.started.set()
        self.release.wait(timeout=5)
        if self.fail_message is not None and not cancelled.is_set():
            raise DaemonError(self.fail_message)
        payload = self.chunks if self.chunks is not None else [LEADING_SILENCE + SPEECH]
        raw: list[tuple[int, str]] = []
        for index, samples in enumerate(payload):
            if cancelled.is_set():
                break
            path = str(Path(output_directory) / f"raw-{index:06d}.wav")
            _write_float_wav(Path(path), samples)
            raw.append((index, path))
            on_chunk(path)
        if cancelled.is_set():
            return None
        return {
            "sampleRate": 24_000,
            "chunkCount": len(raw),
            "synthesisCpuMs": 125,
            "synthesisDurationMs": 90,
            "peakRssBytes": 300_000_000,
        }

    def cancel(self, request_id: str) -> None:
        self.cancel_requests.append(request_id)

    def current_rss_bytes(self) -> int:
        return 300 * 1024 * 1024

    def close(self) -> None:
        self.close_count += 1
        self.running = False


class _FakeHandle:
    sample_rate = 24_000

    def __init__(self, daemon: _FakeDaemon | None = None) -> None:
        self.daemon = daemon or _FakeDaemon()

    def ensure_running(self) -> None:
        self.daemon.ensure_running()

    def close(self) -> None:
        self.daemon.close()


class _Recognizer:
    def create_stream(self, _hotwords: str = "") -> object:
        return type("Stream", (), {"result": type("Result", (), {"text": ""})()})()

    def decode_stream(self, _stream: object) -> None:
        return


class _FakeSpeechOutput(BaseOutputTransport):
    def __init__(self, sample_rate: int) -> None:
        super().__init__(
            TransportParams(
                audio_out_enabled=True,
                audio_out_sample_rate=sample_rate,
                audio_out_channels=1,
                audio_out_auto_silence=False,
                audio_out_end_silence_secs=0,
            )
        )
        self.writes: list[bytes] = []
        self.write_started = asyncio.Event()
        self.write_allowed = asyncio.Event()
        self.write_allowed.set()
        self.failure: Exception | None = None
        self.closed = False
        self.output_error: Exception | None = None
        self.active = False

    async def start(self, frame: StartFrame) -> None:
        await super().start(frame)
        await self.set_transport_ready(frame)

    async def write_audio_frame(self, frame: OutputAudioRawFrame) -> bool:
        self.write_started.set()
        await self.write_allowed.wait()
        if self.failure is not None:
            self.output_error = self.failure
            raise self.failure
        self.writes.append(frame.audio)
        return True

    def reset_utterance(self) -> None:
        if self.active:
            raise RuntimeError("previous utterance is active")
        self.active = True
        self.closed = False
        self.output_error = None

    async def finish_utterance(self) -> bool:
        had_audio = bool(self.writes)
        self.active = False
        self.closed = True
        return had_audio and self.output_error is None

    async def abort_utterance(self) -> None:
        self.active = False
        self.closed = True


class PocketServiceTest(unittest.IsolatedAsyncioTestCase):
    async def test_streams_filtered_audible_chunks_in_order_with_exact_count(self) -> None:
        service = JarvisPocketTTSService(_FakeHandle())  # type: ignore[arg-type]
        frames = [frame async for frame in service.run_tts("hello", "context")]
        self.assertTrue(frames)
        self.assertEqual([frame.sample_rate for frame in frames], [24_000] * len(frames))
        self.assertEqual(service.last_metrics is not None, True)
        assert service.last_metrics is not None
        self.assertEqual(service.last_metrics.chunk_count, len(frames))
        self.assertEqual(
            service.last_metrics.total_samples, sum(len(frame.audio) // 2 for frame in frames)
        )
        self.assertIsNotNone(service.last_metrics.first_chunk_ms)
        # Leading silence is removed: the -50 dBFS gate opens on the first
        # window containing speech, keeping the 40 ms preroll, and the output
        # ends with the complete utterance.
        self.assertEqual(
            b"".join(frame.audio for frame in frames),
            _int16_audio([0.0] * 1199 + SPEECH),
        )

    async def test_daemon_failure_is_a_typed_error_not_success(self) -> None:
        daemon = _FakeDaemon()
        daemon.fail_message = "Pocket synthesis failed."
        service = JarvisPocketTTSService(_FakeHandle(daemon))  # type: ignore[arg-type]
        with self.assertRaisesRegex(DaemonError, "Pocket synthesis failed"):
            [frame async for frame in service.run_tts("hello", "context")]

    async def test_empty_native_audio_is_a_synthesis_failure(self) -> None:
        daemon = _FakeDaemon()
        daemon.chunks = []
        service = JarvisPocketTTSService(_FakeHandle(daemon))  # type: ignore[arg-type]
        with self.assertRaisesRegex(RuntimeError, "Pocket produced no audio"):
            [frame async for frame in service.run_tts("hello", "context")]

    async def test_cancel_before_first_output_reports_interrupted_and_stays_warm(self) -> None:
        daemon = _FakeDaemon()
        daemon.release.clear()
        service = JarvisPocketTTSService(_FakeHandle(daemon))  # type: ignore[arg-type]
        frames = service.run_tts("hello", "context")
        pending = asyncio.create_task(frames.__anext__())
        await asyncio.to_thread(daemon.started.wait, 2)
        cancelling = asyncio.create_task(service.cancel_generation())
        await asyncio.sleep(0)
        daemon.release.set()
        await asyncio.wait_for(cancelling, timeout=2)
        with self.assertRaises(StopAsyncIteration):
            await asyncio.wait_for(pending, timeout=2)
        # The daemon stays warm: the next utterance reuses it without restart.
        starts = daemon.start_count
        daemon.release.set()
        later = [frame async for frame in service.run_tts("again", "context")]
        self.assertTrue(later)
        self.assertEqual(daemon.start_count, starts)

    async def test_non_wav_bytes_are_rejected_not_played_as_success(self) -> None:
        daemon = _FakeDaemon()

        def bogus(path: Path, samples: list[float], sample_rate: int = 24_000) -> None:
            del samples, sample_rate
            path.write_bytes(b"not-a-wav")

        with patch("test_pocket_runtime._write_float_wav", side_effect=bogus):
            service = JarvisPocketTTSService(_FakeHandle(daemon))  # type: ignore[arg-type]
            with self.assertRaisesRegex(DaemonError, "not a WAV|unreadable"):
                [frame async for frame in service.run_tts("hello", "context")]

    async def test_overlapping_synthesis_is_rejected(self) -> None:
        daemon = PocketDaemon.__new__(PocketDaemon)
        daemon._synthesis_lock = threading.Lock()
        daemon._synthesis_lock.acquire()
        errors: list[BaseException] = []

        def attempt() -> None:
            try:
                daemon.synthesize("second", "hello", "/tmp", threading.Event(), lambda _: None)
            except BaseException as error:  # noqa: BLE001 - records the contract error
                errors.append(error)

        worker = threading.Thread(target=attempt)
        worker.start()
        worker.join(timeout=5)
        daemon._synthesis_lock.release()
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], DaemonError)
        self.assertIn("overlapping", str(errors[0]))

    def test_pocket_root_validation_names_the_missing_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, "text_conditioner.onnx"):
                validate_pocket_root(Path(directory))

    def test_create_pocket_tts_rejects_a_missing_daemon(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "models").mkdir()
            for name in (
                "text_conditioner.onnx",
                "flow_lm_main_int8.onnx",
                "flow_lm_flow.onnx",
                "mimi_decoder.onnx",
                "mimi_encoder.onnx",
                "bos_before_voice.f32",
                "tokenizer.model",
                "bundle.json",
            ):
                (root / "models" / name).write_bytes(b"stub")
            (root / "voices").mkdir()
            (root / "voices" / "alba-casual-3s.wav").write_bytes(b"stub")
            (root / "PROVENANCE.json").write_bytes(b"{}")
            with self.assertRaisesRegex(RuntimeError, "speech runtime is missing"):
                create_pocket_tts(root)


class PocketRuntimeTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.messages: list[dict[str, object]] = []
        self.runtime: Runtime | None = None
        self.speech_done = asyncio.Event()
        self.synthesis_done = asyncio.Event()
        self.audio_output = _FakeSpeechOutput(24_000)

    async def asyncTearDown(self) -> None:
        if self.runtime is not None:
            await self.runtime.command({"type": "shutdown", "requestId": "teardown"})
        self.directory.cleanup()

    def _runtime_with(self, handle: object) -> Runtime:
        runtime: Runtime

        def output(message: dict[str, object]) -> None:
            self.messages.append(message)
            if message.get("type") == "speech-result":
                self.speech_done.set()
            if message.get("type") == "synthesis-result":
                self.synthesis_done.set()

        runtime = Runtime(
            self.root,
            pocket_root=self.root,
            tts_factory=lambda _root: handle,  # type: ignore[arg-type]
            speech_output_factory=lambda _sample_rate: self.audio_output,
            output=output,
        )
        self.runtime = runtime
        return runtime

    async def test_speech_completes_only_after_pipecat_native_playout(self) -> None:
        self.audio_output.write_allowed.clear()
        runtime = self._runtime_with(_FakeHandle())
        await runtime.command({"type": "speech-prepare", "requestId": "prepare"})
        await runtime.command(
            {"type": "speech-start", "requestId": "start", "speechId": "speech-1", "text": "hello"}
        )
        await asyncio.wait_for(self.audio_output.write_started.wait(), timeout=2)
        self.assertFalse(any(message.get("type") == "speech-result" for message in self.messages))
        self.audio_output.write_allowed.set()
        await asyncio.wait_for(self.speech_done.wait(), timeout=2)
        result = next(
            message for message in self.messages if message.get("type") == "speech-result"
        )
        self.assertEqual(result["status"], "completed")
        self.assertEqual(self.audio_output.sample_rate, 24_000)
        self.assertTrue(self.audio_output.closed)

    async def test_second_speech_reuses_the_resident_pocket_pipeline(self) -> None:
        tts_loads = 0

        def load_tts(_root: Path) -> _FakeHandle:
            nonlocal tts_loads
            tts_loads += 1
            return _FakeHandle()

        def output(message: dict[str, object]) -> None:
            self.messages.append(message)
            if message.get("type") == "speech-result":
                self.speech_done.set()

        runtime = Runtime(
            self.root,
            pocket_root=self.root,
            tts_factory=load_tts,
            speech_output_factory=lambda _sample_rate: self.audio_output,
            output=output,
        )
        self.runtime = runtime

        await runtime.command({"type": "speech-prepare", "requestId": "prepare"})
        await runtime.command(
            {
                "type": "speech-start",
                "requestId": "start-1",
                "speechId": "speech-1",
                "text": "first",
            }
        )
        await asyncio.wait_for(self.speech_done.wait(), timeout=2)

        self.speech_done.clear()
        await runtime.command({"type": "speech-prepare", "requestId": "prepare-again"})
        await runtime.command(
            {
                "type": "speech-start",
                "requestId": "start-2",
                "speechId": "speech-2",
                "text": "second",
            }
        )
        await asyncio.wait_for(self.speech_done.wait(), timeout=2)

        self.assertEqual(tts_loads, 1)
        self.assertIsNotNone(runtime._tts)  # type: ignore[attr-defined]
        self.assertIsNone(runtime._recognizer)  # type: ignore[attr-defined]

    async def test_cancelled_pipeline_cannot_finish_the_next_synthesis(self) -> None:
        class StreamingDaemon(_FakeDaemon):
            def synthesize(self, request_id, text, output_directory, cancelled, on_chunk):
                self.started.clear()
                path = Path(output_directory) / "chunk.wav"
                _write_float_wav(path, SPEECH * 20)
                on_chunk(str(path))
                self.started.set()
                cancelled.wait(3)
                return None

        for mode in ("speech", "synthesis"):
            daemon = StreamingDaemon()
            runtime = self._runtime_with(_FakeHandle(daemon))
            runtime._speech_output_factory = lambda rate: _FakeSpeechOutput(rate)
            if mode == "speech":
                await runtime.command({"type": "speech-prepare", "requestId": "prepare"})
            for index in range(3):
                done = self.speech_done if mode == "speech" else self.synthesis_done
                done.clear()
                daemon.started.clear()
                sid = f"cancel-{mode}-{index}"
                await runtime.command(
                    {
                        "type": f"{mode}-start",
                        "requestId": sid,
                        f"{mode}Id": sid,
                        "text": "Still speaking.",
                    }
                )
                await asyncio.to_thread(daemon.started.wait, 2)
                active = runtime.speech if mode == "speech" else runtime.synthesis
                self.assertIsNotNone(active)
                if mode == "speech":
                    await runtime._cancel_speech(active)
                else:
                    await runtime._cancel_synthesis(active)
                await asyncio.wait_for(done.wait(), 2)
                result = next(
                    m
                    for m in self.messages
                    if m.get("type") == f"{mode}-result" and m.get(f"{mode}Id") == sid
                )
                self.assertEqual(result.get("code"), "cancelled")
            self.assertEqual(daemon.close_count, 0)
            await runtime.command({"type": "shutdown", "requestId": "done"})

    async def test_remote_pcm_is_emitted_before_native_generation_finishes(self) -> None:
        class StreamingDaemon(_FakeDaemon):
            def synthesize(self, request_id, text, output_directory, cancelled, on_chunk):
                path = Path(output_directory) / "first.wav"
                _write_float_wav(path, SPEECH * 20)
                on_chunk(str(path))
                self.release.wait(3)
                return {"sampleRate": 24000, "chunkCount": 1}
        daemon = StreamingDaemon()
        daemon.release.clear()
        runtime = self._runtime_with(_FakeHandle(daemon))
        first = asyncio.Event()
        emit = runtime._emit
        def observe(message):
            emit(message)
            if message.get("type") == "synthesis-audio":
                first.set()
        runtime._emit = observe
        try:
            await runtime.command({"type": "synthesis-start", "requestId": "stream",
                                   "synthesisId": "stream", "text": "Ready."})
            await asyncio.wait_for(first.wait(), 1)
            self.assertFalse(self.synthesis_done.is_set())
        finally:
            daemon.release.set()
        await asyncio.wait_for(self.synthesis_done.wait(), 2)

    async def test_remote_synthesis_returns_complete_ordered_pcm(self) -> None:
        runtime = self._runtime_with(_FakeHandle())
        await runtime.command(
            {
                "type": "synthesis-start",
                "requestId": "synthesize",
                "synthesisId": "mobile-1",
                "text": "hello",
            }
        )
        await asyncio.wait_for(self.synthesis_done.wait(), timeout=2)
        chunks = [message for message in self.messages if message.get("type") == "synthesis-audio"]
        result = next(
            message for message in self.messages if message.get("type") == "synthesis-result"
        )
        pcm = b"".join(base64.b64decode(str(chunk["data"])) for chunk in chunks)
        self.assertEqual([chunk["sequence"] for chunk in chunks], list(range(len(chunks))))
        # The transport may rechunk and zero-pad the tail; the utterance
        # itself starts with the filtered audio. Exact frame equality is
        # proven at the service level above.
        self.assertTrue(pcm.startswith(_int16_audio([0.0] * 1199 + SPEECH)))
        self.assertEqual(len(pcm), result["audioBytes"])
        self.assertEqual(result["ok"], True)
        self.assertEqual(result["sampleRate"], 24_000)
        self.assertEqual(result["audioBytes"], len(pcm))

    async def test_remote_synthesis_reports_cold_then_warm_pocket_timing(self) -> None:
        runtime = self._runtime_with(_FakeHandle())
        for index in range(2):
            self.synthesis_done.clear()
            synthesis_id = f"mobile-{index}"
            await runtime.command(
                {
                    "type": "synthesis-start",
                    "requestId": f"synthesize-{index}",
                    "synthesisId": synthesis_id,
                    "text": "hello",
                }
            )
            await asyncio.wait_for(self.synthesis_done.wait(), timeout=2)

        results = [
            message
            for message in self.messages
            if message.get("type") == "synthesis-result" and message.get("ok") is True
        ]
        self.assertEqual(
            [result["timing"]["start"] for result in results],  # type: ignore[index]
            ["cold", "warm"],
        )
        timing = results[0]["timing"]
        assert isinstance(timing, dict)
        self.assertEqual(timing["nativeCpuMs"], 125)
        self.assertEqual(timing["nativePeakRssBytes"], 300_000_000)
        self.assertEqual(timing["synthesisCpuMs"], timing["hostCpuMs"] + 125)
        self.assertGreater(timing["sampledPeakRssBytes"], timing["currentRssBytes"])
        self.assertEqual(timing["engineId"], "pocket-2026-04")
        self.assertGreaterEqual(timing["warmupMs"], 0)
        self.assertGreaterEqual(timing["firstChunkReadyMs"], 0)
        self.assertEqual(results[1]["timing"]["warmupMs"], 0)  # type: ignore[index]

    async def test_switching_between_desktop_and_remote_output_keeps_pocket_loaded(self) -> None:
        tts_loads = 0
        desktop_speech_done = asyncio.Event()
        desktop_outputs: list[_FakeSpeechOutput] = []

        def load_tts(_root: Path) -> _FakeHandle:
            nonlocal tts_loads
            tts_loads += 1
            return _FakeHandle()

        def output(message: dict[str, object]) -> None:
            self.messages.append(message)
            if message.get("type") == "speech-result":
                desktop_speech_done.set()

        def make_desktop_output(sample_rate: int) -> _FakeSpeechOutput:
            desktop_output = _FakeSpeechOutput(sample_rate)
            desktop_outputs.append(desktop_output)
            return desktop_output

        runtime = Runtime(
            self.root,
            pocket_root=self.root,
            tts_factory=load_tts,
            speech_output_factory=make_desktop_output,
            output=output,
        )
        self.runtime = runtime

        with patch("jarvis_voice_runtime.runtime.release_native_memory") as release_memory:
            await runtime.command({"type": "speech-prepare", "requestId": "desktop-prepare"})
            await runtime.command(
                {
                    "type": "synthesis-start",
                    "requestId": "mobile-synthesis",
                    "synthesisId": "mobile-output",
                    "text": "hello from mobile",
                }
            )
            for _ in range(100):
                if any(message.get("type") == "synthesis-result" for message in self.messages):
                    break
                await asyncio.sleep(0.01)

            self.assertEqual(desktop_outputs[0].writes, [])
            await runtime.command({"type": "speech-prepare", "requestId": "desktop-again"})
            await runtime.command(
                {
                    "type": "speech-start",
                    "requestId": "desktop-speech",
                    "speechId": "desktop-output",
                    "text": "hello from desktop",
                }
            )
            await asyncio.wait_for(desktop_speech_done.wait(), timeout=2)

        release_memory.assert_not_called()
        self.assertEqual(tts_loads, 1)
        self.assertEqual(len(desktop_outputs), 2)
        self.assertGreater(len(desktop_outputs[1].writes), 0)

    async def test_empty_native_audio_reports_failure_instead_of_hanging(self) -> None:
        daemon = _FakeDaemon()
        daemon.chunks = []
        runtime = self._runtime_with(_FakeHandle(daemon))
        await runtime.command({"type": "speech-prepare", "requestId": "prepare"})
        await runtime.command(
            {"type": "speech-start", "requestId": "start", "speechId": "speech-1", "text": "hello"}
        )
        await asyncio.wait_for(self.speech_done.wait(), timeout=2)
        result = next(
            message for message in self.messages if message.get("type") == "speech-result"
        )
        self.assertEqual(result["status"], "failure")
        self.assertNotEqual(result.get("status"), "completed")

    async def test_daemon_failure_reports_failure_with_message(self) -> None:
        daemon = _FakeDaemon()
        daemon.fail_message = "Pocket synthesis failed."
        runtime = self._runtime_with(_FakeHandle(daemon))
        await runtime.command({"type": "speech-prepare", "requestId": "prepare"})
        await runtime.command(
            {"type": "speech-start", "requestId": "start", "speechId": "speech-1", "text": "hello"}
        )
        await asyncio.wait_for(self.speech_done.wait(), timeout=2)
        result = next(
            message for message in self.messages if message.get("type") == "speech-result"
        )
        self.assertEqual(result["status"], "failure")

    async def test_cancel_waits_for_native_generation_and_reports_interrupted(self) -> None:
        daemon = _FakeDaemon()
        daemon.release.clear()
        runtime = self._runtime_with(_FakeHandle(daemon))
        await runtime.command({"type": "speech-prepare", "requestId": "prepare"})
        await runtime.command(
            {"type": "speech-start", "requestId": "start", "speechId": "speech-1", "text": "hello"}
        )
        await asyncio.to_thread(daemon.started.wait, 2)
        await runtime.command(
            {"type": "speech-cancel", "requestId": "cancel", "speechId": "speech-1"}
        )
        daemon.release.set()
        await asyncio.wait_for(self.speech_done.wait(), timeout=2)
        results = [message for message in self.messages if message.get("type") == "speech-result"]
        self.assertEqual([result["status"] for result in results], ["interrupted"])
        # Cancellation keeps the daemon warm for the next utterance.
        self.assertTrue(daemon.running)

    async def test_shutdown_closes_the_daemon(self) -> None:
        daemon = _FakeDaemon()
        runtime = self._runtime_with(_FakeHandle(daemon))
        await runtime.command({"type": "speech-prepare", "requestId": "prepare"})
        await runtime.command({"type": "shutdown", "requestId": "bye"})
        self.assertEqual(daemon.close_count, 1)

    async def test_speech_start_failure_does_not_wedge_future_speech(self) -> None:
        runtime = self._runtime_with(_FakeHandle())
        await runtime.command({"type": "speech-prepare", "requestId": "prepare"})
        real_reset = self.audio_output.reset_utterance
        calls = 0

        def flaky_reset() -> None:
            nonlocal calls
            calls += 1
            if calls == 1:
                raise RuntimeError("output not ready")
            real_reset()

        self.audio_output.reset_utterance = flaky_reset  # type: ignore[method-assign]
        await runtime.command(
            {"type": "speech-start", "requestId": "start", "speechId": "speech-1", "text": "hello"}
        )
        failed = next(message for message in self.messages if message.get("requestId") == "start")
        self.assertFalse(failed["ok"])
        # The failed reset must not leave a phantom active speech behind.
        self.assertIsNone(runtime.speech)
        await runtime.command(
            {"type": "speech-start", "requestId": "retry", "speechId": "speech-2", "text": "hello"}
        )
        retried = next(message for message in self.messages if message.get("requestId") == "retry")
        self.assertTrue(retried["ok"])
        await asyncio.wait_for(self.speech_done.wait(), timeout=2)

    async def test_cancel_reports_no_result_until_native_generation_completes(self) -> None:
        daemon = _FakeDaemon()
        daemon.release.clear()
        runtime = self._runtime_with(_FakeHandle(daemon))
        await runtime.command({"type": "speech-prepare", "requestId": "prepare"})
        await runtime.command(
            {"type": "speech-start", "requestId": "start", "speechId": "speech-1", "text": "hello"}
        )
        await asyncio.to_thread(daemon.started.wait, 2)
        await runtime.command(
            {"type": "speech-cancel", "requestId": "cancel", "speechId": "speech-1"}
        )
        self.assertFalse(any(message.get("type") == "speech-result" for message in self.messages))
        daemon.release.set()
        await asyncio.wait_for(self.speech_done.wait(), timeout=2)
        result = next(
            message for message in self.messages if message.get("type") == "speech-result"
        )
        self.assertEqual(result["status"], "interrupted")

    async def test_native_output_failure_cannot_report_completed(self) -> None:
        self.audio_output.failure = OSError("speaker disconnected")
        runtime = self._runtime_with(_FakeHandle())
        await runtime.command({"type": "speech-prepare", "requestId": "prepare"})
        await runtime.command(
            {"type": "speech-start", "requestId": "start", "speechId": "speech-1", "text": "hello"}
        )
        await asyncio.wait_for(self.speech_done.wait(), timeout=2)
        result = next(
            message for message in self.messages if message.get("type") == "speech-result"
        )
        self.assertEqual(result["status"], "failure")
        self.assertEqual(result["code"], "speech-output-failed")
        self.assertNotIn(
            "completed",
            [
                message.get("status")
                for message in self.messages
                if message.get("type") == "speech-result"
            ],
        )

    async def test_capture_supersedes_pocket_warmup_without_overlapping_models(self) -> None:
        started = threading.Event()
        release = threading.Event()
        active_loads = 0
        maximum_active_loads = 0

        def load_tts(_root: Path) -> _FakeHandle:
            nonlocal active_loads, maximum_active_loads
            active_loads += 1
            maximum_active_loads = max(maximum_active_loads, active_loads)
            started.set()
            release.wait(timeout=5)
            active_loads -= 1
            return _FakeHandle()

        def load_recognizer(_root: Path) -> _Recognizer:
            nonlocal active_loads, maximum_active_loads
            active_loads += 1
            maximum_active_loads = max(maximum_active_loads, active_loads)
            active_loads -= 1
            return _Recognizer()

        runtime = Runtime(
            self.root,
            pocket_root=self.root,
            tts_factory=load_tts,
            recognizer_factory=load_recognizer,
            output=self.messages.append,
        )
        self.runtime = runtime
        preparing = asyncio.create_task(
            runtime.command({"type": "speech-prepare", "requestId": "prepare"})
        )
        await asyncio.to_thread(started.wait, 2)
        starting = asyncio.create_task(
            runtime.command(
                {
                    "type": "capture-start",
                    "requestId": "capture",
                    "captureId": "capture-1",
                    "sampleRate": 16_000,
                    "channels": 1,
                    "contextualPhrases": [],
                }
            )
        )
        await asyncio.sleep(0)
        self.assertFalse(starting.done())
        release.set()
        await preparing
        await starting
        self.assertEqual(maximum_active_loads, 1)
        self.assertIsNone(runtime._tts)
        self.assertIsNotNone(runtime._recognizer)
        await runtime.command(
            {"type": "capture-cancel", "requestId": "cancel", "captureId": "capture-1"}
        )
        assert runtime.capture is not None and runtime.capture.cancel_task is not None
        await runtime.capture.cancel_task

    async def test_speech_prepare_rejects_after_capture_start_claim(self) -> None:
        recognizer_started = threading.Event()

        def load_recognizer(_root: Path) -> _Recognizer:
            recognizer_started.set()
            return _Recognizer()

        runtime = Runtime(
            self.root,
            pocket_root=self.root,
            recognizer_factory=load_recognizer,
            output=self.messages.append,
        )
        self.runtime = runtime
        starting = asyncio.create_task(
            runtime.command(
                {
                    "type": "capture-start",
                    "requestId": "capture",
                    "captureId": "capture-1",
                    "sampleRate": 16_000,
                    "channels": 1,
                    "contextualPhrases": [],
                }
            )
        )
        await asyncio.to_thread(recognizer_started.wait, 2)
        await runtime.command({"type": "speech-prepare", "requestId": "prepare"})
        prepare_result = next(
            message for message in self.messages if message.get("requestId") == "prepare"
        )
        self.assertFalse(prepare_result["ok"])
        await starting
        await runtime.command(
            {"type": "capture-cancel", "requestId": "cancel", "captureId": "capture-1"}
        )
        assert runtime.capture is not None and runtime.capture.cancel_task is not None
        await runtime.capture.cancel_task

    async def test_listening_prepare_restores_resident_parakeet_without_an_idle_timer(self) -> None:
        recognizer_loads = 0

        def load_recognizer(_root: Path) -> _Recognizer:
            nonlocal recognizer_loads
            recognizer_loads += 1
            return _Recognizer()

        runtime = Runtime(
            self.root,
            pocket_root=self.root,
            tts_factory=lambda _root: _FakeHandle(),
            recognizer_factory=load_recognizer,
            output=self.messages.append,
        )
        self.runtime = runtime
        await runtime.command({"type": "speech-prepare", "requestId": "prepare"})
        await runtime.command({"type": "listening-prepare", "requestId": "listen"})
        self.assertIsNone(runtime._tts)
        self.assertIsNotNone(runtime._recognizer)
        self.assertEqual(recognizer_loads, 1)

    async def test_model_factories_are_used_exclusively_across_switches(self) -> None:
        tts_loads = 0
        recognizer_loads = 0
        lifecycle: list[str] = []

        def load_tts(_root: Path) -> _FakeHandle:
            nonlocal tts_loads
            tts_loads += 1
            lifecycle.append("load-pocket")
            return _FakeHandle()

        def load_recognizer(_root: Path) -> _Recognizer:
            nonlocal recognizer_loads
            recognizer_loads += 1
            lifecycle.append("load-parakeet")
            return _Recognizer()

        runtime = Runtime(
            self.root,
            pocket_root=self.root,
            tts_factory=load_tts,
            recognizer_factory=load_recognizer,
            output=self.messages.append,
        )
        self.runtime = runtime
        with patch(
            "jarvis_voice_runtime.runtime.release_native_memory",
            side_effect=lambda: lifecycle.append("release-native-memory"),
        ) as release_memory:
            await runtime.command({"type": "speech-prepare", "requestId": "prepare"})
            self.assertEqual((tts_loads, recognizer_loads), (1, 0))
            await runtime.command(
                {
                    "type": "capture-start",
                    "requestId": "capture",
                    "captureId": "capture-1",
                    "sampleRate": 16_000,
                    "channels": 1,
                    "contextualPhrases": [],
                }
            )
            self.assertEqual((tts_loads, recognizer_loads), (1, 1))
            await runtime.command(
                {"type": "capture-cancel", "requestId": "cancel", "captureId": "capture-1"}
            )
            assert runtime.capture is not None and runtime.capture.cancel_task is not None
            await runtime.capture.cancel_task
            await runtime.command({"type": "speech-prepare", "requestId": "prepare-again"})

        self.assertEqual(release_memory.call_count, 2)
        self.assertEqual(
            lifecycle,
            [
                "load-pocket",
                "release-native-memory",
                "load-parakeet",
                "release-native-memory",
                "load-pocket",
            ],
        )
        self.assertEqual((tts_loads, recognizer_loads), (2, 1))

    async def test_pocket_service_keeps_the_pinned_contract(self) -> None:
        service = JarvisPocketTTSService(_FakeHandle())  # type: ignore[arg-type]
        self.assertEqual(service._settings.model, "pocket-2026-04")  # type: ignore[attr-defined]
        self.assertEqual(str(service._text_aggregation_mode), "sentence")  # type: ignore[attr-defined]
        self.assertTrue(service._push_text_frames)  # type: ignore[attr-defined]


if __name__ == "__main__":
    unittest.main()
