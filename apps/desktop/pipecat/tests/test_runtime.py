from __future__ import annotations

import asyncio
import base64
import io
import tempfile
import threading
import unittest
from array import array
from pathlib import Path

from jarvis_voice_runtime.runtime import MAX_LINE_BYTES, Runtime, read_bounded_line


class _Stream:
    def __init__(self, text: str = "check out Zivil") -> None:
        self.result = type("Result", (), {"text": text})()
        self.samples: list[float] = []

    def accept_waveform(self, sample_rate: int, samples: object) -> None:
        assert sample_rate == 16_000
        self.samples = list(samples)  # type: ignore[arg-type]


class _Recognizer:
    def __init__(self, text: str = "check out Zivil") -> None:
        self.stream = _Stream(text)
        self.decode_count = 0

    def create_stream(self, hotwords: str = "") -> _Stream:
        return self.stream

    def decode_stream(self, stream: _Stream) -> None:
        assert stream is self.stream
        self.decode_count += 1


class _BlockingRecognizer(_Recognizer):
    def __init__(self) -> None:
        super().__init__("late transcript")
        self.decode_started = threading.Event()
        self.finish_decode = threading.Event()

    def decode_stream(self, stream: _Stream) -> None:
        self.decode_started.set()
        self.finish_decode.wait(timeout=5)
        super().decode_stream(stream)


class RuntimeTest(unittest.IsolatedAsyncioTestCase):
    def test_input_line_reader_exposes_oversized_records_without_unbounded_reading(self) -> None:
        line = read_bounded_line(io.BytesIO(b"x" * (MAX_LINE_BYTES + 100)))
        self.assertEqual(len(line), MAX_LINE_BYTES + 1)

    async def asyncSetUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.model_root = Path(self.directory.name)
        (self.model_root / "tokens.txt").write_text("▁ 1\nZi 2\nvil 3\n", encoding="utf-8")
        self.messages: list[dict[str, object]] = []
        self._runtime: Runtime | None = None

    async def asyncTearDown(self) -> None:
        if self._runtime is not None and self._runtime.capture is not None:
            await self._runtime.command(
                {
                    "type": "capture-cancel",
                    "requestId": "teardown",
                    "captureId": self._runtime.capture.capture_id,
                }
            )
            if self._runtime.capture is not None:
                assert self._runtime.capture.cancel_task is not None
                await self._runtime.capture.cancel_task
        self.directory.cleanup()

    async def _start(
        self,
        runtime: Runtime,
        *,
        capture_id: str = "capture-1",
        sample_rate: int = 16_000,
        channels: int = 1,
    ) -> None:
        self._runtime = runtime
        await runtime.command(
            {
                "type": "capture-start",
                "requestId": "1",
                "captureId": capture_id,
                "sampleRate": sample_rate,
                "channels": channels,
                "contextualPhrases": [],
            }
        )

    async def _pcm(
        self,
        runtime: Runtime,
        data: bytes,
        *,
        sample_rate: int = 16_000,
        channels: int = 1,
    ) -> None:
        assert runtime.capture is not None
        await runtime.command(
            {
                "type": "pcm",
                "requestId": "2",
                "captureId": runtime.capture.capture_id,
                "sequence": runtime.capture.expected_sequence,
                "sampleRate": sample_rate,
                "channels": channels,
                "data": base64.b64encode(data).decode(),
            }
        )

    async def test_release_emits_raw_transcript_and_timing(self) -> None:
        recognizer = _Recognizer()
        runtime = Runtime(self.model_root, recognizer=recognizer, output=self.messages.append)
        await self._start(runtime)
        await self._pcm(runtime, array("h", [0, 16_384, -16_384]).tobytes())
        await runtime.command(
            {"type": "capture-release", "requestId": "3", "captureId": "capture-1"}
        )
        assert runtime.capture is not None and runtime.capture.release_task is not None
        await runtime.capture.release_task

        transcript = next(message for message in self.messages if message["type"] == "transcript")
        self.assertEqual(transcript["text"], "check out Zivil")
        timing = next(message for message in self.messages if message["type"] == "stt-timing")
        self.assertNotIn("text", timing["timing"])  # type: ignore[operator]
        self.assertEqual(timing["timing"]["start"], "cold")  # type: ignore[index]
        self.assertGreaterEqual(timing["timing"]["pipelineReadyMs"], 0)  # type: ignore[index]
        self.assertGreaterEqual(timing["timing"]["resampleMs"], 0)  # type: ignore[index]
        self.assertEqual(recognizer.decode_count, 1)

    async def test_reuses_one_recognizer_with_a_fresh_worker_for_each_capture(self) -> None:
        recognizer = _Recognizer()
        runtime = Runtime(self.model_root, recognizer=recognizer, output=self.messages.append)
        workers: list[object] = []
        for index in range(2):
            capture_id = f"capture-{index}"
            await self._start(runtime, capture_id=capture_id)
            assert runtime.capture is not None
            workers.append(runtime.capture.worker)
            await self._pcm(runtime, b"\x00\x00")
            await runtime.command(
                {"type": "capture-release", "requestId": f"release-{index}", "captureId": capture_id}
            )
            assert runtime.capture is not None and runtime.capture.release_task is not None
            await runtime.capture.release_task

        self.assertIsNot(workers[0], workers[1])
        self.assertEqual(recognizer.decode_count, 2)
        timings = [message["timing"] for message in self.messages if message["type"] == "stt-timing"]
        self.assertEqual([timing["start"] for timing in timings], ["cold", "warm"])

    async def test_empty_segment_fails_without_a_transcript(self) -> None:
        runtime = Runtime(
            self.model_root,
            recognizer=_Recognizer(""),
            output=self.messages.append,
        )
        await self._start(runtime)
        await runtime.command(
            {"type": "capture-release", "requestId": "release", "captureId": "capture-1"}
        )
        assert runtime.capture is not None and runtime.capture.release_task is not None
        await runtime.capture.release_task

        self.assertFalse(any(message["type"] == "transcript" for message in self.messages))
        result = next(message for message in self.messages if message["type"] == "capture-result")
        self.assertEqual(result["ok"], False)
        self.assertEqual(result["code"], "transcription-failed")

    async def test_cancel_while_capturing_stops_the_worker_without_decoding(self) -> None:
        recognizer = _Recognizer()
        runtime = Runtime(self.model_root, recognizer=recognizer, output=self.messages.append)
        await self._start(runtime)
        await runtime.command(
            {"type": "capture-cancel", "requestId": "cancel", "captureId": "capture-1"}
        )
        assert runtime.capture is not None and runtime.capture.cancel_task is not None
        await runtime.capture.cancel_task

        self.assertIsNone(runtime.capture)
        self.assertEqual(recognizer.decode_count, 0)
        result = next(message for message in self.messages if message["type"] == "capture-result")
        self.assertEqual(result["code"], "cancelled")

    async def test_shutdown_drains_and_cancels_the_active_worker(self) -> None:
        runtime = Runtime(self.model_root, recognizer=_Recognizer(), output=self.messages.append)
        await self._start(runtime)
        should_stop = await runtime.command({"type": "shutdown", "requestId": "shutdown"})

        self.assertTrue(should_stop)
        self.assertIsNone(runtime.capture)
        self.assertIn(
            {"type": "result", "requestId": "shutdown", "ok": True},
            self.messages,
        )

    async def test_pcm_is_queued_immediately_and_downmixed_per_chunk(self) -> None:
        recognizer = _Recognizer()
        runtime = Runtime(self.model_root, recognizer=recognizer, output=self.messages.append)
        await self._start(runtime, sample_rate=48_000, channels=2)
        await self._pcm(
            runtime,
            array("h", [10_000, -2_000] * 480).tobytes(),
            sample_rate=48_000,
            channels=2,
        )
        assert runtime.capture is not None
        self.assertEqual(runtime.capture.input_audio_bytes, 1_920)
        await runtime.command(
            {"type": "capture-release", "requestId": "3", "captureId": "capture-1"}
        )
        assert runtime.capture is not None and runtime.capture.release_task is not None
        await runtime.capture.release_task
        self.assertTrue(recognizer.stream.samples)

    async def test_cancelled_decode_drains_before_the_capture_is_removed(self) -> None:
        recognizer = _BlockingRecognizer()
        runtime = Runtime(self.model_root, recognizer=recognizer, output=self.messages.append)
        await self._start(runtime)
        await self._pcm(runtime, b"\x00\x00")
        await runtime.command(
            {"type": "capture-release", "requestId": "3", "captureId": "capture-1"}
        )
        await asyncio.to_thread(recognizer.decode_started.wait, 5)

        await asyncio.wait_for(
            runtime.command(
                {"type": "capture-cancel", "requestId": "4", "captureId": "capture-1"}
            ),
            timeout=0.1,
        )
        self.assertIn(
            {"type": "result", "requestId": "4", "ok": True},
            self.messages,
        )
        self.assertIsNotNone(runtime.capture)
        assert runtime.capture is not None and runtime.capture.cancel_task is not None
        cancel_task = runtime.capture.cancel_task
        recognizer.finish_decode.set()
        await cancel_task

        self.assertIsNone(runtime.capture)
        self.assertFalse(any(message["type"] == "transcript" for message in self.messages))
        results = [message for message in self.messages if message["type"] == "capture-result"]
        self.assertEqual(
            results,
            [
                {
                    "type": "capture-result",
                    "captureId": "capture-1",
                    "ok": False,
                    "message": "Voice capture was cancelled.",
                    "code": "cancelled",
                }
            ],
        )

    async def test_rejects_a_second_or_stale_capture(self) -> None:
        runtime = Runtime(self.model_root, recognizer=_Recognizer(), output=self.messages.append)
        await self._start(runtime)
        await runtime.command(
            {
                "type": "capture-start",
                "requestId": "2",
                "captureId": "capture-2",
                "sampleRate": 16_000,
                "channels": 1,
                "contextualPhrases": [],
            }
        )
        await runtime.command(
            {"type": "capture-release", "requestId": "3", "captureId": "capture-2"}
        )
        failures = [message for message in self.messages if message.get("ok") is False]
        self.assertEqual(len(failures), 2)


if __name__ == "__main__":
    unittest.main()
