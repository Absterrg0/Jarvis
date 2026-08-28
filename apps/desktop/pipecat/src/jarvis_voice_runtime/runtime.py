from __future__ import annotations

import asyncio
import base64
import gc
import json
import os
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, BinaryIO, Literal

from .protocol import (
    MAX_LINE_BYTES,
    PROTOCOL_VERSION,
    ProtocolError,
    capture_id,
    contextual_phrases,
    decode_pcm,
    nonnegative_integer,
    parse_command,
    positive_integer,
    request_id,
    speech_id,
    speech_text,
)

if TYPE_CHECKING:
    from .kokoro import JarvisKokoroTTSService, OfflineTts
    from .output import DesktopPcmOutputTransport
    from .parakeet import ParakeetSegmentedSTT, Recognizer

Emit = Callable[[dict[str, object]], None]

KOKORO_IDLE_SECONDS = 5 * 60


def read_bounded_line(stream: BinaryIO) -> bytes:
    """Read at most one protocol record plus one byte for overflow detection."""
    return stream.readline(MAX_LINE_BYTES + 1)


@dataclass
class Speech:
    speech_id: str
    text: str
    started_at: float
    audio_acks: dict[int, asyncio.Future[None]]
    playout_drained: asyncio.Event
    native_finished: asyncio.Event
    finished: asyncio.Event
    task: asyncio.Task[None] | None = None
    cancelled: bool = False
    audio_ended: bool = False
    terminal_emitted: bool = False


def peak_rss_bytes() -> int:
    try:
        if sys.platform == "win32":
            import ctypes
            from ctypes import wintypes

            class ProcessMemoryCounters(ctypes.Structure):
                _fields_ = [
                    ("cb", wintypes.DWORD),
                    ("page_fault_count", wintypes.DWORD),
                    ("peak_working_set_size", ctypes.c_size_t),
                    ("working_set_size", ctypes.c_size_t),
                    ("quota_peak_paged_pool_usage", ctypes.c_size_t),
                    ("quota_paged_pool_usage", ctypes.c_size_t),
                    ("quota_peak_non_paged_pool_usage", ctypes.c_size_t),
                    ("quota_non_paged_pool_usage", ctypes.c_size_t),
                    ("pagefile_usage", ctypes.c_size_t),
                    ("peak_pagefile_usage", ctypes.c_size_t),
                ]

            counters = ProcessMemoryCounters()
            counters.cb = ctypes.sizeof(counters)
            process = ctypes.windll.kernel32.GetCurrentProcess()
            get_process_memory_info = ctypes.windll.psapi.GetProcessMemoryInfo
            if get_process_memory_info(process, ctypes.byref(counters), counters.cb):
                return int(counters.peak_working_set_size)
            return 0

        import resource

        value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return int(value if sys.platform == "darwin" else value * 1024)
    except (AttributeError, ImportError, OSError):
        return 0


def emit(message: dict[str, object]) -> None:
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


@dataclass
class Capture:
    capture_id: str
    sample_rate: int
    channels: int
    hotwords: str
    started_at: float
    worker: PipelineWorker
    runner: WorkerRunner
    runner_task: asyncio.Task[None] | None
    service: ParakeetSegmentedSTT
    start: Literal["cold", "warm"]
    model_load_ms: float
    pipeline_ready_ms: float = 0.0
    first_audio_ms: float | None = None
    chunk_count: int = 0
    expected_sequence: int = 0
    input_audio_bytes: int = 0
    transcript: str | None = None
    status: Literal["capturing", "releasing"] = "capturing"
    cancelled: bool = False
    terminal_emitted: bool = False
    release_task: asyncio.Task[None] | None = None
    cancel_task: asyncio.Task[None] | None = None


class Runtime:
    def __init__(
        self,
        model_root: Path,
        *,
        kokoro_root: Path | None = None,
        recognizer: Recognizer | None = None,
        tts: OfflineTts | None = None,
        recognizer_factory: Callable[[Path], Recognizer] | None = None,
        tts_factory: Callable[[Path], OfflineTts] | None = None,
        model_load_ms: float = 0.0,
        output: Emit = emit,
    ) -> None:
        self._model_root = model_root
        self._kokoro_root = kokoro_root
        self._recognizer_factory = recognizer_factory
        self._tts_factory = tts_factory
        self._recognizer = recognizer
        self._emit = output
        self._model_load_ms = model_load_ms
        self._capture_count = 0
        self.capture: Capture | None = None
        self._tts: JarvisKokoroTTSService | None = None
        self._tts_worker: PipelineWorker | None = None
        self._tts_runner: WorkerRunner | None = None
        self._tts_runner_task: asyncio.Task[None] | None = None
        self._tts_output: DesktopPcmOutputTransport | None = None
        self._tts_warmup_ms = 0.0
        self._tts_start: Literal["cold", "warm"] = "cold"
        self._tts_eviction_task: asyncio.Task[None] | None = None
        self.speech: Speech | None = None
        self._parakeet_start: Literal["cold", "warm"] = "cold"
        self._provided_tts = tts
        self._model_lock = asyncio.Lock()
        self._desired_model: Literal["parakeet", "kokoro"] = "parakeet"
        self._capture_starting = False
        self._shutdown_requested = False

    async def _activate_parakeet(self) -> None:
        async with self._model_lock:
            await self._activate_parakeet_locked()

    async def _activate_parakeet_locked(self) -> None:
        if self.speech is not None:
            await self._cancel_speech(self.speech)
        if self._tts is not None or self._tts_worker is not None:
            await self._dispose_tts()
        if self._recognizer is not None:
            return
        started = time.monotonic()
        if self._recognizer_factory is None:
            from .parakeet import create_recognizer

            recognizer_factory = create_recognizer
        else:
            recognizer_factory = self._recognizer_factory
        recognizer = await asyncio.to_thread(recognizer_factory, self._model_root)
        if self._desired_model != "parakeet" or self._shutdown_requested:
            del recognizer
            gc.collect()
            raise RuntimeError("Parakeet activation was superseded.")
        self._recognizer = recognizer
        self._model_load_ms = (time.monotonic() - started) * 1000
        self._parakeet_start = "cold"

    async def _prepare_speech(self) -> None:
        if self._shutdown_requested:
            raise RuntimeError("Pipecat voice runtime is shutting down.")
        if self.capture is not None or self._capture_starting:
            raise ProtocolError("Speech preparation is unavailable during capture.")
        self._desired_model = "kokoro"
        kokoro_root = self._kokoro_root
        if kokoro_root is None:
            raise RuntimeError("Bundled Kokoro resources are unavailable.")
        async with self._model_lock:
            if self._desired_model != "kokoro":
                return
            if self._tts_worker is not None and self._tts is not None:
                self._schedule_tts_eviction()
                return
            await self._dispose_tts()
            self._recognizer = None
            self._parakeet_start = "cold"
            gc.collect()
            started = time.monotonic()
            native_tts = self._provided_tts
            self._provided_tts = None
            if native_tts is None:
                from .kokoro import create_tts

                tts_factory = self._tts_factory or create_tts
                native_tts = await asyncio.to_thread(tts_factory, kokoro_root)
            if (
                self._desired_model != "kokoro"
                or self._shutdown_requested
                or self.capture is not None
                or self._capture_starting
            ):
                del native_tts
                gc.collect()
                return
            self._tts_warmup_ms = (time.monotonic() - started) * 1000
            self._tts_start = "cold"
            from .kokoro import JarvisKokoroTTSService
            from .output import DesktopPcmOutputTransport
            from pipecat.pipeline.pipeline import Pipeline
            from pipecat.pipeline.worker import PipelineParams, PipelineWorker
            from pipecat.workers.runner import WorkerRunner

            service = JarvisKokoroTTSService(native_tts)
            output = DesktopPcmOutputTransport(
                emit_audio=self._emit_speech_audio,
                emit_audio_end=self._emit_speech_audio_end,
                wait_for_drain=self._wait_for_speech_playout,
            )
            worker = PipelineWorker(
                Pipeline([service, output]),
                params=PipelineParams(
                    audio_in_sample_rate=service.sample_rate,
                    audio_out_sample_rate=service.sample_rate,
                    enable_metrics=False,
                    enable_usage_metrics=False,
                ),
                enable_rtvi=False,
                enable_turn_tracking=False,
                idle_timeout_secs=None,
            )
            runner = WorkerRunner(handle_sigint=False, handle_sigterm=False)
            started_event = asyncio.Event()

            @worker.event_handler("on_pipeline_started")
            async def on_pipeline_started(_worker: PipelineWorker, _frame: object) -> None:
                started_event.set()

            @worker.event_handler("on_pipeline_error")
            async def on_pipeline_error(_worker: PipelineWorker, frame: object) -> None:
                active = self.speech
                if active is not None and not active.terminal_emitted:
                    self._emit_speech_result(
                        active,
                        "failure",
                        str(getattr(frame, "error", "Pipecat TTS pipeline failed.")),
                        "speech-failed",
                    )

            await runner.add_workers(worker)
            runner_task = asyncio.create_task(runner.run())
            try:
                await asyncio.wait_for(started_event.wait(), timeout=10)
            except BaseException:
                await runner.cancel(reason="Pipecat TTS startup failed")
                await asyncio.gather(runner_task, return_exceptions=True)
                raise
            self._tts = service
            self._tts_output = output
            self._tts_worker = worker
            self._tts_runner = runner
            self._tts_runner_task = runner_task
            self._schedule_tts_eviction()

    def _schedule_tts_eviction(self) -> None:
        if self._tts_eviction_task is not None:
            self._tts_eviction_task.cancel()

        async def evict() -> None:
            try:
                await asyncio.sleep(KOKORO_IDLE_SECONDS)
                if (
                    not self._shutdown_requested
                    and self.speech is None
                    and self._tts is not None
                ):
                    self._desired_model = "parakeet"
                    async with self._model_lock:
                        if self.speech is None and self._desired_model == "parakeet":
                            await self._dispose_tts()
                            await self._activate_parakeet_locked()
            except asyncio.CancelledError:
                pass

        self._tts_eviction_task = asyncio.create_task(evict())

    async def _dispose_tts(self) -> None:
        eviction = self._tts_eviction_task
        self._tts_eviction_task = None
        if eviction is not None and eviction is not asyncio.current_task():
            eviction.cancel()
        if self.speech is not None:
            self.speech.cancelled = True
            for future in self.speech.audio_acks.values():
                if not future.done():
                    future.set_result(None)
            self.speech.playout_drained.set()
            self.speech.native_finished.set()
            self.speech.finished.set()
            self.speech = None
        worker = self._tts_worker
        runner = self._tts_runner
        runner_task = self._tts_runner_task
        service = self._tts
        self._tts_worker = None
        self._tts_runner = None
        self._tts_runner_task = None
        self._tts_output = None
        self._tts = None
        if service is not None:
            await service.cancel_generation()
        if worker is not None and not worker.has_finished():
            await worker.cancel(reason="Switching voice model")
        if runner is not None and runner_task is not None:
            await asyncio.gather(runner_task, return_exceptions=True)
        gc.collect()

    async def _shutdown_speech(self) -> None:
        if self.speech is not None:
            await self._cancel_speech(self.speech)
        await self._dispose_tts()

    def _active_speech(self, command: dict[str, object], operation: str) -> Speech:
        active = self.speech
        if active is None or speech_id(command) != active.speech_id:
            raise ProtocolError(f"Stale speech {operation}.")
        return active

    def _begin_speech(self, command: dict[str, object]) -> None:
        if self.speech is not None:
            raise ProtocolError("Pipecat speech is already active.")
        if self._tts_worker is None or self._tts is None:
            raise ProtocolError("Pipecat speech is not prepared.")
        current = Speech(
            speech_id=speech_id(command),
            text=speech_text(command),
            started_at=time.monotonic(),
            audio_acks={},
            playout_drained=asyncio.Event(),
            native_finished=asyncio.Event(),
            finished=asyncio.Event(),
        )
        self.speech = current
        if self._tts_output is not None:
            self._tts_output.reset_sequence()
        current.task = asyncio.create_task(self._speak(current))
        current.task.add_done_callback(lambda task: self._observe_speech(current, task))

    def _observe_speech(self, active: Speech, task: asyncio.Task[None]) -> None:
        try:
            task.result()
        except asyncio.CancelledError:
            pass
        except Exception as error:
            self._emit_speech_result(active, "failure", str(error), "speech-failed")

    async def _speak(self, active: Speech) -> None:
        try:
            assert self._tts_worker is not None
            from pipecat.frames.frames import TTSSpeakFrame

            await self._tts_worker.queue_frame(TTSSpeakFrame(active.text, append_to_context=False))
            await active.finished.wait()
        except asyncio.CancelledError:
            raise
        except Exception as error:
            if not active.terminal_emitted:
                self._emit_speech_result(active, "failure", str(error), "speech-failed")

    async def _cancel_speech(self, active: Speech) -> None:
        active.cancelled = True
        for future in active.audio_acks.values():
            if not future.done():
                future.set_result(None)
        active.playout_drained.set()
        service = self._tts
        worker = self._tts_worker
        if worker is not None and not worker.has_finished():
            from pipecat.frames.frames import InterruptionFrame

            await worker.queue_frame(InterruptionFrame())
        if service is not None:
            await service.cancel_generation()
        active.native_finished.set()
        self._emit_speech_result(active, "interrupted", "Speech was interrupted.", "cancelled")
        active.finished.set()

    def _begin_speech_cancel(self, command: dict[str, object]) -> None:
        active = self._active_speech(command, "cancel")
        if active.cancelled:
            raise ProtocolError("Speech cancellation is already in progress.")
        asyncio.create_task(self._cancel_speech(active))

    async def _emit_speech_audio(self, audio: bytes, sample_rate: int, channels: int, sequence: int) -> None:
        active = self.speech
        if active is None or active.cancelled:
            return
        future = asyncio.get_running_loop().create_future()
        active.audio_acks[sequence] = future
        self._emit(
            {
                "type": "speech-audio",
                "speechId": active.speech_id,
                "sequence": sequence,
                "sampleRate": sample_rate,
                "channels": channels,
                "data": base64.b64encode(audio).decode("ascii"),
            }
        )
        await future
        active.audio_acks.pop(sequence, None)
        if active.cancelled:
            raise asyncio.CancelledError

    async def _emit_speech_audio_end(self) -> None:
        active = self.speech
        if active is None or active.cancelled:
            return
        active.audio_ended = True
        self._emit({"type": "speech-audio-end", "speechId": active.speech_id})

    async def _wait_for_speech_playout(self) -> None:
        active = self.speech
        if active is None:
            return
        active.native_finished.set()
        await active.playout_drained.wait()

    def _speech_audio_consumed(self, command: dict[str, object]) -> None:
        active = self._active_speech(command, "audio acknowledgement")
        sequence = nonnegative_integer(command, "sequence", 2**31 - 1)
        future = active.audio_acks.get(sequence)
        if future is None:
            raise ProtocolError("Stale speech audio acknowledgement.")
        if not future.done():
            future.set_result(None)

    def _speech_playout_drained(self, command: dict[str, object]) -> None:
        active = self._active_speech(command, "playout acknowledgement")
        if not active.audio_ended:
            raise ProtocolError("Speech playout ended before speech audio.")
        active.playout_drained.set()
        self._emit_speech_result(active, "completed")

    def _emit_speech_result(
        self,
        active: Speech,
        status: Literal["completed", "interrupted", "failure"],
        message: str | None = None,
        code: str | None = None,
    ) -> None:
        if active.terminal_emitted:
            return
        active.terminal_emitted = True
        timing: dict[str, object] | None = None
        if self._tts is not None and self._tts.last_metrics is not None:
            metrics = self._tts.last_metrics
            timing = {
                "engineId": "kokoro-int8",
                "start": self._tts_start,
                "warmupMs": self._tts_warmup_ms,
                "synthesisMs": metrics.synthesis_ms,
                "totalMs": (time.monotonic() - active.started_at) * 1000,
                "synthesisCpuMs": metrics.synthesis_cpu_ms,
                "peakRssBytes": peak_rss_bytes(),
                "chunkCount": metrics.chunk_count,
            }
            if metrics.first_chunk_ms is not None:
                timing["firstChunkReadyMs"] = metrics.first_chunk_ms
        result: dict[str, object] = {
            "type": "speech-result",
            "speechId": active.speech_id,
            "status": status,
        }
        if message is not None:
            result["message"] = message
        if code is not None:
            result["code"] = code
        if timing is not None:
            result["timing"] = timing
        self._emit(result)
        if status == "completed":
            self._tts_start = "warm"
        active.finished.set()
        if self.speech is active:
            self.speech = None
            self._schedule_tts_eviction()

    async def command(self, command: dict[str, object]) -> bool:
        try:
            correlation_id = request_id(command)
        except ProtocolError as error:
            self._emit({"type": "error", "message": str(error)})
            return False
        if self._shutdown_requested and command.get("type") != "shutdown":
            self._emit(
                {
                    "type": "result",
                    "requestId": correlation_id,
                    "ok": False,
                    "message": "Pipecat voice runtime is shutting down.",
                    "code": "runtime-shutting-down",
                }
            )
            return False
        try:
            kind = command.get("type")
            if kind == "capture-start":
                await self._start(command)
            elif kind == "pcm":
                await self._pcm(command)
            elif kind == "capture-release":
                self._begin_release(command)
            elif kind == "capture-cancel":
                self._begin_cancel(command)
            elif kind == "speech-prepare":
                await self._prepare_speech()
            elif kind == "speech-start":
                self._begin_speech(command)
            elif kind == "speech-audio-consumed":
                self._speech_audio_consumed(command)
            elif kind == "speech-playout-drained":
                self._speech_playout_drained(command)
            elif kind == "speech-cancel":
                self._begin_speech_cancel(command)
            elif kind == "shutdown":
                self._shutdown_requested = True
                self._desired_model = "parakeet"
                await self._shutdown_capture()
                async with self._model_lock:
                    await self._shutdown_speech()
                self._emit({"type": "result", "requestId": correlation_id, "ok": True})
                return True
            else:
                raise ProtocolError("Unknown Pipecat command.")
            self._emit({"type": "result", "requestId": correlation_id, "ok": True})
        except Exception as error:
            self._emit(
                {
                    "type": "result",
                    "requestId": correlation_id,
                    "ok": False,
                    "message": str(error),
                    "code": "sidecar-command-failed",
                }
            )
        return False

    def _active_capture(self, command: dict[str, object], operation: str) -> Capture:
        active = self.capture
        if active is None or capture_id(command) != active.capture_id:
            raise ProtocolError(f"Stale capture {operation}.")
        return active

    async def _start(self, command: dict[str, object]) -> None:
        if self.capture is not None:
            raise ProtocolError("Pipecat capture is already active.")
        if self._capture_starting:
            raise ProtocolError("Pipecat capture is already starting.")
        self._capture_starting = True
        try:
            await self._start_claimed(command)
        finally:
            self._capture_starting = False

    async def _start_claimed(self, command: dict[str, object]) -> None:
        self._desired_model = "parakeet"
        await self._activate_parakeet()
        if self._recognizer is None:
            raise RuntimeError("Parakeet recognizer is unavailable.")
        current_capture_id = capture_id(command)
        sample_rate = positive_integer(command, "sampleRate", 384_000)
        channels = positive_integer(command, "channels", 32)
        phrases = contextual_phrases(command)
        from .parakeet import ParakeetSegmentedSTT, build_hotwords

        hotwords = build_hotwords(phrases, self._model_root / "tokens.txt")
        service = ParakeetSegmentedSTT(
            self._recognizer,
            hotwords,
            sample_rate=sample_rate,
        )
        from pipecat.pipeline.pipeline import Pipeline
        from pipecat.pipeline.worker import PipelineParams, PipelineWorker
        from pipecat.workers.runner import WorkerRunner
        from pipecat.frames.frames import TranscriptionFrame, VADUserStartedSpeakingFrame

        worker = PipelineWorker(
            Pipeline([service]),
            params=PipelineParams(
                audio_in_sample_rate=sample_rate,
                audio_out_sample_rate=sample_rate,
                enable_metrics=False,
                enable_usage_metrics=False,
            ),
            enable_rtvi=False,
            enable_turn_tracking=False,
            idle_timeout_secs=None,
        )
        runner = WorkerRunner(handle_sigint=False, handle_sigterm=False)
        active = Capture(
            capture_id=current_capture_id,
            sample_rate=sample_rate,
            channels=channels,
            hotwords=hotwords,
            started_at=time.monotonic(),
            worker=worker,
            runner=runner,
            runner_task=None,
            service=service,
            start=self._parakeet_start,
            model_load_ms=self._model_load_ms if self._parakeet_start == "cold" else 0.0,
        )
        self._capture_count += 1
        self._parakeet_start = "warm"
        self.capture = active

        started = asyncio.Event()

        @worker.event_handler("on_pipeline_started")
        async def on_pipeline_started(_worker: PipelineWorker, _frame: object) -> None:
            started.set()

        @worker.event_handler("on_frame_reached_downstream")
        async def on_frame_reached_downstream(_worker: PipelineWorker, frame: object) -> None:
            if isinstance(frame, TranscriptionFrame) and not active.cancelled:
                active.transcript = frame.text

        worker.add_reached_downstream_filter((TranscriptionFrame,))
        try:
            await runner.add_workers(worker)
            runner_task = asyncio.create_task(runner.run())
            active.runner_task = runner_task
            if runner_task.done():
                await runner_task
                raise RuntimeError("Pipecat capture pipeline stopped before it started.")
            await asyncio.wait_for(started.wait(), timeout=10)
            active.pipeline_ready_ms = (time.monotonic() - active.started_at) * 1000
            await worker.queue_frame(VADUserStartedSpeakingFrame())
            self._emit({"type": "capture-ready", "captureId": current_capture_id})
        except BaseException:
            await runner.cancel(reason="Pipecat capture startup failed")
            if active.runner_task is not None:
                await asyncio.gather(active.runner_task, return_exceptions=True)
            if self.capture is active:
                self.capture = None
            raise

    async def _pcm(self, command: dict[str, object]) -> None:
        active = self._active_capture(command, "PCM")
        if active.cancelled:
            raise ProtocolError("Capture cancellation is already in progress.")
        if active.status != "capturing":
            raise ProtocolError("Capture is already being transcribed.")
        sequence = nonnegative_integer(command, "sequence", 2**31 - 1)
        if sequence != active.expected_sequence:
            raise ProtocolError("PCM sequence is stale or out of order.")
        if positive_integer(command, "sampleRate", 384_000) != active.sample_rate:
            raise ProtocolError("PCM sample rate changed during capture.")
        if positive_integer(command, "channels", 32) != active.channels:
            raise ProtocolError("PCM channel count changed during capture.")
        audio = decode_pcm(command.get("data"))
        from .parakeet import downmix_pcm
        from pipecat.frames.frames import InputAudioRawFrame

        mono_audio = downmix_pcm(audio, active.channels)
        if active.first_audio_ms is None:
            active.first_audio_ms = (time.monotonic() - active.started_at) * 1000
        active.input_audio_bytes += len(audio)
        await active.worker.queue_frame(
            InputAudioRawFrame(
                audio=mono_audio,
                sample_rate=active.sample_rate,
                num_channels=1,
            )
        )
        active.chunk_count += 1
        active.expected_sequence += 1

    def _begin_release(self, command: dict[str, object]) -> None:
        active = self._active_capture(command, "release")
        if active.cancelled:
            raise ProtocolError("Capture cancellation is already in progress.")
        if active.status != "capturing":
            raise ProtocolError("Capture release is already in progress.")
        active.status = "releasing"
        active.release_task = asyncio.create_task(self._release(active))
        active.release_task.add_done_callback(lambda task: self._observe_release(active, task))

    def _observe_release(self, active: Capture, task: asyncio.Task[None]) -> None:
        try:
            task.result()
        except asyncio.CancelledError:
            pass
        except Exception as error:
            if active.cancelled:
                self._finish(
                    active,
                    {
                        "ok": False,
                        "message": "Voice capture was cancelled.",
                        "code": "cancelled",
                    },
                )
                return
            self._finish(
                active,
                {"ok": False, "message": str(error), "code": "transcription-failed"},
            )

    def _finish(self, active: Capture, result: dict[str, object]) -> None:
        if self.capture is not active or active.terminal_emitted:
            return
        active.terminal_emitted = True
        self._emit({"type": "capture-result", "captureId": active.capture_id, **result})
        self.capture = None

    async def _release(self, active: Capture) -> None:
        if active.runner_task is None:
            raise RuntimeError("Pipecat capture pipeline was not started.")
        from pipecat.frames.frames import VADUserStoppedSpeakingFrame

        released_at = time.monotonic()
        await active.worker.queue_frame(VADUserStoppedSpeakingFrame(stop_secs=0))
        await active.worker.stop_when_done()
        await active.runner_task
        text = active.transcript or ""
        finished_at = time.monotonic()
        transcription_ms = (finished_at - released_at) * 1000
        total_ms = (finished_at - active.started_at) * 1000
        if active.cancelled:
            self._finish(
                active,
                {"ok": False, "message": "Voice capture was cancelled.", "code": "cancelled"},
            )
            return
        if not text:
            self._finish(
                active,
                {
                    "ok": False,
                    "message": "I didn't hear a complete instruction. Try again.",
                    "code": "transcription-failed",
                },
            )
            return
        self._emit({"type": "transcript", "captureId": active.capture_id, "text": text})
        timing: dict[str, object] = {
            "engineId": "pipecat-parakeet-tdt-ctc-110m-int8",
            "captureId": active.capture_id,
            "start": active.start,
            "modelLoadMs": active.model_load_ms,
            "pipelineReadyMs": active.pipeline_ready_ms,
            "firstAudioMs": active.first_audio_ms or 0.0,
            "captureMs": max(0.0, total_ms - transcription_ms),
            "releaseToTranscriptMs": transcription_ms,
            "resampleMs": active.service.resample_ms,
            "decodeMs": active.service.decode_ms,
            "totalMs": total_ms,
            "audioDurationMs": active.input_audio_bytes
                / (active.sample_rate * active.channels * 2)
                * 1000,
            "audioBytes": active.input_audio_bytes,
            "chunkCount": active.chunk_count,
        }
        timing["peakRssBytes"] = peak_rss_bytes()
        self._emit({"type": "stt-timing", "timing": timing})
        self._finish(active, {"ok": True, "text": text})

    def _begin_cancel(self, command: dict[str, object]) -> None:
        active = self._active_capture(command, "cancel")
        if active.cancelled:
            raise ProtocolError("Capture cancellation is already in progress.")
        active.cancelled = True
        active.cancel_task = asyncio.create_task(self._cancel(active))
        active.cancel_task.add_done_callback(lambda task: self._observe_cancel(active, task))

    def _observe_cancel(self, active: Capture, task: asyncio.Task[None]) -> None:
        try:
            task.result()
        except asyncio.CancelledError:
            pass
        except Exception:
            self._finish(
                active,
                {"ok": False, "message": "Voice capture was cancelled.", "code": "cancelled"},
            )

    async def _cancel(self, active: Capture) -> None:
        if not active.worker.has_finished():
            await active.worker.cancel(reason="Jarvis capture cancelled")
        if active.release_task is not None:
            await active.release_task
        else:
            if active.runner_task is not None:
                await active.runner_task
            self._finish(
                active,
                {"ok": False, "message": "Voice capture was cancelled.", "code": "cancelled"},
            )

    async def _shutdown_capture(self) -> None:
        active = self.capture
        if active is None:
            return
        if not active.cancelled:
            active.cancelled = True
            active.cancel_task = asyncio.create_task(self._cancel(active))
            active.cancel_task.add_done_callback(lambda task: self._observe_cancel(active, task))
        if active.cancel_task is not None:
            await active.cancel_task


async def run() -> None:
    expected_version = int(os.environ.get("JARVIS_PIPECAT_PROTOCOL_VERSION", str(PROTOCOL_VERSION)))
    if expected_version != PROTOCOL_VERSION:
        emit({"type": "fatal", "message": "Pipecat protocol version mismatch."})
        return
    model_load_started = time.monotonic()
    model_root = Path(os.environ["JARVIS_PIPECAT_MODEL_ROOT"])
    from .parakeet import create_recognizer

    recognizer = create_recognizer(model_root)
    runtime = Runtime(
        model_root,
        kokoro_root=(
            Path(os.environ["JARVIS_PIPECAT_KOKORO_ROOT"])
            if os.environ.get("JARVIS_PIPECAT_KOKORO_ROOT")
            else None
        ),
        recognizer=recognizer,
        model_load_ms=(time.monotonic() - model_load_started) * 1000,
    )
    emit({"type": "ready", "version": PROTOCOL_VERSION})
    tasks: set[asyncio.Task[bool]] = set()
    capture_tail: asyncio.Task[bool] | None = None

    def dispatch(command: dict[str, object]) -> asyncio.Task[bool]:
        nonlocal capture_tail
        capture_command = command.get("type") in {
            "capture-start",
            "pcm",
            "capture-release",
            "capture-cancel",
        }
        ordered = capture_command or command.get("type") == "shutdown"
        predecessor = capture_tail

        async def execute() -> bool:
            if ordered and predecessor is not None:
                await asyncio.shield(predecessor)
            return await runtime.command(command)

        task = asyncio.create_task(execute())
        tasks.add(task)
        task.add_done_callback(tasks.discard)
        if capture_command:
            capture_tail = task
        return task

    while True:
        line = await asyncio.to_thread(read_bounded_line, sys.stdin.buffer)
        if not line:
            break
        if len(line) > MAX_LINE_BYTES:
            emit({"type": "fatal", "message": "Pipecat input record is oversized."})
            break
        try:
            command = parse_command(line)
        except ProtocolError as error:
            emit({"type": "error", "message": str(error)})
            continue
        task = dispatch(command)
        if command.get("type") == "shutdown":
            await task
            break
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
