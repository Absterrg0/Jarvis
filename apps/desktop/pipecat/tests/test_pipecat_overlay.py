from __future__ import annotations

import shutil
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


if __name__ == "__main__":
    unittest.main()
