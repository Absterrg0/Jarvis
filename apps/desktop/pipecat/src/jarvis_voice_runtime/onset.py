"""Bounded streaming leading-silence removal for Pocket PCM output.

The native decoder often starts with near-silence before audible speech. This
gate drops only that leading prefix: it waits for a short RMS window to cross
the threshold, keeps a small preroll so quiet word starts survive, caps how
much can be removed, and passes every later sample through, including pauses
inside the utterance.

Dependency-free on purpose: the frozen voice host excludes numpy and scipy.
Samples are plain Python float sequences; only the leading prefix is ever
removed, so variable chunk boundaries always return an exact suffix.
"""

from __future__ import annotations

from collections import deque

POCKET_SAMPLE_RATE = 24_000
ONSET_THRESHOLD_DBFS = -50.0
ONSET_WINDOW_MS = 10.0
ONSET_PREROLL_MS = 40.0
ONSET_MAX_TRIM_MS = 2_000.0


class StreamOnset:
    def __init__(
        self,
        sample_rate: int = POCKET_SAMPLE_RATE,
        threshold_dbfs: float = ONSET_THRESHOLD_DBFS,
        window_ms: float = ONSET_WINDOW_MS,
        preroll_ms: float = ONSET_PREROLL_MS,
        max_trim_ms: float = ONSET_MAX_TRIM_MS,
    ) -> None:
        self.window = max(1, round(sample_rate * window_ms / 1000))
        self.preroll = round(sample_rate * preroll_ms / 1000)
        self.limit = round(sample_rate * max_trim_ms / 1000)
        self.threshold = 10.0 ** (threshold_dbfs / 20.0)
        self.pending: deque[float] = deque()
        self.open = False
        self.seen = 0
        self.dropped = 0

    def push(self, chunk: list[float]) -> list[float] | None:
        if self.open:
            return chunk
        if not chunk:
            return None
        self.seen += len(chunk)
        values = list(self.pending) + list(chunk)
        if len(values) >= self.window:
            squares = 0.0
            for index in range(self.window):
                squares += values[index] * values[index]
            audible_at = 0 if squares / self.window >= self.threshold * self.threshold else -1
            if audible_at < 0:
                for start in range(1, len(values) - self.window + 1):
                    leaving = values[start - 1]
                    entering = values[start + self.window - 1]
                    squares += entering * entering - leaving * leaving
                    if squares / self.window >= self.threshold * self.threshold:
                        audible_at = start
                        break
            if audible_at >= 0:
                start = max(0, audible_at - self.preroll)
                self.dropped += start
                self.open = True
                self.pending = deque()
                return values[start:]
        if self.seen >= self.limit:
            self.open = True
            self.pending = deque()
            return values
        keep = min(len(values), self.preroll + self.window)
        self.dropped += len(values) - keep
        self.pending = deque(values[len(values) - keep :])
        return None

    def finish(self) -> list[float]:
        values = list(self.pending)
        self.pending = deque()
        return values


__all__ = [
    "ONSET_MAX_TRIM_MS",
    "ONSET_PREROLL_MS",
    "ONSET_THRESHOLD_DBFS",
    "ONSET_WINDOW_MS",
    "POCKET_SAMPLE_RATE",
    "StreamOnset",
]
