from __future__ import annotations

import asyncio
import queue
import threading
import time
from array import array
from collections.abc import AsyncGenerator, Callable
from pathlib import Path
from typing import TYPE_CHECKING, Protocol

from pipecat.frames.frames import Frame, TTSAudioRawFrame
from pipecat.services.tts_service import TextAggregationMode
from pipecat.services.settings import TTSSettings
from pipecat.services.tts_service import TTSService

if TYPE_CHECKING:
    import sherpa_onnx

KOKORO_SAMPLE_RATE = 24_000
KOKORO_NUM_THREADS = 2
KOKORO_MAX_NUM_SENTENCES = 1
KOKORO_SPEAKER_ID = 0
KOKORO_SPEED = 0.97
KOKORO_SILENCE_SCALE = 0.42
MAX_PENDING_AUDIO_CHUNKS = 8


class GeneratedAudio(Protocol):
    samples: object
    sample_rate: int


class OfflineTts(Protocol):
    sample_rate: int

    def generate(
        self,
        text: str,
        config: object,
        callback: Callable[[object, float], int] | None = None,
    ) -> GeneratedAudio: ...


class NativeGenerationMetrics(Protocol):
    sample_rate: int
    chunk_count: int
    total_samples: int
    synthesis_ms: float
    synthesis_cpu_ms: float
    first_chunk_ms: float | None


class GenerationMetrics:
    def __init__(self, sample_rate: int) -> None:
        self.sample_rate = sample_rate
        self.chunk_count = 0
        self.total_samples = 0
        self.synthesis_ms = 0.0
        self.synthesis_cpu_ms = 0.0
        self.first_chunk_ms: float | None = None
        self.peak_rss_bytes = 0


def _int16_mono(samples: object) -> bytes:
    """Convert Sherpa's float samples to little-endian signed mono PCM."""
    try:
        values = samples.tolist()  # numpy arrays used by sherpa-onnx
    except AttributeError:
        values = list(samples)  # type: ignore[arg-type]
    if values and isinstance(values[0], (list, tuple)):
        values = [item for row in values for item in row]
    pcm = array("h")
    pcm.extend(
        round(max(-1.0, min(1.0, float(value))) * (32_768 if float(value) < 0 else 32_767))
        for value in values
    )
    if pcm.itemsize != 2:
        raise RuntimeError("The platform does not use 16-bit signed PCM.")
    if __import__("sys").byteorder != "little":
        pcm.byteswap()
    return pcm.tobytes()


def validate_model_root(model_root: Path) -> None:
    required = (
        "model.int8.onnx",
        "voices.bin",
        "tokens.txt",
        "lexicon-us-en.txt",
        "espeak-ng-data",
    )
    missing = next(
        (name for name in required if not (model_root / name).is_file() and not (model_root / name).is_dir()),
        None,
    )
    if missing is not None:
        raise RuntimeError(f"Bundled Kokoro resource is missing: {missing}.")


def create_tts(model_root: Path) -> OfflineTts:
    validate_model_root(model_root)
    import sherpa_onnx

    model = sherpa_onnx.OfflineTtsKokoroModelConfig(
        model=str(model_root / "model.int8.onnx"),
        voices=str(model_root / "voices.bin"),
        tokens=str(model_root / "tokens.txt"),
        lexicon=str(model_root / "lexicon-us-en.txt"),
        data_dir=str(model_root / "espeak-ng-data"),
    )
    config = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            kokoro=model,
            num_threads=KOKORO_NUM_THREADS,
            debug=False,
            provider="cpu",
        ),
        max_num_sentences=KOKORO_MAX_NUM_SENTENCES,
        silence_scale=KOKORO_SILENCE_SCALE,
    )
    if not config.validate():
        raise RuntimeError("The bundled Kokoro configuration is invalid.")
    return sherpa_onnx.OfflineTts(config)


class JarvisKokoroTTSService(TTSService):
    """Pipecat TTS service backed by one resident sherpa-onnx Kokoro model."""

    def __init__(self, tts: OfflineTts, *, sample_rate: int | None = None) -> None:
        super().__init__(
            push_text_frames=False,
            push_stop_frames=True,
            push_start_frame=True,
            text_aggregation_mode=TextAggregationMode.TOKEN,
            sample_rate=sample_rate or int(tts.sample_rate),
            settings=TTSSettings(model="kokoro-int8", voice=None, language=None),
        )
        self._tts = tts
        self._generation_task: asyncio.Task[GenerationMetrics] | None = None
        self._cancel_generation = threading.Event()
        self.last_metrics: GenerationMetrics | None = None

    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame | None, None]:
        del context_id
        pending: queue.Queue[bytes | None] = queue.Queue(maxsize=MAX_PENDING_AUDIO_CHUNKS)
        cancelled = self._cancel_generation
        cancelled.clear()
        metrics = GenerationMetrics(int(self._tts.sample_rate))
        native_started = time.monotonic()
        native_cpu_started = time.process_time()
        accepted_callback_pcm = bytearray()

        def enqueue_audio(audio: bytes, *, callback_chunk: bool = False) -> bool:
            if not audio:
                return not cancelled.is_set()
            while not cancelled.is_set():
                try:
                    pending.put(audio, timeout=0.05)
                    metrics.chunk_count += 1
                    metrics.total_samples += len(audio) // 2
                    if metrics.first_chunk_ms is None:
                        metrics.first_chunk_ms = (time.monotonic() - native_started) * 1000
                    if callback_chunk:
                        accepted_callback_pcm.extend(audio)
                    return True
                except queue.Full:
                    continue
            return False

        def on_progress(samples: object, _progress: float) -> int:
            if cancelled.is_set():
                return 0
            audio = _int16_mono(samples)
            if not audio:
                return 1
            # Sherpa's Python docstring says nonzero stops, but the pinned
            # binding passes this value to native Kokoro, where 1 continues.
            return 1 if enqueue_audio(audio, callback_chunk=True) else 0

        def generate() -> GenerationMetrics:
            try:
                try:
                    import sherpa_onnx

                    config = sherpa_onnx.GenerationConfig()
                except (ImportError, OSError):
                    # Unit-test doubles do not need Sherpa's native config.
                    # The real bundled runtime always takes the branch above.
                    config = type("GenerationConfig", (), {})()
                config.sid = KOKORO_SPEAKER_ID
                config.speed = KOKORO_SPEED
                config.silence_scale = KOKORO_SILENCE_SCALE
                generated = self._tts.generate(text, config, on_progress)
                if not cancelled.is_set():
                    audio = _int16_mono(generated.samples)
                    callback_pcm = bytes(accepted_callback_pcm)
                    # Native callbacks are ordered deltas; the return value is
                    # the complete utterance. Append only a verified tail.
                    if not audio.startswith(callback_pcm):
                        raise RuntimeError(
                            "Sherpa Kokoro callback PCM is not a prefix of generated.samples."
                        )
                    missing = audio[len(callback_pcm) :]
                    enqueue_audio(missing)
                metrics.sample_rate = int(generated.sample_rate)
                return metrics
            finally:
                metrics.synthesis_ms = (time.monotonic() - native_started) * 1000
                metrics.synthesis_cpu_ms = (time.process_time() - native_cpu_started) * 1000
                # The sentinel is always inserted after native generation has
                # returned. This is the point at which model reuse is safe.
                while True:
                    try:
                        pending.put(None, timeout=0.05)
                        break
                    except queue.Full:
                        if cancelled.is_set():
                            try:
                                pending.get_nowait()
                            except queue.Empty:
                                pass

        native_task = asyncio.create_task(asyncio.to_thread(generate))
        self._generation_task = native_task
        try:
            while True:
                item = await asyncio.to_thread(pending.get)
                if item is None:
                    break
                yield TTSAudioRawFrame(
                    audio=item,
                    sample_rate=metrics.sample_rate,
                    num_channels=1,
                )
            result = await native_task
            self.last_metrics = result
        except asyncio.CancelledError:
            cancelled.set()
            await asyncio.shield(native_task)
            raise
        finally:
            cancelled.set()
            if not native_task.done():
                await asyncio.shield(native_task)
            self._generation_task = None

    async def cancel_generation(self) -> None:
        self._cancel_generation.set()
        task = self._generation_task
        if task is not None:
            await asyncio.shield(task)


# Keep the short name available for local callers while the explicit name
# documents that this is Jarvis's Sherpa-backed adapter, not Pipecat's
# optional kokoro-onnx service.
KokoroTTSService = JarvisKokoroTTSService


__all__ = [
    "KOKORO_MAX_NUM_SENTENCES",
    "KOKORO_NUM_THREADS",
    "KOKORO_SAMPLE_RATE",
    "KOKORO_SILENCE_SCALE",
    "KOKORO_SPEED",
    "KOKORO_SPEAKER_ID",
    "JarvisKokoroTTSService",
    "KokoroTTSService",
    "create_tts",
    "validate_model_root",
]
