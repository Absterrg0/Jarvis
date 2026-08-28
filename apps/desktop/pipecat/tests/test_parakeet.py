from __future__ import annotations

import asyncio
import tempfile
import unittest
from array import array
from pathlib import Path

from jarvis_voice_runtime.parakeet import ParakeetSegmentedSTT, build_hotwords, downmix_pcm
from jarvis_voice_runtime.__main__ import validate_pipecat_import_boundary


class _Result:
    text = "check out Zivil"


class _Stream:
    result = _Result()

    def __init__(self) -> None:
        self.samples: list[float] = []

    def accept_waveform(self, sample_rate: int, samples: object) -> None:
        assert sample_rate == 16_000
        self.samples = list(samples)  # type: ignore[arg-type]


class _Recognizer:
    def __init__(self) -> None:
        self.hotwords = ""
        self.stream = _Stream()

    def create_stream(self, hotwords: str = "") -> _Stream:
        self.hotwords = hotwords
        return self.stream

    def decode_stream(self, stream: _Stream) -> None:
        assert stream is self.stream


class ParakeetTest(unittest.IsolatedAsyncioTestCase):
    async def test_pipecat_segment_returns_raw_recognizer_text(self) -> None:
        recognizer = _Recognizer()
        pcm = array("h", [0, 16_384, -16_384]).tobytes()
        service = ParakeetSegmentedSTT(recognizer, "▁ Zi vil :2.0")
        frames = [frame async for frame in service.run_stt(pcm)]
        self.assertEqual([frame.text for frame in frames], ["check out Zivil"])
        self.assertEqual(recognizer.hotwords, "▁ Zi vil :2.0")
        self.assertEqual(recognizer.stream.samples, [0.0, 0.5, -0.5])

    def test_downmixes_each_pcm_chunk_at_the_runtime_boundary(self) -> None:
        pcm = array("h", [10_000, -2_000, 3_000, 7_000]).tobytes()
        self.assertEqual(array("h", downmix_pcm(pcm, 2)).tolist(), [4_000, 5_000])

    async def test_hotwords_use_the_existing_bounded_sherpa_format(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            tokens = Path(directory) / "tokens.txt"
            tokens.write_text("<blk> 0\n▁ 1\nZi 2\nvil 3\nCheck 4\nout 5\n", encoding="utf-8")
            self.assertEqual(build_hotwords(("Zivil", "Check out"), tokens), "▁ Zi vil :2.0/▁ Check ▁ out :2.0")

    def test_push_to_talk_does_not_import_pipecat_optional_onnx_models(self) -> None:
        validate_pipecat_import_boundary()


if __name__ == "__main__":
    unittest.main()
