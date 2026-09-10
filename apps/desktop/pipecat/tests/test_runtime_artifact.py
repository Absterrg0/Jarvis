from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

from runtime_artifact import MAX_RUNTIME_BYTES, inspect_runtime_artifact  # noqa: E402


class RuntimeArtifactTest(unittest.TestCase):
    def test_accepts_the_minimal_audio_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "libonnxruntime.so").write_bytes(b"runtime")

            artifact = inspect_runtime_artifact(root)

            self.assertEqual(artifact.size_bytes, len(b"runtime"))

    def test_rejects_unused_pipecat_dependency_closures(self) -> None:
        for dependency in ("PIL", "nltk_data", "pillow.libs", "scipy", "scipy.libs"):
            with self.subTest(dependency=dependency), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / "libonnxruntime.so").write_bytes(b"runtime")
                (root / dependency).mkdir()

                with self.assertRaisesRegex(RuntimeError, dependency.replace(".", r"\.")):
                    inspect_runtime_artifact(root)

    def test_rejects_an_artifact_over_the_install_budget(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "libonnxruntime.so").write_bytes(b"runtime")
            oversized = root / "oversized.bin"
            with oversized.open("wb") as file:
                file.seek(MAX_RUNTIME_BYTES)
                file.write(b"x")

            with self.assertRaisesRegex(RuntimeError, "180 MiB install budget"):
                inspect_runtime_artifact(root)


if __name__ == "__main__":
    unittest.main()
