from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import pipecat

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

from pipecat_overlay import OverlayError, create_pipecat_overlay  # noqa: E402


class PipecatOverlayTest(unittest.TestCase):
    def setUp(self) -> None:
        self.installed = Path(pipecat.__file__).parent

    def test_moves_optional_audio_dependencies_into_their_dead_paths(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            overlay = create_pipecat_overlay(self.installed, Path(directory))
            audio_utils = (overlay / "audio" / "utils.py").read_text()
            base_output = (overlay / "transports" / "base_output.py").read_text()
            llm_context = (overlay / "processors" / "aggregators" / "llm_context.py").read_text()
            string_utils = (overlay / "utils" / "string.py").read_text()

        self.assertNotIn("import pyloudnorm as pyln\n\nfrom pipecat", audio_utils)
        self.assertIn("    import pyloudnorm as pyln", audio_utils)
        self.assertNotIn("from PIL import Image\n\nfrom pipecat.audio", base_output)
        self.assertIn("                    from PIL import Image", base_output)
        self.assertNotIn("from PIL import Image\n", llm_context[:2000])
        self.assertIn("                from PIL import Image", llm_context)
        self.assertNotIn("\nimport nltk\n", string_utils)
        self.assertIn("    import nltk", string_utils)

    def test_rejects_source_drift_in_a_reviewed_fragment(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory) / "pipecat"
            shutil.copytree(self.installed, package)
            source = package / "audio" / "utils.py"
            source.write_text(source.read_text().replace("import pyloudnorm as pyln", "# drift"))
            with self.assertRaises(OverlayError):
                create_pipecat_overlay(package, Path(directory) / "overlay")


OVERLAID_MODULES = [
    "pipecat.audio.utils",
    "pipecat.transports.base_output",
    "pipecat.processors.aggregators.llm_context",
    "pipecat.utils.string",
]

IMPORT_PARITY_SNIPPET = """
import os
import pipecat
import pipecat.audio.utils
import pipecat.transports.base_output
import pipecat.processors.aggregators.llm_context
import pipecat.utils.string

assert pipecat.__file__.startswith(os.environ["JARVIS_OVERLAY_ROOT"]), pipecat.__file__
assert hasattr(pipecat.transports.base_output, "BaseOutputTransport")
assert callable(pipecat.audio.utils.calculate_audio_volume)
assert callable(pipecat.utils.string.match_endofsentence)
print("overlay-import-parity-ok")
"""

LAZY_FUNCTION_SNIPPET = """
import numbers
import pipecat.audio.utils
import pipecat.utils.string

volume = pipecat.audio.utils.calculate_audio_volume(b"\\x00\\x00" * 160, 16000)
assert isinstance(volume, numbers.Real) and volume >= 0, volume
try:
    end = pipecat.utils.string.match_endofsentence("Hello world. How are you?")
except LookupError:
    raise SystemExit("overlay-lazy-skip-no-punkt")
assert isinstance(end, int), end
print("overlay-lazy-functions-ok")
"""

BLOCKED_OPTIONALS_SNIPPET = """
import importlib.abc
import sys

BLOCKED = {"pyloudnorm", "PIL", "nltk"}


class OptionalDependencyBlocker(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path=None, target=None):
        if name.split(".")[0] in BLOCKED:
            raise ImportError(f"frozen layout excludes {name}")
        return None


sys.meta_path.insert(0, OptionalDependencyBlocker())

import pipecat.audio.utils
import pipecat.transports.base_output
import pipecat.processors.aggregators.llm_context
import pipecat.utils.string

print("overlay-lazy-imports-ok")
"""


class PipecatOverlayParityTest(unittest.TestCase):
    """Development exercises the overlaid package, not just its text.

    The frozen build imports Pipecat through the overlay directory while
    development imports the installed dependency. These tests run the same
    imports (and the movable lazy functions) against the overlaid copy in a
    subprocess, so a reviewed fragment that breaks at import or call time
    fails here instead of in a release build.
    """

    def _overlay_root(self) -> tuple[tempfile.TemporaryDirectory[str], Path]:
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        assert pipecat.__file__ is not None
        overlay = create_pipecat_overlay(
            Path(pipecat.__file__).parent, Path(holder.name)
        )
        return holder, overlay.parent

    def _run_child(self, snippet: str, overlay_root: Path) -> "subprocess.CompletedProcess[str]":

        env = dict(os.environ)
        env["JARVIS_OVERLAY_ROOT"] = str(overlay_root / "pipecat")
        env["PYTHONPATH"] = str(overlay_root) + (
            f"{os.pathsep}{env['PYTHONPATH']}" if env.get("PYTHONPATH") else ""
        )
        return subprocess.run(
            [sys.executable, "-c", snippet],
            capture_output=True,
            text=True,
            env=env,
            timeout=300,
        )

    def test_overlaid_package_shadows_installed_pipecat_on_import(self) -> None:
        _, root = self._overlay_root()
        completed = self._run_child(IMPORT_PARITY_SNIPPET, root)
        self.assertEqual(
            completed.returncode,
            0,
            f"overlay imports failed:\n{completed.stdout}\n{completed.stderr}",
        )
        self.assertIn("overlay-import-parity-ok", completed.stdout)

    def test_overlaid_lazy_functions_run_against_installed_optionals(self) -> None:
        _, root = self._overlay_root()
        completed = self._run_child(LAZY_FUNCTION_SNIPPET, root)
        if "overlay-lazy-skip-no-punkt" in (completed.stdout + completed.stderr):
            self.skipTest("punkt_tab tokenizer data is unavailable offline")
        self.assertEqual(
            completed.returncode,
            0,
            f"overlay lazy functions failed:\n{completed.stdout}\n{completed.stderr}",
        )
        self.assertIn("overlay-lazy-functions-ok", completed.stdout)

    def test_overlaid_modules_import_without_frozen_excluded_optionals(self) -> None:
        _, root = self._overlay_root()
        completed = self._run_child(BLOCKED_OPTIONALS_SNIPPET, root)
        self.assertEqual(
            completed.returncode,
            0,
            f"overlay imports require a frozen-excluded optional:\n{completed.stdout}\n{completed.stderr}",
        )
        self.assertIn("overlay-lazy-imports-ok", completed.stdout)


if __name__ == "__main__":
    unittest.main()
