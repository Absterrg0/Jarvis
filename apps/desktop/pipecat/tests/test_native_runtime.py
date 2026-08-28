from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

from native_runtime import resolve_native_onnx_runtime  # noqa: E402


class NativeRuntimeTest(unittest.TestCase):
    def test_matches_the_installed_desktop_sherpa_runtime(self) -> None:
        repository_root = Path(__file__).resolve().parents[4]
        runtime = resolve_native_onnx_runtime(repository_root)

        self.assertEqual(runtime.version, "1.13.6")
        self.assertEqual(runtime.onnx_runtime_version, "1.27.1")
        self.assertTrue(runtime.library.is_file())
        self.assertIn(runtime.package_name, runtime.library.parts)

    def test_source_stt_runtime_does_not_import_the_jarvis_tts_stack(self) -> None:
        project_root = Path(__file__).resolve().parents[1]
        forbidden = (
            "jarvis_voice_runtime.kokoro",
            "jarvis_voice_runtime.output",
            "pipecat.services.tts_service",
            "pipecat.transports.base_output",
            "PIL",
            "nltk",
        )
        script = (
            "import sys; import jarvis_voice_runtime.runtime; "
            f"forbidden={forbidden!r}; "
            "loaded=[name for name in forbidden if name in sys.modules]; "
            "raise SystemExit('eager TTS imports: ' + ', '.join(loaded) if loaded else 0)"
        )

        result = subprocess.run(
            [sys.executable, "-c", script],
            cwd=project_root,
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
