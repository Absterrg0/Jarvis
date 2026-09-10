from __future__ import annotations

import asyncio
import json
import queue
import struct
import subprocess
import tempfile
import threading
import time
from array import array
from collections.abc import AsyncGenerator, Callable
from pathlib import Path
from typing import Protocol

from pipecat.frames.frames import Frame, TTSAudioRawFrame
from pipecat.services.tts_service import TextAggregationMode
from pipecat.services.settings import TTSSettings
from pipecat.services.tts_service import TTSService

from .onset import (
    ONSET_MAX_TRIM_MS,
    ONSET_PREROLL_MS,
    ONSET_THRESHOLD_DBFS,
    ONSET_WINDOW_MS,
    POCKET_SAMPLE_RATE,
    StreamOnset,
)

POCKET_NUM_THREADS = 2
POCKET_TEMPERATURE = 0.3
POCKET_LSD_STEPS = 1
POCKET_FIRST_CHUNK_FRAMES = 1
POCKET_MAX_CHUNK_FRAMES = 3
POCKET_BUNDLE = "english_2026-04"
POCKET_VOICE_FILE = "alba-casual-3s.wav"
MAX_PENDING_AUDIO_CHUNKS = 8
DAEMON_STARTUP_TIMEOUT_SECS = 30.0
DAEMON_CLOSE_TIMEOUT_SECS = 5.0


class DaemonError(RuntimeError):
    """The Pocket daemon failed instead of producing audio."""


def _daemon_name() -> str:
    import sys

    return "jarvis-pocket-tts.exe" if sys.platform == "win32" else "jarvis-pocket-tts"


def validate_pocket_root(pocket_root: Path) -> None:
    required_files = (
        "models/text_conditioner.onnx",
        "models/flow_lm_main_int8.onnx",
        "models/flow_lm_flow.onnx",
        "models/mimi_decoder.onnx",
        "models/mimi_encoder.onnx",
        "models/bos_before_voice.f32",
        "models/tokenizer.model",
        "models/bundle.json",
        f"voices/{POCKET_VOICE_FILE}",
        "PROVENANCE.json",
    )
    missing = next((name for name in required_files if not (pocket_root / name).is_file()), None)
    if missing is not None:
        raise RuntimeError(f"Bundled Pocket resource is missing: {missing}.")
    daemon = pocket_root / "bin" / _daemon_name()
    if not daemon.is_file():
        raise RuntimeError("Bundled Pocket speech runtime is missing. Reinstall ARIS.")


def _int16_mono(samples: list[float]) -> bytes:
    """Convert float samples to little-endian signed mono PCM."""
    pcm = array(
        "h",
        (
            round(max(-1.0, min(1.0, float(value))) * (32_768 if float(value) < 0 else 32_767))
            for value in samples
        ),
    )
    if pcm.itemsize != 2:
        raise RuntimeError("The platform does not use 16-bit signed PCM.")
    if __import__("sys").byteorder != "little":
        pcm.byteswap()
    return pcm.tobytes()


def _read_float_wav(path: str) -> list[float]:
    """Read a daemon chunk file without numpy (unavailable in the frozen host).

    The daemon writes true IEEE-float WAVs, which the stdlib wave module
    refuses to read, so the header is parsed directly.
    """
    with open(path, "rb") as handle:
        riff = handle.read(12)
        if len(riff) < 12 or riff[0:4] != b"RIFF" or riff[8:12] != b"WAVE":
            raise DaemonError(f"Pocket chunk is not a WAV file: {path}")
        audio_format = 0
        channels = 0
        sampwidth = 0
        sample_rate = 0
        data = b""
        while True:
            header = handle.read(8)
            if len(header) < 8:
                break
            chunk_id, chunk_size = struct.unpack("<4sI", header)
            body = handle.read(chunk_size + (chunk_size % 2))
            if chunk_id == b"fmt " and len(body) >= 16:
                audio_format, channels, sample_rate, _, _, sampwidth = struct.unpack(
                    "<HHIIHH", body[:16]
                )
                sampwidth //= 8
            elif chunk_id == b"data":
                data = body[:chunk_size]
    if sample_rate != POCKET_SAMPLE_RATE:
        raise DaemonError(f"Pocket chunk changed sample rate: {sample_rate}")
    if channels != 1 or not data:
        raise DaemonError(f"Pocket chunk has no mono audio: {path}")
    if audio_format == 3 and sampwidth == 4:
        count = len(data) // 4
        return list(struct.unpack(f"<{count}f", data[: count * 4]))
    if audio_format == 1 and sampwidth == 2:
        count = len(data) // 2
        return [value / 32_768 for value in struct.unpack(f"<{count}h", data[: count * 2])]
    raise DaemonError(f"Pocket chunk has unsupported audio format: {path}")


class PocketDaemon:
    """Owns one jarvis-pocket-tts process: load once, one active synthesis."""

    def __init__(self, pocket_root: Path) -> None:
        pocket_root = pocket_root.resolve()
        validate_pocket_root(pocket_root)
        self._models = str(pocket_root / "models")
        self._voice = str(pocket_root / "voices" / POCKET_VOICE_FILE)
        self._daemon = str(pocket_root / "bin" / _daemon_name())
        self._process: subprocess.Popen[str] | None = None
        self._stderr_tail = ""
        self._lock = threading.Lock()
        self._synthesis_lock = threading.Lock()
        self._write_lock = threading.Lock()

    def start(self) -> None:
        with self._lock:
            if self._process is not None:
                return
            process = subprocess.Popen(
                [self._daemon, "--models", self._models, "--voice", self._voice],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
            )
            assert process.stdin is not None and process.stdout is not None
            startup: queue.Queue[str | Exception] = queue.Queue(maxsize=1)

            def read_ready() -> None:
                try:
                    while line := process.stdout.readline():
                        event = json.loads(line)
                        if isinstance(event, dict) and event.get("type") == "ready":
                            startup.put("")
                            return
                        if isinstance(event, dict) and event.get("type") == "startup-failed":
                            raise DaemonError(str(event.get("message", "Pocket startup failed.")))
                    raise DaemonError("Pocket exited before becoming ready.")
                except Exception as error:
                    startup.put(error)

            reader = threading.Thread(target=read_ready, daemon=True)
            stderr_reader = threading.Thread(
                target=self._watch_stderr, args=(process,), daemon=True
            )
            self._stderr_tail = ""
            reader.start()
            stderr_reader.start()
            try:
                result = startup.get(timeout=DAEMON_STARTUP_TIMEOUT_SECS)
                if isinstance(result, Exception):
                    raise DaemonError(str(result)) from result
            except (queue.Empty, DaemonError) as error:
                process.kill()
                process.wait(timeout=DAEMON_CLOSE_TIMEOUT_SECS)
                reader.join(timeout=DAEMON_CLOSE_TIMEOUT_SECS)
                stderr_reader.join(timeout=DAEMON_CLOSE_TIMEOUT_SECS)
                detail = self._stderr_tail.strip()[-1024:]
                raise DaemonError(detail or "Pocket speech runtime failed to warm.") from error
            self._process = process

    def _watch_stderr(self, process: subprocess.Popen[str]) -> None:
        try:
            assert process.stderr is not None
            for line in process.stderr:
                self._stderr_tail = f"{self._stderr_tail}{line}"[-4096:]
        except (OSError, ValueError):
            pass

    @property
    def running(self) -> bool:
        process = self._process
        return process is not None and process.poll() is None

    def current_rss_bytes(self) -> int:
        process = self._process
        if process is None:
            return 0
        try:
            import os

            return int(Path(f"/proc/{process.pid}/statm").read_text().split()[1]) * os.sysconf(
                "SC_PAGE_SIZE"
            )
        except (OSError, ValueError, IndexError):
            return 0

    def _send(self, command: dict[str, object]) -> None:
        process = self._process
        if process is None or process.poll() is not None or process.stdin is None:
            raise DaemonError("Pocket speech runtime is not running.")
        try:
            with self._write_lock:
                process.stdin.write(json.dumps(command, ensure_ascii=False) + "\n")
                process.stdin.flush()
        except (BrokenPipeError, OSError) as error:
            raise DaemonError("Pocket speech runtime stopped.") from error

    def synthesize(
        self,
        request_id: str,
        text: str,
        output_directory: str,
        cancelled: threading.Event,
        on_chunk: Callable[[str], None],
    ) -> dict[str, object] | None:
        """Deliver each chunk before reading the next; drain cancellation before reuse."""
        if not self._synthesis_lock.acquire(blocking=False):
            raise DaemonError("Pocket received overlapping synthesis work.")
        try:
            if cancelled.is_set():
                return None
            self._send(
                {
                    "type": "synthesize",
                    "requestId": request_id,
                    "text": text,
                    "outputDirectory": output_directory,
                }
            )
            process = self._process
            assert process is not None and process.stdout is not None
            expected = 0
            failure: Exception | None = None
            while True:
                if cancelled.is_set() or failure is not None:
                    self.cancel(request_id)
                line = process.stdout.readline()
                if not line:
                    raise DaemonError("Pocket speech runtime stopped.")
                event = json.loads(line)
                if not isinstance(event, dict) or event.get("requestId") != request_id:
                    raise DaemonError("Pocket returned an unexpected request.")
                kind = event.get("type")
                if kind == "chunk":
                    index, path = event.get("index"), event.get("path")
                    if index != expected or not isinstance(path, str):
                        failure = DaemonError("Pocket chunks arrived out of order.")
                    else:
                        expected += 1
                        try:
                            if not cancelled.is_set() and failure is None:
                                on_chunk(path)
                        except Exception as error:
                            failure = error
                elif kind in ("synthesis-finished", "cancelled", "failed"):
                    if failure is not None:
                        raise failure
                    if kind == "failed":
                        raise DaemonError(str(event.get("message", "Pocket synthesis failed.")))
                    if kind == "cancelled" or cancelled.is_set():
                        return None
                    if (
                        event.get("chunkCount") != expected
                        or event.get("sampleRate") != POCKET_SAMPLE_RATE
                    ):
                        raise DaemonError(
                            "Pocket terminal audio metadata does not match its chunks."
                        )
                    return event
        except Exception:
            # Protocol failures cannot leave a partially drained stream reusable.
            self.close()
            raise
        finally:
            self._synthesis_lock.release()

    def cancel(self, request_id: str) -> None:
        try:
            self._send({"type": "cancel", "requestId": request_id})
        except DaemonError:
            pass

    def close(self) -> None:
        with self._lock:
            process, self._process = self._process, None
        if process is None:
            return
        try:
            if process.poll() is None and process.stdin is not None:
                try:
                    with self._write_lock:
                        process.stdin.write('{"type":"shutdown"}\n')
                        process.stdin.flush()
                except (BrokenPipeError, OSError):
                    pass
            try:
                process.wait(timeout=DAEMON_CLOSE_TIMEOUT_SECS)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=DAEMON_CLOSE_TIMEOUT_SECS)
        except (OSError, ValueError):
            pass


class PocketNativeHandle:
    """Resident model behind the Pipecat adapter: one daemon, one synthesis."""

    def __init__(self, pocket_root: Path) -> None:
        self.sample_rate = POCKET_SAMPLE_RATE
        self._daemon = PocketDaemon(pocket_root)
        self._daemon.start()

    @property
    def daemon(self) -> PocketDaemon:
        return self._daemon

    def ensure_running(self) -> None:
        if not self._daemon.running:
            self._daemon.close()
            self._daemon.start()

    def close(self) -> None:
        self._daemon.close()


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
        self.sampled_peak_rss_bytes = 0
        self.current_total_rss_bytes = 0
        self.native_cpu_ms = 0.0
        self.native_synthesis_ms = 0.0


def create_pocket_tts(pocket_root: Path) -> PocketNativeHandle:
    return PocketNativeHandle(pocket_root)


class JarvisPocketTTSService(TTSService):
    """Pipecat TTS service backed by one resident Pocket daemon process.

    Desktop submits each response as one finalized ``TTSSpeakFrame``. Sentence
    mode keeps Pipecat from invoking its streaming tokenizer for that already
    bounded utterance. The frozen audio host therefore does not need NLTK.
    ``push_text_frames`` stays enabled because this adapter does not provide
    word timestamps; Pipecat must preserve the text-frame contract downstream.

    Raw daemon chunks pass through the bounded leading-silence filter before
    playback, and are announced strictly in daemon order: the terminal event
    is only honored after every pending write, so the reported count always
    matches the announced chunks.
    """

    def __init__(self, tts: PocketNativeHandle, *, sample_rate: int | None = None) -> None:
        super().__init__(
            push_text_frames=True,
            push_stop_frames=True,
            push_start_frame=True,
            text_aggregation_mode=TextAggregationMode.SENTENCE,
            sample_rate=sample_rate or int(tts.sample_rate),
            settings=TTSSettings(model="pocket-2026-04", voice="alba-casual", language="en"),
        )
        self._tts = tts
        self._generation_task: asyncio.Task[GenerationMetrics] | None = None
        self._cancel_generation = threading.Event()
        self.last_metrics: GenerationMetrics | None = None
        self._request_id: str | None = None

    @property
    def native_tts(self) -> PocketNativeHandle:
        """Return the resident model when only the audio sink must change."""
        return self._tts

    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame | None, None]:
        del context_id
        self.last_metrics = None
        pending: queue.Queue[bytes | None] = queue.Queue(maxsize=MAX_PENDING_AUDIO_CHUNKS)
        cancelled = self._cancel_generation
        cancelled.clear()
        metrics = GenerationMetrics(int(self._tts.sample_rate))
        native_started = time.monotonic()
        native_cpu_started = time.process_time()
        gate = StreamOnset(
            sample_rate=POCKET_SAMPLE_RATE,
            threshold_dbfs=ONSET_THRESHOLD_DBFS,
            window_ms=ONSET_WINDOW_MS,
            preroll_ms=ONSET_PREROLL_MS,
            max_trim_ms=ONSET_MAX_TRIM_MS,
        )

        def enqueue_audio(audio: bytes) -> bool:
            if not audio:
                return not cancelled.is_set()
            while not cancelled.is_set():
                try:
                    pending.put(audio, timeout=0.05)
                    metrics.chunk_count += 1
                    metrics.total_samples += len(audio) // 2
                    if metrics.first_chunk_ms is None:
                        metrics.first_chunk_ms = (time.monotonic() - native_started) * 1000
                    return True
                except queue.Full:
                    continue
            return False

        def sample_memory() -> None:
            import os

            try:
                native_rss = self._tts.daemon.current_rss_bytes()
                if native_rss <= 0:
                    return
                host_rss = int(Path("/proc/self/statm").read_text().split()[1]) * os.sysconf(
                    "SC_PAGE_SIZE"
                )
                metrics.current_total_rss_bytes = host_rss + native_rss
                metrics.sampled_peak_rss_bytes = max(
                    metrics.sampled_peak_rss_bytes, metrics.current_total_rss_bytes
                )
            except (OSError, ValueError, IndexError):
                pass

        def generate() -> GenerationMetrics:
            request_id = f"pocket-{time.monotonic_ns()}"
            try:
                with tempfile.TemporaryDirectory(prefix="jarvis-pocket-") as output_directory:
                    self._tts.ensure_running()
                    self._request_id = request_id

                    def accept_chunk(path: str) -> None:
                        sample_memory()
                        chunk = Path(path)
                        if chunk.parent.resolve() != Path(output_directory).resolve():
                            raise DaemonError(
                                "Pocket returned a chunk outside its request directory."
                            )
                        try:
                            samples = _read_float_wav(path)
                            filtered = gate.push(samples)
                            if filtered:
                                enqueue_audio(_int16_mono(filtered))
                        finally:
                            chunk.unlink(missing_ok=True)

                    terminal = self._tts.daemon.synthesize(
                        request_id, text, output_directory, cancelled, accept_chunk
                    )
                    if cancelled.is_set():
                        return metrics
                    tail = gate.finish()
                    if tail and not enqueue_audio(_int16_mono(tail)):
                        return metrics
                    if terminal is None:
                        raise DaemonError("Pocket synthesis did not finish.")
                    sample_memory()
                    metrics.native_cpu_ms = float(terminal.get("synthesisCpuMs", 0))
                    metrics.native_synthesis_ms = float(terminal.get("synthesisDurationMs", 0))
                    metrics.peak_rss_bytes = int(terminal.get("peakRssBytes", 0))
                    metrics.sample_rate = int(terminal.get("sampleRate", metrics.sample_rate))
                    return metrics
            finally:
                self._request_id = None
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
        # One utterance, one rate: snapshot the rate for every frame instead
        # of rereading it per frame mid-stream.
        frame_sample_rate = metrics.sample_rate
        try:
            while True:
                item = await asyncio.to_thread(pending.get)
                if item is None:
                    break
                yield TTSAudioRawFrame(
                    audio=item,
                    sample_rate=frame_sample_rate,
                    num_channels=1,
                )
            result = await native_task
            self.last_metrics = result
            if not cancelled.is_set() and result.total_samples == 0:
                raise RuntimeError("Pocket produced no audio for the requested utterance.")
        except asyncio.CancelledError:
            await self.cancel_generation()
            raise
        finally:
            cancelled.set()
            if not native_task.done():
                await self.cancel_generation()
            self._generation_task = None

    async def cancel_generation(self) -> None:
        self._cancel_generation.set()
        # Claim the request id atomically: concurrent cancels must not
        # dispatch twice for one request, cancel a completed request, or pick
        # up a newer generation's id after the finally below clears it.
        request_id, self._request_id = self._request_id, None
        task = self._generation_task
        if request_id is not None:
            await asyncio.to_thread(self._tts.daemon.cancel, request_id)
        if task is not None:
            try:
                await asyncio.wait_for(asyncio.shield(task), timeout=2.0)
            except asyncio.TimeoutError:
                await asyncio.to_thread(self._tts.close)
                await asyncio.gather(task, return_exceptions=True)


PocketTTSService = JarvisPocketTTSService


__all__ = [
    "DAEMON_CLOSE_TIMEOUT_SECS",
    "DAEMON_STARTUP_TIMEOUT_SECS",
    "MAX_PENDING_AUDIO_CHUNKS",
    "ONSET_MAX_TRIM_MS",
    "ONSET_PREROLL_MS",
    "ONSET_THRESHOLD_DBFS",
    "ONSET_WINDOW_MS",
    "POCKET_BUNDLE",
    "POCKET_FIRST_CHUNK_FRAMES",
    "POCKET_LSD_STEPS",
    "POCKET_MAX_CHUNK_FRAMES",
    "POCKET_NUM_THREADS",
    "POCKET_SAMPLE_RATE",
    "POCKET_TEMPERATURE",
    "POCKET_VOICE_FILE",
    "DaemonError",
    "JarvisPocketTTSService",
    "PocketDaemon",
    "PocketNativeHandle",
    "PocketTTSService",
    "create_pocket_tts",
    "validate_pocket_root",
]
