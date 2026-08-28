from __future__ import annotations

from collections.abc import Awaitable, Callable

from pipecat.frames.frames import (
    Frame,
    InterruptionFrame,
    OutputAudioRawFrame,
    TTSAudioRawFrame,
    TTSStoppedFrame,
)
from pipecat.transports.base_output import BaseOutputTransport
from pipecat.transports.base_transport import TransportParams

from .protocol import MAX_PCM_CHUNK_BYTES


EmitAudio = Callable[[bytes, int, int, int], Awaitable[None]]
EmitAudioEnd = Callable[[], Awaitable[None]]
WaitForDrain = Callable[[], Awaitable[None]]


class DesktopPcmOutputTransport(BaseOutputTransport):
    """Pipecat output transport that hands bounded PCM to Desktop.

    Desktop owns the actual node-cpal device. Each audio frame is awaited by
    the runtime until Desktop confirms that it consumed the frame, which keeps
    Pipecat's queue bounded without adding a second playback queue.
    """

    def __init__(
        self,
        *,
        emit_audio: EmitAudio,
        emit_audio_end: EmitAudioEnd,
        wait_for_drain: WaitForDrain,
    ) -> None:
        super().__init__(
            TransportParams(
                audio_out_enabled=True,
                audio_out_sample_rate=24_000,
                audio_out_channels=1,
                audio_out_auto_silence=False,
                audio_out_end_silence_secs=0,
            )
        )
        self._emit_audio = emit_audio
        self._emit_audio_end = emit_audio_end
        self._wait_for_drain = wait_for_drain
        self._sequence = 0

    async def _handle_frame(self, frame: Frame) -> None:
        if isinstance(frame, (TTSAudioRawFrame, OutputAudioRawFrame)):
            if len(frame.audio) == 0 or len(frame.audio) % 2 != 0:
                raise ValueError("Pipecat speech audio must contain non-empty int16 PCM.")
            chunk_size = MAX_PCM_CHUNK_BYTES - (MAX_PCM_CHUNK_BYTES % 2)
            for offset in range(0, len(frame.audio), chunk_size):
                chunk = frame.audio[offset : offset + chunk_size]
                await self._emit_audio(chunk, frame.sample_rate, frame.num_channels, self._sequence)
                self._sequence += 1
            return
        if isinstance(frame, TTSStoppedFrame):
            await self._emit_audio_end()
            await self._wait_for_drain()
            return
        if isinstance(frame, InterruptionFrame):
            return
        # Control frames still need to reach the sink so the worker can finish
        # cleanly. There is no device sender in this transport.
        await self.push_frame(frame)

    def reset_sequence(self) -> None:
        self._sequence = 0


__all__ = ["DesktopPcmOutputTransport"]
