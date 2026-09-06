import asyncio
import threading
import json
import io
import unittest
import tempfile
import struct
from pathlib import Path
from unittest.mock import patch

from jarvis_voice_runtime.pocket import (
    PocketDaemon,
    JarvisPocketTTSService,
    DaemonError,
)
from jarvis_voice_runtime.runtime import Runtime


class Regressions(unittest.IsolatedAsyncioTestCase):
    async def test_pcm_reaches_service_before_daemon_terminal(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "chunk.wav"
            data = struct.pack("<480f", *([0.2] * 480))
            path.write_bytes(
                struct.pack(
                    "<4sI4s4sIHHIIHH4sI",
                    b"RIFF",
                    36 + len(data),
                    b"WAVE",
                    b"fmt ",
                    16,
                    3,
                    1,
                    24000,
                    96000,
                    4,
                    32,
                    b"data",
                    len(data),
                )
                + data
            )
            release = threading.Event()
            waiting = threading.Event()
            request = {}
            calls = 0

            class Stdout:
                def readline(self):
                    nonlocal calls
                    calls += 1
                    if calls == 1:
                        target = Path(request["outputDirectory"]) / "chunk.wav"
                        target.write_bytes(path.read_bytes())
                        return (
                            json.dumps(
                                {
                                    "type": "chunk",
                                    "requestId": request["requestId"],
                                    "index": 0,
                                    "path": str(target),
                                }
                            )
                            + "\n"
                        )
                    waiting.set()
                    release.wait(3)
                    return (
                        json.dumps(
                            {
                                "type": "synthesis-finished",
                                "requestId": request["requestId"],
                                "sampleRate": 24000,
                                "chunkCount": 1,
                            }
                        )
                        + "\n"
                    )

            with patch("jarvis_voice_runtime.pocket.validate_pocket_root"):
                daemon = PocketDaemon(Path(d))
            daemon._send = lambda c: request.update(c)
            daemon.current_rss_bytes = lambda: 0
            daemon._process = type("Process", (), {"stdout": Stdout()})()
            native = type(
                "Native",
                (),
                {
                    "daemon": daemon,
                    "sample_rate": 24000,
                    "ensure_running": lambda self: None,
                },
            )()
            service = JarvisPocketTTSService(native)
            stream = service.run_tts("Done.", "ctx")
            first = asyncio.create_task(anext(stream))
            try:
                await asyncio.to_thread(waiting.wait, 1)
                try:
                    await asyncio.wait_for(asyncio.shield(first), 0.1)
                except asyncio.TimeoutError:
                    pass
                self.assertTrue(
                    first.done(),
                    "No PCM delivered while the daemon withholds its terminal event",
                )
            finally:
                release.set()
                await first
                async for _ in stream:
                    pass

    async def test_abandoned_native_handle_is_closed(self):
        class Native:
            closed = False

            def close(self):
                self.closed = True

        native = Native()

        def factory(_):
            runtime._shutdown_requested = True
            return native

        runtime = Runtime(Path("/tmp"), pocket_root=Path("/tmp"), tts_factory=factory)
        await runtime._prepare_speech(remote=True)
        self.assertTrue(native.closed, "A created daemon must close when shutdown wins preparation")

    async def test_ready_pipe_on_windows_is_supported(self):
        class Process:
            stdin = io.StringIO()
            stdout = io.StringIO('{"type":"ready"}\n')
            stderr = io.StringIO()

            def poll(self):
                return None

            def kill(self):
                pass

        with (
            patch("jarvis_voice_runtime.pocket.validate_pocket_root"),
            patch("jarvis_voice_runtime.pocket.subprocess.Popen", return_value=Process()),
            patch("jarvis_voice_runtime.pocket.DAEMON_STARTUP_TIMEOUT_SECS", 0.01),
        ):
            daemon = PocketDaemon(Path("/tmp"))
            try:
                daemon.start()
            except DaemonError as error:
                self.fail("Ready daemon rejected by Windows pipe handling: " + str(error))

    async def test_cancel_reaches_daemon_before_any_audio(self):
        started = threading.Event()
        cancelled_at_daemon = threading.Event()

        class Daemon:
            def synthesize(self, request_id, text, directory, cancelled, on_chunk):
                started.set()
                cancelled_at_daemon.wait(2)
                return None

            def cancel(self, request_id):
                cancelled_at_daemon.set()

        native = type(
            "Native",
            (),
            {"daemon": Daemon(), "sample_rate": 24000, "ensure_running": lambda self: None},
        )()
        service = JarvisPocketTTSService(native)
        stream = service.run_tts("Please stop.", "context")
        first = asyncio.create_task(anext(stream))
        await asyncio.to_thread(started.wait, 1)
        await asyncio.wait_for(service.cancel_generation(), 1)
        self.assertTrue(cancelled_at_daemon.is_set())
        with self.assertRaises(StopAsyncIteration):
            await first

    async def test_output_constructor_failure_closes_prepared_handle(self):
        from test_pocket_runtime import _FakeHandle

        handle = _FakeHandle()
        runtime = Runtime(
            Path("/tmp"),
            pocket_root=Path("/tmp"),
            tts_factory=lambda _: handle,
            speech_output_factory=lambda _: (_ for _ in ()).throw(RuntimeError("no output")),
        )
        with self.assertRaisesRegex(RuntimeError, "no output"):
            await runtime._prepare_speech()
        self.assertEqual(handle.daemon.close_count, 1)

    def test_sherpa_sessions_receive_nonspinning_config(self):
        import sys
        from types import SimpleNamespace
        from jarvis_voice_runtime.parakeet import create_recognizer

        providers = []

        def construct(**config):
            path = Path(config["provider"].split(":", 1)[1])
            providers.append(path.read_text())
            return object()

        fake = SimpleNamespace(OfflineRecognizer=SimpleNamespace(from_transducer=construct))
        with (
            patch.dict(sys.modules, {"sherpa_onnx": fake}),
            patch("jarvis_voice_runtime.parakeet.validate_model_root"),
        ):
            create_recognizer(Path("/tmp"))
        self.assertEqual(
            providers,
            [
                "SessionConfig.session.intra_op.allow_spinning=0\nSessionConfig.session.inter_op.allow_spinning=0\n"
            ],
        )


if __name__ == "__main__":
    unittest.main()
