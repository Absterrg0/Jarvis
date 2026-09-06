"""Conservative model residency for Linux desktops with spare memory."""

import os
import sys
from pathlib import Path

VOICE_RESIDENT_BUDGET_BYTES = 1024 * 1024 * 1024
MIN_AVAILABLE_BYTES = 2 * 1024 * 1024 * 1024


def available_memory() -> tuple[int, int]:
    if not sys.platform.startswith("linux"):
        return 0, 0
    try:
        values = {}
        for line in Path("/proc/meminfo").read_text().splitlines():
            name, value = line.split(":", 1)
            values[name] = int(value.split()[0]) * 1024
        return values.get("MemTotal", 0), values.get("MemAvailable", 0)
    except (OSError, ValueError):
        return 0, 0


def use_resident_models() -> bool:
    # Unknown platforms and memory-constrained hosts retain the single-model lease.
    if os.environ.get("JARVIS_VOICE_MODEL_RESIDENCY") == "single":
        return False
    total, available = available_memory()
    return total >= 12 * 1024**3 and available >= MIN_AVAILABLE_BYTES
