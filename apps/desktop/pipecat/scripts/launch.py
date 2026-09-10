from __future__ import annotations

import os
import sys
from pathlib import Path

from native_runtime import resolve_native_onnx_runtime


REPOSITORY_ROOT = Path(__file__).resolve().parents[4]


def main() -> None:
    environment = os.environ.copy()
    runtime = resolve_native_onnx_runtime(REPOSITORY_ROOT)
    variable = "PATH"
    if sys.platform.startswith("linux"):
        variable = "LD_LIBRARY_PATH"
    elif sys.platform == "darwin":
        variable = "DYLD_LIBRARY_PATH"
    existing = environment.get(variable, "")
    environment[variable] = (
        str(runtime.package_directory)
        if not existing
        else f"{runtime.package_directory}{os.pathsep}{existing}"
    )
    os.execvpe(
        sys.executable,
        [sys.executable, "-m", "jarvis_voice_runtime", *sys.argv[1:]],
        environment,
    )


if __name__ == "__main__":
    main()
