from __future__ import annotations

import asyncio
import array
import base64
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import patch
from pathlib import Path

import pipecat.utils.string as pipecat_string
from pipecat.frames.frames import OutputAudioRawFrame, StartFrame, TTSAudioRawFrame
from pipecat.transports.base_output import BaseOutputTransport
from pipecat.transports.base_transport import TransportParams

from jarvis_voice_runtime.kokoro import KokoroTTSService, create_tts
from jarvis_voice_runtime.runtime import Runtime


def _int16_audio(samples: list[float]) -> bytes:
    return array.array(
        "h",
        (round(sample * (32_768 if sample < 0 else 32_767)) for sample in samples),
    ).tobytes()


class _Generated:
    sample_rate = 24_000
    samples = [0.1, -0.1, 0.0, 0.2]


class _FakeTts:
    sample_rate = 24_000

    def generate(self, _text: str, _config: object, callback: object = None) -> _Generated:
        if callback is not None:
            callback(_Generated.samples, 1.0)
        return _Generated()


class _BlockingTts(_FakeTts):
    def __init__(self) -> None:
        self.started = threading.Event()
        self.finish = threading.Event()

    def generate(self, _text: str, _config: object, callback: object = None) -> _Generated:
        self.started.set()
        self.finish.wait(timeout=5)
        return super().generate(_text, _config, callback)


class _StreamingBlockingTts(_FakeTts):
    def __init__(self) -> None:
        self.started = threading.Event()
        self.finish = threading.Event()

    def generate(self, _text: str, _config: object, callback: object = None) -> _Generated:
        if callback is not None:
            callback(_Generated.samples, 0.25)
        self.started.set()
        self.finish.wait(timeout=5)
        return _Generated()


class _SherpaFaithfulTts(_FakeTts):
    def __init__(self) -> None:
        self.callback_returns: list[int] = []

    def generate(self, _text: str, _config: object, callback: object = None) -> _Generated:
        if callback is not None:
            processed_samples: list[float] = []
            chunks = (_Generated.samples[:2], _Generated.samples[2:])
            for index, chunk in enumerate(chunks):
                processed_samples.extend(chunk)
                result = callback(chunk, (index + 1) / len(chunks))
                self.callback_returns.append(result)
                if result == 0:
                    break
            generated = _Generated()
            generated.samples = processed_samples
            return generated
        return _Generated()


class _PartialCallbackTts(_FakeTts):
    def generate(self, _text: str, _config: object, callback: object = None) -> _Generated:
        if callback is not None:
            callback(_Generated.samples[:2], 0.5)
        return _Generated()


class _MismatchedCallbackTts(_FakeTts):
    def generate(self, _text: str, _config: object, callback: object = None) -> _Generated:
        if callback is not None:
            callback(_Generated.samples[:2], 0.5)
        generated = _Generated()
        generated.samples = _Generated.samples[1:]
        return generated


class _PartialStreamingBlockingTts(_FakeTts):
    def __init__(self) -> None:
        self.started = threading.Event()
        self.finish = threading.Event()

    def generate(self, _text: str, _config: object, callback: object = None) -> _Generated:
        if callback is not None:
            callback(_Generated.samples[:2], 0.5)
        self.started.set()
        self.finish.wait(timeout=5)
        return _Generated()


class _CallbackAwareCancellationTts(_FakeTts):
    def __init__(self) -> None:
        self.waiting = threading.Event()
        self.release = threading.Event()
        self.callback_returns: list[int] = []

    def generate(self, _text: str, _config: object, callback: object = None) -> _Generated:
        if callback is not None:
            self.callback_returns.append(callback(_Generated.samples[:2], 0.5))
            self.waiting.set()
            self.release.wait(timeout=5)
            self.callback_returns.append(callback(_Generated.samples[2:], 1.0))
        return _Generated()


class _EmptyTts(_FakeTts):
    def generate(self, _text: str, _config: object, callback: object = None) -> _Generated:
        if callback is not None:
            callback([], 1.0)
        generated = _Generated()
        generated.samples = []
        return generated


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


class _BlockingAbortSpeechOutput(_FakeSpeechOutput):
    def __init__(self, sample_rate: int) -> None:
        super().__init__(sample_rate)
        self.abort_started = asyncio.Event()
        self.abort_allowed = asyncio.Event()

    async def abort_utterance(self) -> None:
        self.abort_started.set()
        await self.abort_allowed.wait()
        await super().abort_utterance()


class TtsRuntimeTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.messages: list[dict[str, object]] = []
        self.runtime: Runtime | None = None
        self.speech_done = asyncio.Event()
        self.audio_output = _FakeSpeechOutput(24_000)

    async def asyncTearDown(self) -> None:
        if self.runtime is not None:
            await self.runtime.command({"type": "shutdown", "requestId": "teardown"})
        self.directory.cleanup()

    def _runtime_with(self, tts: object) -> Runtime:
        runtime: Runtime

        def output(message: dict[str, object]) -> None:
            self.messages.append(message)
            if message.get("type") == "speech-result":
                self.speech_done.set()

        runtime = Runtime(
            self.root,
            kokoro_root=self.root,
            tts_factory=lambda _root: tts,  # type: ignore[arg-type]
            speech_output_factory=lambda _sample_rate: self.audio_output,
            output=output,
        )
        self.runtime = runtime
        return runtime

    async def test_speech_completes_only_after_pipecat_native_playout(self) -> None:
        self.audio_output.write_allowed.clear()
        runtime = self._runtime_with(_FakeTts())
        await runtime.command({"type": "speech-prepare", "requestId": "prepare"})
        await runtime.command(
            {"type": "speech-start", "requestId": "start", "speechId": "speech-1", "text": "hello"}
        )
        await asyncio.wait_for(self.audio_output.write_started.wait(), timeout=2)
        self.assertFalse(any(message.get("type") == "speech-result" for message in self.messages))
        self.audio_output.write_allowed.set()
        await asyncio.wait_for(self.speech_done.wait(), timeout=2)
        result = next(message for message in self.messages if message.get("type") == "speech-result")
        self.assertEqual(result["status"], "completed")
        self.assertEqual(self.audio_output.sample_rate, 24_000)
        self.assertTrue(self.audio_output.closed)

    async def test_second_speech_reuses_the_resident_kokoro_pipeline(self) -> None:
        tts_loads = 0

        def load_tts(_root: Path) -> _FakeTts:
            nonlocal tts_loads
            tts_loads += 1
            return _FakeTts()

        def output(message: dict[str, object]) -> None:
            self.messages.append(message)
            if message.get("type") == "speech-result":
                self.speech_done.set()

        runtime = Runtime(
            self.root,
            kokoro_root=self.root,
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

    async def test_remote_synthesis_returns_complete_ordered_pcm(self) -> None:
        runtime = self._runtime_with(_FakeTts())
        await runtime.command(
            {
                "type": "synthesis-start",
                "requestId": "synthesize",
                "synthesisId": "mobile-1",
                "text": "hello",
            }
        )
        for _ in range(100):
            if any(message.get("type") == "synthesis-result" for message in self.messages):
                break
            await asyncio.sleep(0.01)
        chunks = [
            message
            for message in self.messages
            if message.get("type") == "synthesis-audio"
        ]
        result = next(
            message for message in self.messages if message.get("type") == "synthesis-result"
        )
        pcm = b"".join(base64.b64decode(str(chunk["data"])) for chunk in chunks)
        self.assertEqual([chunk["sequence"] for chunk in chunks], list(range(len(chunks))))
        self.assertTrue(pcm.startswith(_int16_audio(_Generated.samples)))
        self.assertEqual(len(pcm), result["audioBytes"])
        self.assertEqual(result["ok"], True)
        self.assertEqual(result["sampleRate"], 24_000)
        self.assertEqual(result["audioBytes"], len(pcm))

    async def test_switching_between_desktop_and_remote_output_keeps_kokoro_loaded(self) -> None:
        tts_loads = 0
        desktop_speech_done = asyncio.Event()
        desktop_outputs: list[_FakeSpeechOutput] = []

        def load_tts(_root: Path) -> _FakeTts:
            nonlocal tts_loads
            tts_loads += 1
            return _FakeTts()

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
            kokoro_root=self.root,
            tts_factory=load_tts,
            speech_output_factory=make_desktop_output,
            output=output,
        )
        self.runtime = runtime

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

        self.assertEqual(tts_loads, 1)
        self.assertEqual(len(desktop_outputs), 2)
        self.assertGreater(len(desktop_outputs[1].writes), 0)

    async def test_multi_sentence_speech_does_not_fail_when_sentence_tokenizer_is_unavailable(
        self,
    ) -> None:
        """Finalized speech must not enter Pipecat's optional streaming tokenizer."""
        messages: list[dict[str, object]] = []
        speech_done = asyncio.Event()
        def output(message: dict[str, object]) -> None:
            messages.append(message)
            if message.get("type") == "speech-result":
                speech_done.set()

        runtime = Runtime(
            self.root,
            kokoro_root=self.root,
            tts_factory=lambda _root: _FakeTts(),
            speech_output_factory=lambda _sample_rate: self.audio_output,
            output=output,
        )
        self.runtime = runtime
        await runtime.command({"type": "speech-prepare", "requestId": "prepare"})

        original_sentence_tokenizer = pipecat_string.sent_tokenize

        def missing_nltk(_text: str) -> list[str]:
            raise ModuleNotFoundError("No module named 'nltk'")

        pipecat_string.sent_tokenize = missing_nltk
        try:
            await runtime.command(
                {
                    "type": "speech-start",
                    "requestId": "start",
                    "speechId": "speech-multi-sentence",
                    "text": "Hello, hello, hello! What are we working on today?",
                }
            )
            await asyncio.wait_for(speech_done.wait(), timeout=2)
        finally:
            pipecat_string.sent_tokenize = original_sentence_tokenizer

        result = next(message for message in messages if message.get("type") == "speech-result")
        self.assertEqual(result["status"], "completed")
        self.assertFalse(any(message.get("type") == "speech-audio" for message in messages))
        self.assertGreater(len(self.audio_output.writes), 0)

    async def test_listening_prepare_releases_kokoro_and_restores_parakeet(self) -> None:
        recognizer = _Recognizer()
        runtime = Runtime(
            self.root,
            kokoro_root=self.root,
            recognizer_factory=lambda _root: recognizer,
            tts_factory=lambda _root: _FakeTts(),
            output=self.messages.append,
        )
        self.runtime = runtime
        await runtime.command({"type": "speech-prepare", "requestId": "prepare"})
        self.assertIsNotNone(runtime._tts)  # type: ignore[attr-defined]

        await runtime.command({"type": "listening-prepare", "requestId": "listen"})

        self.assertIsNone(runtime._tts)  # type: ignore[attr-defined]
        self.assertIs(runtime._recognizer, recognizer)  # type: ignore[attr-defined]

    async def test_streams_first_audio_before_native_generation_returns(self) -> None:
        tts = _StreamingBlockingTts()
        service = KokoroTTSService(tts)
        frames = service.run_tts("hello", "context")
        first = asyncio.create_task(frames.__anext__())
        await asyncio.to_thread(tts.started.wait, 2)
        first_frame = await asyncio.wait_for(first, timeout=2)
        self.assertIsInstance(first_frame, TTSAudioRawFrame)
        self.assertFalse(tts.finish.is_set())
        tts.finish.set()
        remaining = [frame async for frame in frames]
        self.assertEqual(remaining, [])

    async def test_sherpa_callback_must_continue_and_final_audio_is_not_duplicated(self) -> None:
        tts = _SherpaFaithfulTts()
        service = KokoroTTSService(tts)
        frames = [frame async for frame in service.run_tts("hello", "context")]

        self.assertEqual(tts.callback_returns, [1, 1])
        self.assertEqual(b"".join(frame.audio for frame in frames), _int16_audio(_Generated.samples))
        self.assertEqual(service.last_metrics.chunk_count, 2)
        self.assertEqual(service.last_metrics.total_samples, len(_Generated.samples))

    async def test_sherpa_callback_prefix_mismatch_raises_contract_error(self) -> None:
        service = KokoroTTSService(_MismatchedCallbackTts())

        with self.assertRaisesRegex(RuntimeError, "Sherpa Kokoro callback PCM is not a prefix"):
            [frame async for frame in service.run_tts("hello", "context")]

    async def test_partial_callback_streams_before_return_and_reconciles_tail_after_return(self) -> None:
        tts = _PartialStreamingBlockingTts()
        service = KokoroTTSService(tts)
        frames = service.run_tts("hello", "context")
        first = asyncio.create_task(frames.__anext__())
        await asyncio.to_thread(tts.started.wait, 2)
        first_frame = await asyncio.wait_for(first, timeout=2)
        self.assertEqual(first_frame.audio, _int16_audio(_Generated.samples[:2]))

        tail = asyncio.create_task(frames.__anext__())
        await asyncio.sleep(0)
        self.assertFalse(tail.done())
        tts.finish.set()
        tail_frame = await asyncio.wait_for(tail, timeout=2)
        self.assertEqual(tail_frame.audio, _int16_audio(_Generated.samples[2:]))
        self.assertEqual([frame async for frame in frames], [])

    async def test_cancellation_returns_zero_to_sherpa_and_skips_completion_tail(self) -> None:
        tts = _CallbackAwareCancellationTts()
        service = KokoroTTSService(tts)
        frames = service.run_tts("hello", "context")
        first = await frames.__anext__()
        self.assertEqual(first.audio, _int16_audio(_Generated.samples[:2]))
        await asyncio.to_thread(tts.waiting.wait, 2)

        cancelling = asyncio.create_task(service.cancel_generation())
        await asyncio.sleep(0)
        tts.release.set()
        await asyncio.wait_for(cancelling, timeout=2)
        self.assertEqual(tts.callback_returns, [1, 0])
        self.assertEqual([frame async for frame in frames], [])

    async def test_emits_the_complete_generated_utterance_after_a_partial_callback(self) -> None:
        service = KokoroTTSService(_PartialCallbackTts())
        frames = [frame async for frame in service.run_tts("hello", "context")]

        self.assertEqual(len(frames), 2)
        self.assertEqual(sum(len(frame.audio) for frame in frames), len(_Generated.samples) * 2)
        self.assertEqual(frames[0].audio + frames[1].audio, _int16_audio(_Generated.samples))

    async def test_empty_native_audio_is_a_synthesis_failure(self) -> None:
        service = KokoroTTSService(_EmptyTts())
        with self.assertRaisesRegex(RuntimeError, "Kokoro produced no audio"):
            [frame async for frame in service.run_tts("hello", "context")]

    async def test_empty_native_audio_reports_failure_instead_of_hanging(self) -> None:
        runtime = self._runtime_with(_EmptyTts())
        await runtime.command({"type": "speech-prepare", "requestId": "prepare"})
        await runtime.command(
            {"type": "speech-start", "requestId": "start", "speechId": "speech-1", "text": "hello"}
        )
        await asyncio.wait_for(self.speech_done.wait(), timeout=2)
        result = next(message for message in self.messages if message.get("type") == "speech-result")
        self.assertEqual(result["status"], "failure")
        self.assertNotEqual(result.get("status"), "completed")

    async def test_user_cancellation_wins_over_a_racing_pipeline_error(self) -> None:
        blocking_output = _BlockingAbortSpeechOutput(24_000)
        self.audio_output = blocking_output
        runtime = self._runtime_with(_EmptyTts())
        await runtime.command({"type": "speech-prepare", "requestId": "prepare"})
        await runtime.command(
            {"type": "speech-start", "requestId": "start", "speechId": "speech-1", "text": "hello"}
        )
        await asyncio.wait_for(blocking_output.abort_started.wait(), timeout=2)
        await runtime.command(
            {"type": "speech-cancel", "requestId": "cancel", "speechId": "speech-1"}
        )
        blocking_output.abort_allowed.set()
        await asyncio.wait_for(self.speech_done.wait(), timeout=2)
        results = [message for message in self.messages if message.get("type") == "speech-result"]
        self.assertEqual([result["status"] for result in results], ["interrupted"])

    async def test_cancel_waits_for_native_generation_and_reports_interrupted(self) -> None:
        tts = _BlockingTts()
        runtime = self._runtime_with(tts)
        await runtime.command({"type": "speech-prepare", "requestId": "prepare"})
        await runtime.command(
            {"type": "speech-start", "requestId": "start", "speechId": "speech-1", "text": "hello"}
        )
        await asyncio.to_thread(tts.started.wait, 2)
        await runtime.command(
            {"type": "speech-cancel", "requestId": "cancel", "speechId": "speech-1"}
        )
        self.assertFalse(any(message.get("type") == "speech-result" for message in self.messages))
        tts.finish.set()
        await asyncio.wait_for(self.speech_done.wait(), timeout=2)
        result = next(message for message in self.messages if message.get("type") == "speech-result")
        self.assertEqual(result["status"], "interrupted")

    async def test_native_output_failure_cannot_report_completed(self) -> None:
        self.audio_output.failure = OSError("speaker disconnected")
        runtime = self._runtime_with(_FakeTts())
        await runtime.command({"type": "speech-prepare", "requestId": "prepare"})
        await runtime.command(
            {"type": "speech-start", "requestId": "start", "speechId": "speech-1", "text": "hello"}
        )
        await asyncio.wait_for(self.speech_done.wait(), timeout=2)
        result = next(message for message in self.messages if message.get("type") == "speech-result")
        self.assertEqual(result["status"], "failure")
        self.assertEqual(result["code"], "speech-output-failed")
        self.assertNotIn(
            "completed",
            [message.get("status") for message in self.messages if message.get("type") == "speech-result"],
        )

    async def test_capture_supersedes_kokoro_warmup_without_overlapping_models(self) -> None:
        started = threading.Event()
        release = threading.Event()
        active_loads = 0
        maximum_active_loads = 0

        def load_tts(_root: Path) -> _FakeTts:
            nonlocal active_loads, maximum_active_loads
            active_loads += 1
            maximum_active_loads = max(maximum_active_loads, active_loads)
            started.set()
            release.wait(timeout=5)
            active_loads -= 1
            return _FakeTts()

        def load_recognizer(_root: Path) -> _Recognizer:
            nonlocal active_loads, maximum_active_loads
            active_loads += 1
            maximum_active_loads = max(maximum_active_loads, active_loads)
            active_loads -= 1
            return _Recognizer()

        runtime = Runtime(
            self.root,
            kokoro_root=self.root,
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
            kokoro_root=self.root,
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
        prepare_result = next(message for message in self.messages if message.get("requestId") == "prepare")
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
            kokoro_root=self.root,
            tts_factory=lambda _root: _FakeTts(),
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

        def load_tts(_root: Path) -> _FakeTts:
            nonlocal tts_loads
            tts_loads += 1
            return _FakeTts()

        def load_recognizer(_root: Path) -> _Recognizer:
            nonlocal recognizer_loads
            recognizer_loads += 1
            return _Recognizer()

        runtime = Runtime(
            self.root,
            kokoro_root=self.root,
            tts_factory=load_tts,
            recognizer_factory=load_recognizer,
            output=self.messages.append,
        )
        self.runtime = runtime
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
        self.assertEqual((tts_loads, recognizer_loads), (2, 1))

    async def test_kokoro_configuration_keeps_the_bundled_settings(self) -> None:
        for name in (
            "model.int8.onnx",
            "voices.bin",
            "tokens.txt",
            "lexicon-us-en.txt",
        ):
            (self.root / name).write_bytes(b"resource")
        (self.root / "espeak-ng-data").mkdir()
        model_kwargs: dict[str, object] = {}
        model_config_kwargs: dict[str, object] = {}
        tts_config_kwargs: dict[str, object] = {}

        class ModelConfig:
            def __init__(self, **kwargs: object) -> None:
                model_kwargs.update(kwargs)

        class TtsModelConfig:
            def __init__(self, **kwargs: object) -> None:
                model_config_kwargs.update(kwargs)

        class TtsConfig:
            def __init__(self, **kwargs: object) -> None:
                tts_config_kwargs.update(kwargs)

            def validate(self) -> bool:
                return True

        fake_sherpa = types.SimpleNamespace(
            OfflineTtsKokoroModelConfig=ModelConfig,
            OfflineTtsModelConfig=TtsModelConfig,
            OfflineTtsConfig=TtsConfig,
            OfflineTts=lambda _config: _FakeTts(),
        )
        with patch.dict(sys.modules, {"sherpa_onnx": fake_sherpa}):
            create_tts(self.root)
        self.assertEqual(model_kwargs["model"], str(self.root / "model.int8.onnx"))
        self.assertEqual(model_kwargs["voices"], str(self.root / "voices.bin"))
        self.assertEqual(model_kwargs["tokens"], str(self.root / "tokens.txt"))
        self.assertEqual(model_kwargs["lexicon"], str(self.root / "lexicon-us-en.txt"))
        self.assertEqual(model_kwargs["data_dir"], str(self.root / "espeak-ng-data"))
        self.assertEqual(model_config_kwargs["num_threads"], 2)
        self.assertEqual(model_config_kwargs["provider"], "cpu")
        self.assertEqual(model_config_kwargs["debug"], False)
        self.assertEqual(tts_config_kwargs["max_num_sentences"], 1)
        self.assertEqual(tts_config_kwargs["silence_scale"], 0.42)

        generation_kwargs: dict[str, object] = {}

        class GenerationConfig:
            sid = 0
            speed = 0.0
            silence_scale = 0.0

        fake_sherpa.GenerationConfig = GenerationConfig

        class ConfigCaptureTts(_FakeTts):
            def generate(self, text: str, config: object, callback: object = None) -> _Generated:
                del text, callback
                generation_kwargs.update(
                    {
                        "sid": config.sid,
                        "speed": config.speed,
                        "silence_scale": config.silence_scale,
                    }
                )
                return _Generated()

        service = KokoroTTSService(ConfigCaptureTts())
        [frame async for frame in service.run_tts("hello", "context")]
        self.assertEqual(generation_kwargs, {"sid": 0, "speed": 0.97, "silence_scale": 0.42})
        self.assertEqual(str(service._text_aggregation_mode), "sentence")
        self.assertTrue(service._push_text_frames)


if __name__ == "__main__":
    unittest.main()
