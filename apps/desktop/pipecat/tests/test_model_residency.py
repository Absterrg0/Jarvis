from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from jarvis_voice_runtime.runtime import Runtime
from jarvis_voice_runtime.residency import use_resident_models
from test_pocket_runtime import _FakeHandle, _Recognizer


class ModelResidencyTest(unittest.IsolatedAsyncioTestCase):
    async def test_resident_handoff_reuses_models_and_shutdown_closes_daemon(self) -> None:
        handle = _FakeHandle()
        recognizer = _Recognizer()
        with tempfile.TemporaryDirectory() as directory:
            runtime = Runtime(
                Path(directory),
                pocket_root=Path(directory),
                recognizer=recognizer,
                tts_factory=lambda _: handle,
                retain_models=True,
                output=lambda _: None,
            )
            with (
                patch(
                    "jarvis_voice_runtime.residency.available_memory",
                    return_value=(16 * 1024**3, 4 * 1024**3),
                ),
                patch("jarvis_voice_runtime.runtime.current_rss_bytes", return_value=400 * 1024**2),
            ):
                try:
                    await runtime._prepare_speech(remote=True)
                    self.assertIs(runtime._recognizer, recognizer)
                    runtime._desired_model = "parakeet"
                    await runtime._activate_parakeet()
                    self.assertIs(runtime._tts.native_tts, handle)
                    await runtime._prepare_speech(remote=True)
                    self.assertIs(runtime._recognizer, recognizer)
                    self.assertEqual(handle.daemon.close_count, 0)
                finally:
                    await runtime.command({"type": "shutdown", "requestId": "bye"})
            self.assertEqual(handle.daemon.close_count, 1)
            self.assertIsNone(runtime._recognizer)

    async def test_budget_failure_evicts_inactive_recognizer(self) -> None:
        handle = _FakeHandle()
        with tempfile.TemporaryDirectory() as directory:
            runtime = Runtime(
                Path(directory),
                pocket_root=Path(directory),
                recognizer=_Recognizer(),
                tts_factory=lambda _: handle,
                retain_models=True,
                output=lambda _: None,
            )
            with (
                patch(
                    "jarvis_voice_runtime.residency.available_memory",
                    return_value=(16 * 1024**3, 4 * 1024**3),
                ),
                patch("jarvis_voice_runtime.runtime.current_rss_bytes", return_value=900 * 1024**2),
            ):
                try:
                    await runtime._prepare_speech(remote=True)
                    self.assertIsNone(runtime._recognizer)
                    self.assertFalse(runtime._retain_models)
                    self.assertEqual(handle.daemon.close_count, 0)
                finally:
                    await runtime.command({"type": "shutdown", "requestId": "bye"})

    async def test_retention_does_not_allow_speech_during_capture_start(self) -> None:
        from jarvis_voice_runtime.protocol import ProtocolError

        runtime = Runtime(Path("/tmp"), retain_models=True)
        runtime._capture_starting = True
        with self.assertRaises(ProtocolError):
            await runtime._begin_speech({"speechId": "unsafe", "text": "Do not overlap."})

    def test_residency_requires_known_headroom_and_honors_single_mode(self) -> None:
        with patch(
            "jarvis_voice_runtime.residency.available_memory",
            return_value=(16 * 1024**3, 4 * 1024**3),
        ):
            with patch.dict("os.environ", {"JARVIS_VOICE_MODEL_RESIDENCY": "single"}):
                self.assertFalse(use_resident_models())
        with patch(
            "jarvis_voice_runtime.residency.available_memory", return_value=(16 * 1024**3, 1024**3)
        ):
            self.assertFalse(use_resident_models())
        with patch("jarvis_voice_runtime.residency.available_memory", return_value=(0, 0)):
            self.assertFalse(use_resident_models())
