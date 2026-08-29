from __future__ import annotations

import asyncio
import array
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import patch
from pathlib import Path

import pipecat.utils.string as pipecat_string
from pipecat.frames.frames import TTSAudioRawFrame

from jarvis_voice_runtime.output import DesktopPcmOutputTransport
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


class TtsRuntimeTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.messages: list[dict[str, object]] = []
        self.runtime: Runtime | None = None
        self.audio_end = asyncio.Event()
        self.speech_done = asyncio.Event()
        self.audio_started = asyncio.Event()

    async def asyncTearDown(self) -> None:
        if self.runtime is not None:
            await self.runtime.command({"type": "shutdown", "requestId": "teardown"})
        self.directory.cleanup()

    def _runtime_with(self, tts: object) -> Runtime:
        runtime: Runtime

        def output(message: dict[str, object]) -> None:
            self.messages.append(message)
            if message.get("type") == "speech-audio":
                self.audio_started.set()
                asyncio.create_task(
                    runtime.command(
                        {
                            "type": "speech-audio-consumed",
                            "requestId": "audio-ack",
                            "speechId": message["speechId"],
                            "sequence": message["sequence"],
                        }
                    )
                )
            elif message.get("type") == "speech-audio-end":
                self.audio_end.set()
            elif message.get("type") == "speech-result":
                self.speech_done.set()

        runtime = Runtime(
            self.root,
            kokoro_root=self.root,
            tts_factory=lambda _root: tts,  # type: ignore[arg-type]
            output=output,
        )
        self.runtime = runtime
        return runtime

    async def test_speech_waits_for_desktop_playout_drain(self) -> None:
        runtime = self._runtime_with(_FakeTts())
        await runtime.command({"type": "speech-prepare", "requestId": "prepare"})
        await runtime.command(
            {"type": "speech-start", "requestId": "start", "speechId": "speech-1", "text": "hello"}
        )
        await asyncio.wait_for(self.audio_end.wait(), timeout=2)
        self.assertFalse(any(message.get("type") == "speech-result" for message in self.messages))
        await runtime.command(
            {
                "type": "speech-playout-drained",
                "requestId": "drain",
                "speechId": "speech-1",
            }
        )
        await asyncio.wait_for(self.speech_done.wait(), timeout=2)
        result = next(message for message in self.messages if message.get("type") == "speech-result")
        self.assertEqual(result["status"], "completed")

    async def test_multi_sentence_speech_does_not_fail_when_sentence_tokenizer_is_unavailable(
        self,
    ) -> None:
        """Finalized speech must not enter Pipecat's optional streaming tokenizer."""
        messages: list[dict[str, object]] = []
        speech_done = asyncio.Event()
        runtime: Runtime

        def output(message: dict[str, object]) -> None:
            messages.append(message)
            if message.get("type") == "speech-audio":
                asyncio.create_task(
                    runtime.command(
                        {
                            "type": "speech-audio-consumed",
                            "requestId": "audio-ack",
                            "speechId": message["speechId"],
                            "sequence": message["sequence"],
                        }
                    )
                )
            elif message.get("type") == "speech-audio-end":
                asyncio.create_task(
                    runtime.command(
                        {
                            "type": "speech-playout-drained",
                            "requestId": "drain-ack",
                            "speechId": message["speechId"],
                        }
                    )
                )
            elif message.get("type") == "speech-result":
                speech_done.set()

        runtime = Runtime(
            self.root,
            kokoro_root=self.root,
            tts_factory=lambda _root: _FakeTts(),
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
        self.assertTrue(any(message.get("type") == "speech-audio" for message in messages))

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

    async def test_empty_native_audio_yields_no_empty_frame(self) -> None:
        service = KokoroTTSService(_EmptyTts())
        frames = [frame async for frame in service.run_tts("hello", "context")]
        self.assertEqual(frames, [])

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

    async def test_stale_audio_ack_is_rejected(self) -> None:
        runtime = self._runtime_with(_FakeTts())
        await runtime.command({"type": "speech-prepare", "requestId": "prepare"})
        await runtime.command(
            {"type": "speech-start", "requestId": "start", "speechId": "speech-1", "text": "hello"}
        )
        await asyncio.wait_for(self.audio_started.wait(), timeout=2)
        await runtime.command(
            {
                "type": "speech-audio-consumed",
                "requestId": "stale",
                "speechId": "speech-1",
                "sequence": 99,
            }
        )
        failure = next(message for message in self.messages if message.get("requestId") == "stale")
        self.assertFalse(failure["ok"])
        await runtime.command({"type": "speech-cancel", "requestId": "cancel", "speechId": "speech-1"})

    async def test_large_audio_frame_is_fragmented_at_the_protocol_limit(self) -> None:
        chunks: list[tuple[int, bytes]] = []

        async def emit_audio(audio: bytes, _sample_rate: int, _channels: int, sequence: int) -> None:
            chunks.append((sequence, audio))

        async def no_op() -> None:
            return

        transport = DesktopPcmOutputTransport(
            emit_audio=emit_audio,
            emit_audio_end=no_op,
            wait_for_drain=no_op,
        )
        await transport._handle_frame(
            TTSAudioRawFrame(audio=b"\x01\x00" * 30_001, sample_rate=24_000, num_channels=1)
        )
        self.assertEqual([sequence for sequence, _audio in chunks], [0, 1])
        self.assertEqual(sum(len(audio) for _sequence, audio in chunks), 60_002)
        self.assertTrue(all(0 < len(audio) <= 45_000 and len(audio) % 2 == 0 for _sequence, audio in chunks))

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
