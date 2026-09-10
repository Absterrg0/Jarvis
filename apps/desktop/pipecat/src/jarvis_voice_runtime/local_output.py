from __future__ import annotations

from collections.abc import Callable
from typing import Protocol, cast

import pyaudio
from pipecat.frames.frames import OutputAudioRawFrame, StartFrame
from pipecat.transports.base_output import BaseOutputTransport
from pipecat.transports.local.audio import LocalAudioOutputTransport, LocalAudioTransportParams


class AudioStream(Protocol):
    def start_stream(self) -> None: ...
    def stop_stream(self) -> None: ...
    def close(self) -> None: ...


class PyAudioHost(Protocol):
    def get_format_from_width(self, width: int) -> int: ...
    def open(self, **kwargs: object) -> AudioStream: ...
    def terminate(self) -> None: ...


class JarvisLocalAudioOutputTransport(LocalAudioOutputTransport):
    """Pipecat local output with per-utterance default-device selection."""

    def __init__(
        self,
        *,
        sample_rate: int = 24_000,
        pyaudio_factory: Callable[[], PyAudioHost] = pyaudio.PyAudio,
    ) -> None:
        self._jarvis_pyaudio = pyaudio_factory()
        self._jarvis_terminated = False
        self._jarvis_cleaned = False
        self.output_error: Exception | None = None
        super().__init__(
            cast(pyaudio.PyAudio, self._jarvis_pyaudio),
            LocalAudioTransportParams(
                audio_out_enabled=True,
                audio_out_sample_rate=sample_rate,
                audio_out_channels=1,
                audio_out_auto_silence=False,
                audio_out_end_silence_secs=0,
            ),
        )

    async def start(self, frame: StartFrame) -> None:
        await BaseOutputTransport.start(self, frame)
        self._sample_rate = self._params.audio_out_sample_rate or frame.audio_out_sample_rate
        await self.set_transport_ready(frame)

    async def write_audio_frame(self, frame: OutputAudioRawFrame) -> bool:
        try:
            if self._out_stream is None:
                self._out_stream = self._jarvis_pyaudio.open(
                    format=self._jarvis_pyaudio.get_format_from_width(2),
                    channels=self._params.audio_out_channels,
                    rate=self._sample_rate,
                    output=True,
                    output_device_index=self._params.output_device_index,
                )
                self._out_stream.start_stream()
            return await super().write_audio_frame(frame)
        except Exception as error:
            self.output_error = error
            raise

    async def finish_utterance(self) -> bool:
        stream = self._out_stream
        self._out_stream = None
        if stream is None:
            return False
        try:
            def close_stream() -> None:
                try:
                    stream.stop_stream()
                finally:
                    stream.close()

            await self.get_event_loop().run_in_executor(self._executor, close_stream)
            return self.output_error is None
        except Exception as error:
            self.output_error = error
            return False

    async def abort_utterance(self) -> None:
        await self.finish_utterance()

    def reset_utterance(self) -> None:
        if self._out_stream is not None:
            raise RuntimeError("The previous local audio utterance is still open.")
        self.output_error = None

    async def cleanup(self) -> None:
        if self._jarvis_cleaned:
            return
        self._jarvis_cleaned = True
        await super().cleanup()
        self._executor.shutdown(wait=True)
        if not self._jarvis_terminated:
            self._jarvis_pyaudio.terminate()
            self._jarvis_terminated = True


__all__ = ["JarvisLocalAudioOutputTransport"]
