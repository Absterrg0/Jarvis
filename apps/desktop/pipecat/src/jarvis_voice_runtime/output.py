from __future__ import annotations

import asyncio
import shutil
import sys
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Protocol

from pipecat.frames.frames import OutputAudioRawFrame, StartFrame
from pipecat.transports.base_output import BaseOutputTransport
from pipecat.transports.base_transport import TransportParams


class SpeechOutputTransport(Protocol):
    output_error: Exception | None

    def reset_utterance(self) -> None: ...
    async def finish_utterance(self) -> bool: ...
    async def abort_utterance(self) -> None: ...
    async def cleanup(self) -> None: ...


class PcmBufferOutputTransport(BaseOutputTransport):
    """Collect one bounded mono PCM utterance for a remote caller.

    The local PipeWire transport remains the default for desktop speech. This
    transport only changes where generated frames go; Kokoro and Pipecat use
    the same pipeline and model in both modes.
    """

    def __init__(self, sample_rate: int, *, max_bytes: int = 8_000_000) -> None:
        if sample_rate <= 0:
            raise ValueError("PCM output requires a positive sample rate.")
        super().__init__(
            TransportParams(
                audio_out_enabled=True,
                audio_out_sample_rate=sample_rate,
                audio_out_channels=1,
                audio_out_auto_silence=False,
                audio_out_end_silence_secs=0,
            )
        )
        self._sample_rate = sample_rate
        self._max_bytes = max_bytes
        self._audio = bytearray()
        self.output_error: Exception | None = None

    @property
    def sample_rate(self) -> int:
        return self._sample_rate

    @property
    def audio(self) -> bytes:
        return bytes(self._audio)

    def reset_utterance(self) -> None:
        self._audio.clear()
        self.output_error = None

    async def start(self, frame: StartFrame) -> None:
        await super().start(frame)
        await self.set_transport_ready(frame)

    async def write_audio_frame(self, frame: OutputAudioRawFrame) -> bool:
        if frame.num_channels != 1 or len(frame.audio) % 2 != 0:
            self.output_error = ValueError("Remote voice output requires mono signed 16-bit PCM.")
            raise self.output_error
        if len(self._audio) + len(frame.audio) > self._max_bytes:
            self.output_error = ValueError("Remote voice output exceeded its audio limit.")
            raise self.output_error
        self._audio.extend(frame.audio)
        return True

    async def finish_utterance(self) -> bool:
        return bool(self._audio)

    async def abort_utterance(self) -> None:
        self._audio.clear()

    async def cleanup(self) -> None:
        self._audio.clear()
        await super().cleanup()


ProcessFactory = Callable[..., Awaitable[asyncio.subprocess.Process]]


@dataclass(frozen=True)
class _SpawnedPlayer:
    process: asyncio.subprocess.Process
    stderr_task: asyncio.Task[None]


class PipeWireAudioOutputTransport(BaseOutputTransport):
    """Write one Pipecat utterance to the current PipeWire default output.

    No target is passed to ``pw-play``: WirePlumber remains responsible for
    speakers, earbuds, USB/HDMI outputs, and hot-plug routing. Closing stdin
    makes pw-play drain its PipeWire stream before a successful process exit.
    """

    def __init__(
        self,
        *,
        sample_rate: int = 24_000,
        channels: int = 1,
        executable: str | None = None,
        process_factory: ProcessFactory = asyncio.create_subprocess_exec,
        drain_timeout: float = 15.0,
        terminate_timeout: float = 0.75,
    ) -> None:
        resolved = executable or shutil.which("pw-play")
        if resolved is None:
            raise RuntimeError(
                "Jarvis voice playback requires pw-play. Install the PipeWire utilities "
                "package (pipewire-utils) and restart Jarvis."
            )
        if sample_rate <= 0 or channels <= 0:
            raise ValueError("PipeWire output requires a positive sample rate and channel count.")
        super().__init__(
            TransportParams(
                audio_out_enabled=True,
                audio_out_sample_rate=sample_rate,
                audio_out_channels=channels,
                audio_out_auto_silence=False,
                audio_out_end_silence_secs=0,
            )
        )
        self._executable = resolved
        self._channels = channels
        self._process_factory = process_factory
        self._drain_timeout = drain_timeout
        self._terminate_timeout = terminate_timeout
        self._lock = asyncio.Lock()
        self._generation = 0
        self._state = "idle"
        self._spawn_task: asyncio.Task[_SpawnedPlayer] | None = None
        self._terminal_task: asyncio.Task[bool] | None = None
        self._stderr_tail: deque[bytes] = deque()
        self._stderr_size = 0
        self._had_audio = False
        self.output_error: Exception | None = None

    async def start(self, frame: StartFrame) -> None:
        await super().start(frame)
        await self.set_transport_ready(frame)

    @property
    def command(self) -> tuple[str, ...]:
        return (
            self._executable,
            "--raw",
            "--rate",
            str(self.sample_rate or self._params.audio_out_sample_rate),
            "--channels",
            str(self._channels),
            "--format",
            "s16",
            "-",
        )

    def reset_utterance(self) -> None:
        if self._state != "idle" or self._spawn_task is not None:
            raise RuntimeError("The previous PipeWire utterance has not been reaped.")
        self._generation += 1
        self._state = "ready"
        self._terminal_task = None
        self._stderr_tail.clear()
        self._stderr_size = 0
        self._had_audio = False
        self.output_error = None

    async def _read_stderr(self, stream: asyncio.StreamReader | None) -> None:
        if stream is None:
            return
        while chunk := await stream.read(1_024):
            self._stderr_tail.append(chunk)
            self._stderr_size += len(chunk)
            while self._stderr_size > 8_192 and self._stderr_tail:
                self._stderr_size -= len(self._stderr_tail.popleft())

    def _stderr_message(self) -> str:
        return b"".join(self._stderr_tail).decode("utf-8", errors="replace").strip()

    async def _spawn(self) -> _SpawnedPlayer:
        process = await self._process_factory(
            *self.command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        if process.stdin is None:
            await self._terminate(process)
            raise RuntimeError("pw-play did not open its PCM input stream.")
        return _SpawnedPlayer(process, asyncio.create_task(self._read_stderr(process.stderr)))

    async def _player(self, generation: int) -> _SpawnedPlayer:
        async with self._lock:
            if generation != self._generation or self._state not in {"ready", "starting", "playing"}:
                raise asyncio.CancelledError
            if self._spawn_task is None:
                self._state = "starting"
                self._spawn_task = asyncio.create_task(self._spawn())
            task = self._spawn_task
        try:
            player = await task
        except BaseException as error:
            async with self._lock:
                interrupted = generation != self._generation or self._state == "aborting"
                if not interrupted and isinstance(error, Exception):
                    self.output_error = error
            raise
        async with self._lock:
            if generation == self._generation and self._state == "starting":
                self._state = "playing"
            interrupted = generation != self._generation or self._state == "aborting"
        if interrupted:
            await self._terminate(player.process)
            await player.stderr_task
            raise asyncio.CancelledError
        return player

    async def write_audio_frame(self, frame: OutputAudioRawFrame) -> bool:
        if frame.sample_rate != self.sample_rate:
            error = ValueError(
                f"PipeWire PCM sample rate changed from {self.sample_rate} to {frame.sample_rate}."
            )
            self.output_error = error
            raise error
        if frame.num_channels != self._channels or len(frame.audio) % (2 * self._channels) != 0:
            error = ValueError("PipeWire output requires complete signed 16-bit PCM frames.")
            self.output_error = error
            raise error
        if not frame.audio:
            return True
        generation = self._generation
        try:
            player = await self._player(generation)
            if player.process.returncode is not None:
                raise RuntimeError(
                    f"pw-play exited before the utterance finished (code {player.process.returncode})."
                )
            assert player.process.stdin is not None
            player.process.stdin.write(frame.audio)
            await player.process.stdin.drain()
            async with self._lock:
                if generation != self._generation or self._state == "aborting":
                    return False
                self._had_audio = True
            return True
        except asyncio.CancelledError:
            return False
        except Exception as error:
            async with self._lock:
                interrupted = generation != self._generation or self._state == "aborting"
                if not interrupted:
                    self.output_error = error
            if interrupted:
                return False
            raise

    async def _finish(self, generation: int, spawn_task: asyncio.Task[_SpawnedPlayer]) -> bool:
        try:
            player = await asyncio.wait_for(
                asyncio.shield(spawn_task), timeout=self._drain_timeout
            )
            process = player.process

            async def drain_player() -> int:
                if process.stdin is not None:
                    process.stdin.close()
                    try:
                        await process.stdin.wait_closed()
                    except (BrokenPipeError, ConnectionResetError):
                        pass
                return_code = await process.wait()
                await player.stderr_task
                return return_code

            drain_task = asyncio.create_task(drain_player())
            try:
                return_code = await asyncio.wait_for(
                    asyncio.shield(drain_task), timeout=self._drain_timeout
                )
            except asyncio.TimeoutError:
                await self._terminate(process)
                drain_task.cancel()
                await asyncio.gather(drain_task, return_exceptions=True)
                if not player.stderr_task.done():
                    player.stderr_task.cancel()
                    await asyncio.gather(player.stderr_task, return_exceptions=True)
                raise
            async with self._lock:
                interrupted = generation != self._generation or self._state == "aborting"
            if interrupted:
                return False
            if return_code != 0:
                detail = self._stderr_message()
                suffix = f": {detail}" if detail else ""
                raise RuntimeError(f"pw-play failed with exit code {return_code}{suffix}")
            if self.output_error is not None:
                return False
            return True
        except asyncio.TimeoutError as error:
            if spawn_task.done() and not spawn_task.cancelled():
                try:
                    player = spawn_task.result()
                except Exception:
                    player = None
                if player is not None:
                    await self._terminate(player.process)
                    if not player.stderr_task.done():
                        player.stderr_task.cancel()
                        await asyncio.gather(player.stderr_task, return_exceptions=True)
            else:
                spawn_task.cancel()
                await asyncio.gather(spawn_task, return_exceptions=True)
            failure = RuntimeError("pw-play did not report a drained PipeWire stream in time.")
            failure.__cause__ = error
            async with self._lock:
                if generation == self._generation and self._state != "aborting":
                    self.output_error = failure
            return False
        except Exception as error:
            async with self._lock:
                if generation == self._generation and self._state != "aborting":
                    self.output_error = error
            return False
        finally:
            async with self._lock:
                if generation == self._generation and self._state == "finishing":
                    self._state = "idle"
                    self._spawn_task = None
                    self._terminal_task = None

    async def finish_utterance(self) -> bool:
        async with self._lock:
            if self._state == "idle":
                return self._had_audio and self.output_error is None
            if self._state == "ready":
                self._state = "idle"
                return False
            if self._state in {"aborting", "finishing"}:
                task = self._terminal_task
            else:
                assert self._spawn_task is not None
                self._state = "finishing"
                task = asyncio.create_task(self._finish(self._generation, self._spawn_task))
                self._terminal_task = task
        return False if task is None else await asyncio.shield(task)

    async def _terminate(self, process: asyncio.subprocess.Process) -> None:
        if process.returncode is not None:
            await process.wait()
            return
        try:
            process.terminate()
        except ProcessLookupError:
            pass
        try:
            await asyncio.wait_for(process.wait(), timeout=self._terminate_timeout)
        except asyncio.TimeoutError:
            try:
                process.kill()
            except ProcessLookupError:
                pass
            await process.wait()

    async def _abort(
        self, spawn_task: asyncio.Task[_SpawnedPlayer] | None
    ) -> bool:
        try:
            if spawn_task is not None:
                try:
                    player = await asyncio.wait_for(
                        asyncio.shield(spawn_task), timeout=self._terminate_timeout
                    )
                except asyncio.TimeoutError:
                    spawn_task.cancel()
                    await asyncio.gather(spawn_task, return_exceptions=True)
                    return False
                except Exception:
                    return False
                await self._terminate(player.process)
                if not player.stderr_task.done():
                    try:
                        await asyncio.wait_for(
                            asyncio.shield(player.stderr_task), timeout=self._terminate_timeout
                        )
                    except asyncio.TimeoutError:
                        player.stderr_task.cancel()
                        await asyncio.gather(player.stderr_task, return_exceptions=True)
            return False
        finally:
            async with self._lock:
                if self._state == "aborting" and self._terminal_task is asyncio.current_task():
                    self._had_audio = False
                    self._state = "idle"
                    self._spawn_task = None
                    self._terminal_task = None

    async def abort_utterance(self) -> None:
        async with self._lock:
            if self._state == "idle":
                return
            if self._state == "aborting":
                task = self._terminal_task
            else:
                self._generation += 1
                self._state = "aborting"
                task = asyncio.create_task(self._abort(self._spawn_task))
                self._terminal_task = task
        if task is not None:
            await asyncio.shield(task)

    async def cleanup(self) -> None:
        await self.abort_utterance()
        await super().cleanup()


def create_speech_output(sample_rate: int) -> SpeechOutputTransport:
    if sys.platform.startswith("linux"):
        return PipeWireAudioOutputTransport(sample_rate=sample_rate)
    from .local_output import JarvisLocalAudioOutputTransport

    return JarvisLocalAudioOutputTransport(sample_rate=sample_rate)


__all__ = ["PipeWireAudioOutputTransport", "SpeechOutputTransport", "create_speech_output"]
