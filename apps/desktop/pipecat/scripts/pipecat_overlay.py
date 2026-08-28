from __future__ import annotations

import importlib.metadata
import shutil
from pathlib import Path


EXPECTED_PIPECAT_VERSION = "1.7.0"


class OverlayError(RuntimeError):
    """The installed Pipecat source is not the reviewed build input."""


def _replace_once(path: Path, needle: str, replacement: str) -> None:
    source = path.read_text(encoding="utf-8")
    count = source.count(needle)
    if count != 1:
        raise OverlayError(f"Expected one reviewed fragment in {path}, found {count}.")
    path.write_text(source.replace(needle, replacement), encoding="utf-8")


def create_pipecat_overlay(installed_package: Path, overlay_root: Path) -> Path:
    """Copy the pinned Pipecat package and apply only reviewed lazy-import cuts.

    Pipecat remains an ordinary dependency for development. The overlay exists
    only during the frozen build, so the source distribution is never modified.
    """
    version = importlib.metadata.version("pipecat-ai")
    if version != EXPECTED_PIPECAT_VERSION:
        raise OverlayError(
            f"The reviewed Pipecat overlay requires {EXPECTED_PIPECAT_VERSION}, found {version}."
        )
    installed_package = installed_package.resolve()
    if not installed_package.is_dir() or installed_package.name != "pipecat":
        raise OverlayError(f"Invalid installed Pipecat package: {installed_package}")

    target = overlay_root / "pipecat"
    overlay_root.mkdir(parents=True, exist_ok=True)
    shutil.copytree(installed_package, target)

    _replace_once(
        target / "audio" / "utils.py",
        "import numpy as np\nimport pyloudnorm as pyln\n",
        "import numpy as np\n",
    )
    _replace_once(
        target / "audio" / "utils.py",
        "    audio_np = np.frombuffer(audio, dtype=np.int16)\n",
        "    import pyloudnorm as pyln\n\n    audio_np = np.frombuffer(audio, dtype=np.int16)\n",
    )

    _replace_once(
        target / "transports" / "base_output.py",
        "from loguru import logger\nfrom PIL import Image\n",
        "from loguru import logger\n",
    )
    _replace_once(
        target / "transports" / "base_output.py",
        "                if frame.size != desired_size:\n                    image = Image.frombytes(frame.format, frame.size, frame.image)\n",
        "                if frame.size != desired_size:\n                    from PIL import Image\n\n                    image = Image.frombytes(frame.format, frame.size, frame.image)\n",
    )
    _replace_once(
        target / "processors" / "aggregators" / "llm_context.py",
        "from openai.types.chat import (\n"
        "    ChatCompletionMessageParam,\n"
        "    ChatCompletionToolChoiceOptionParam,\n"
        ")\n"
        "from PIL import Image\n",
        "from openai.types.chat import (\n"
        "    ChatCompletionMessageParam,\n"
        "    ChatCompletionToolChoiceOptionParam,\n"
        ")\n",
    )
    _replace_once(
        target / "processors" / "aggregators" / "llm_context.py",
        "                # Encode to JPEG\n                buffer = io.BytesIO()\n                Image.frombytes(format, size, image).save(buffer, format=\"JPEG\")\n",
        "                # Encode to JPEG\n"
        "                from PIL import Image\n\n"
        "                buffer = io.BytesIO()\n"
        "                Image.frombytes(format, size, image).save(buffer, format=\"JPEG\")\n",
    )

    nltk_imports = (
        "import nltk\n"
        "from loguru import logger\n"
        "from nltk.tokenize import sent_tokenize\n\n"
        "# Ensure punkt_tab tokenizer data is available\n"
        "try:\n"
        "    nltk.data.find(\"tokenizers/punkt_tab\")\n"
        "except LookupError:\n"
        "    try:\n"
        "        nltk.download(\"punkt_tab\", quiet=True)\n"
        "    except (OSError, PermissionError) as e:\n"
        "        logger.error(\n"
        "            f\"Failed to download NLTK 'punkt_tab' tokenizer data: {e}. \"\n"
        "            \"This data is required for sentence tokenization features. \"\n"
        "            \"The download failed due to filesystem permissions. \"\n"
        "            \"To resolve: pre-install the data in a location with appropriate read permissions, \"\n"
        "            \"or set the NLTK_DATA environment variable to point to a writable directory. \"\n"
        "            \"See https://www.nltk.org/data.html for more information.\"\n"
        "        )\n\n"
    )
    _replace_once(target / "utils" / "string.py", nltk_imports, "")
    _replace_once(
        target / "utils" / "string.py",
        "    # Use NLTK's sentence tokenizer to find sentence boundaries\n"
        "    sentences = sent_tokenize(text)\n",
        "    import nltk\n"
        "    from loguru import logger\n"
        "    from nltk.tokenize import sent_tokenize\n\n"
        "    # Ensure punkt_tab tokenizer data is available\n"
        "    try:\n"
        "        nltk.data.find(\"tokenizers/punkt_tab\")\n"
        "    except LookupError:\n"
        "        try:\n"
        "            nltk.download(\"punkt_tab\", quiet=True)\n"
        "        except (OSError, PermissionError) as e:\n"
        "            logger.error(\n"
        "                f\"Failed to download NLTK 'punkt_tab' tokenizer data: {e}. \"\n"
        "                \"This data is required for sentence tokenization features. \"\n"
        "                \"The download failed due to filesystem permissions. \"\n"
        "                \"To resolve: pre-install the data in a location with appropriate read permissions, \"\n"
        "                \"or set the NLTK_DATA environment variable to point to a writable directory. \"\n"
        "                \"See https://www.nltk.org/data.html for more information.\"\n"
        "            )\n\n"
        "    # Use NLTK's sentence tokenizer to find sentence boundaries\n"
        "    sentences = sent_tokenize(text)\n",
    )
    return target


__all__ = ["EXPECTED_PIPECAT_VERSION", "OverlayError", "create_pipecat_overlay"]
