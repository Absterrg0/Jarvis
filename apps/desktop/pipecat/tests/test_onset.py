"""Regression tests for the bounded streaming onset filter.

Ported from the measured onset study: the filter removes only the
leading-silence prefix, preserves quiet attacks with preroll, keeps every
later pause, and returns an exact suffix across variable chunk boundaries.
"""

from __future__ import annotations

import random
import unittest

from jarvis_voice_runtime.onset import StreamOnset


def zeros(count: int) -> list[float]:
    return [0.0] * count


def full(count: int, value: float) -> list[float]:
    return [value] * count


class StreamOnsetTest(unittest.TestCase):
    def test_emits_during_generation_and_keeps_quiet_attack_and_preroll(self) -> None:
        gate = StreamOnset(sample_rate=1000)
        self.assertIsNone(gate.push(zeros(100)))
        attack = full(20, 0.0001)
        speech = full(80, 0.1)
        output = gate.push(zeros(20) + attack + speech)
        self.assertIsNotNone(output)
        assert output is not None
        self.assertEqual(output[-100:], attack + speech)
        self.assertGreaterEqual(len(output), 110)
        continuation = zeros(100)
        self.assertIs(gate.push(continuation), continuation)

    def test_speech_on_first_sample_is_preserved(self) -> None:
        gate = StreamOnset(sample_rate=1000)
        pcm = full(80, 0.1)
        self.assertEqual(gate.push(pcm), pcm)
        self.assertEqual(gate.dropped, 0)

    def test_onset_across_chunk_boundary_is_not_lost(self) -> None:
        gate = StreamOnset(sample_rate=1000)
        self.assertIsNone(gate.push(zeros(100) + full(4, 0.001)))
        output = gate.push(full(20, 0.01))
        self.assertIsNotNone(output)
        assert output is not None
        self.assertEqual(output[-24:], full(4, 0.001) + full(20, 0.01))

    def test_silence_removal_is_bounded_and_tiny_outputs_survive(self) -> None:
        gate = StreamOnset(sample_rate=1000, max_trim_ms=100)
        self.assertIsNotNone(gate.push(zeros(100)))
        tiny = StreamOnset(sample_rate=1000)
        self.assertIsNone(tiny.push(full(3, 1.0)))
        self.assertEqual(tiny.finish(), full(3, 1.0))


class DecoderTransientTest(unittest.TestCase):
    def test_quiet_decoder_transient_does_not_open_the_gate(self) -> None:
        gate = StreamOnset(sample_rate=1000, threshold_dbfs=-50, preroll_ms=40)
        self.assertIsNone(gate.push(full(5, 0.002) + zeros(195)))
        speech = zeros(100) + full(10, 0.0005) + full(100, 0.1)
        output = gate.push(speech)
        self.assertIsNotNone(output)
        assert output is not None
        self.assertEqual(output[-110:], speech[-110:])
        self.assertGreater(gate.dropped, 200)


class SuffixPreservationTest(unittest.TestCase):
    def test_variable_chunk_boundaries_only_remove_a_prefix(self) -> None:
        rng = random.Random(23)
        for size in (13, 1920, 5760, 28800):
            original = zeros(17000) + [rng.gauss(0, 0.03) for _ in range(40000)]
            gate = StreamOnset(threshold_dbfs=-50, preroll_ms=40)
            outputs: list[float] = []
            for offset in range(0, len(original), size):
                chunk = gate.push(original[offset : offset + size])
                if chunk:
                    outputs.extend(chunk)
            outputs.extend(gate.finish())
            self.assertEqual(outputs, original[gate.dropped :])


class PausePreservationTest(unittest.TestCase):
    def test_every_pause_after_the_gate_opens_passes_through(self) -> None:
        gate = StreamOnset(sample_rate=1000)
        self.assertIsNotNone(gate.push(full(50, 0.2)))
        pause = zeros(500)
        self.assertIs(gate.push(pause), pause)
        second = full(50, 0.2)
        self.assertIs(gate.push(second), second)


if __name__ == "__main__":
    unittest.main()
