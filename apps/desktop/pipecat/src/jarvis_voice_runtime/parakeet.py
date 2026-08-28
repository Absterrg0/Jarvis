from __future__ import annotations

import asyncio
import re
import time
from array import array
from collections.abc import AsyncGenerator, Iterable
from pathlib import Path
from typing import TYPE_CHECKING, Protocol

from pipecat.audio.resamplers.soxr_resampler import SOXRAudioResampler
from pipecat.frames.frames import (
    Frame,
    TranscriptionFrame,
)
from pipecat.services.settings import STTSettings
from pipecat.services.stt_service import SegmentedSTTService
from pipecat.utils.time import time_now_iso8601

if TYPE_CHECKING:
    import sherpa_onnx

PARAKEET_SAMPLE_RATE = 16_000
PARAKEET_HOTWORD_SCORE = 2.0
PARAKEET_MAX_CONTEXTUAL_PHRASES = 64
PARAKEET_MAX_WORDS_PER_PHRASE = 8


class RecognizerStream(Protocol):
    result: object

    def accept_waveform(self, sample_rate: int, samples: Iterable[float]) -> None: ...


class Recognizer(Protocol):
    def create_stream(self, hotwords: str = "") -> RecognizerStream: ...

    def decode_stream(self, stream: RecognizerStream) -> None: ...


class ParakeetSegmentedSTT(SegmentedSTTService):
    """Pipecat segmented STT adapter over Jarvis's bundled Parakeet model."""

    def __init__(
        self,
        recognizer: Recognizer,
        hotwords: str,
        *,
        sample_rate: int = PARAKEET_SAMPLE_RATE,
    ) -> None:
        super().__init__(
            sample_rate=sample_rate,
            audio_passthrough=False,
            settings=STTSettings(model="parakeet-tdt-ctc-110m-int8", language=None),
        )
        self._recognizer = recognizer
        self._hotwords = hotwords
        self._input_sample_rate = sample_rate
        self._resampler = SOXRAudioResampler()
        self.resample_ms = 0.0
        self.decode_ms = 0.0

    @property
    def wants_wav_segments(self) -> bool:
        return False

    async def run_stt(self, audio: bytes) -> AsyncGenerator[Frame | None, None]:
        resample_started = time.monotonic()
        audio_16k = await self._resampler.resample(
            audio, self._input_sample_rate, PARAKEET_SAMPLE_RATE
        )
        self.resample_ms = (time.monotonic() - resample_started) * 1000
        decode_started = time.monotonic()
        text = await self._decode_without_cancelling(audio_16k)
        self.decode_ms = (time.monotonic() - decode_started) * 1000
        if text:
            yield TranscriptionFrame(text=text, user_id="", timestamp=time_now_iso8601())

    async def _decode_without_cancelling(self, audio: bytes) -> str:
        """Finish a native decode before allowing the recognizer to be reused.

        Cancelling the Pipecat frame task cancels the await on ``to_thread`` but
        cannot stop the native sherpa call itself. Waiting for this task here
        keeps a cancelled capture from racing a later capture on the resident
        recognizer.
        """
        decode_task = asyncio.create_task(asyncio.to_thread(self._decode, audio))
        try:
            return await asyncio.shield(decode_task)
        except asyncio.CancelledError:
            try:
                await decode_task
            finally:
                raise

    def _decode(self, audio: bytes) -> str:
        samples = array("h")
        samples.frombytes(audio)
        stream = self._recognizer.create_stream(self._hotwords)
        stream.accept_waveform(
            PARAKEET_SAMPLE_RATE,
            (value / 32_768.0 for value in samples),
        )
        self._recognizer.decode_stream(stream)
        return str(getattr(stream.result, "text", "")).strip()


def validate_model_root(model_root: Path) -> None:
    missing = next(
        (
            name
            for name in ("encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt")
            if not (model_root / name).is_file()
        ),
        None,
    )
    if missing is not None:
        raise RuntimeError(f"Bundled Parakeet resource is missing: {missing}.")


def create_recognizer(model_root: Path) -> Recognizer:
    validate_model_root(model_root)
    import sherpa_onnx

    return sherpa_onnx.OfflineRecognizer.from_transducer(
        encoder=str(model_root / "encoder.int8.onnx"),
        decoder=str(model_root / "decoder.int8.onnx"),
        joiner=str(model_root / "joiner.int8.onnx"),
        tokens=str(model_root / "tokens.txt"),
        num_threads=4,
        sample_rate=PARAKEET_SAMPLE_RATE,
        feature_dim=80,
        decoding_method="modified_beam_search",
        max_active_paths=4,
        model_type="",
        provider="cpu",
        debug=False,
    )


def _tokens(tokens_path: Path) -> tuple[frozenset[str], int]:
    values = frozenset(
        token
        for line in tokens_path.read_text(encoding="utf-8").splitlines()
        if (token := line.strip().split(maxsplit=1)[0]) and not token.startswith("<")
    )
    return values, max((len(token) for token in values), default=0)


def _tokenize_word(
    word: str,
    vocabulary: frozenset[str],
    maximum_length: int,
) -> tuple[str, ...] | None:
    variants = (word, word.lower(), word[:1].upper() + word[1:].lower())
    for target in dict.fromkeys(variants):
        memo: dict[int, tuple[str, ...] | None] = {}

        def tokenize_from(offset: int) -> tuple[str, ...] | None:
            if offset == len(target):
                return ()
            if offset in memo:
                return memo[offset]
            maximum = min(maximum_length, len(target) - offset)
            for length in range(maximum, 0, -1):
                candidate = target[offset : offset + length]
                if candidate not in vocabulary:
                    continue
                remainder = tokenize_from(offset + length)
                if remainder is not None:
                    memo[offset] = (candidate, *remainder)
                    return memo[offset]
            memo[offset] = None
            return None

        encoded = tokenize_from(0)
        if encoded is not None and "▁" in vocabulary:
            return ("▁", *encoded)
    return None


def build_hotwords(phrases: tuple[str, ...], tokens_path: Path) -> str:
    if not phrases:
        return ""
    vocabulary, maximum_length = _tokens(tokens_path)
    encoded: list[str] = []
    seen: set[str] = set()
    for phrase in phrases[:PARAKEET_MAX_CONTEXTUAL_PHRASES]:
        normalized = phrase.strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        words = re.findall(r"[^\W_]+", normalized, flags=re.UNICODE)
        if not words or len(words) > PARAKEET_MAX_WORDS_PER_PHRASE:
            continue
        tokenized = [_tokenize_word(word, vocabulary, maximum_length) for word in words]
        if any(tokens is None for tokens in tokenized):
            continue
        flattened = [token for tokens in tokenized for token in (tokens or ())]
        if flattened:
            encoded.append(f"{' '.join(flattened)} :{PARAKEET_HOTWORD_SCORE:.1f}")
    return "/".join(encoded)


def downmix_pcm(audio: bytes, channels: int) -> bytes:
    pcm = array("h")
    pcm.frombytes(audio)
    if channels <= 1:
        return audio
    if len(pcm) % channels:
        raise ValueError("PCM chunk does not contain complete channel frames.")
    pcm = array(
        "h",
        (
            round(sum(pcm[index + channel] for channel in range(channels)) / channels)
            for index in range(0, len(pcm), channels)
        ),
    )
    return pcm.tobytes()
