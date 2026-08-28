from __future__ import annotations

import importlib.metadata
import shutil
import tempfile
from pathlib import Path

import PyInstaller.__main__
import pipecat

from native_runtime import resolve_native_onnx_runtime, sha256
from pipecat_overlay import create_pipecat_overlay
from runtime_artifact import inspect_runtime_artifact


PROJECT_ROOT = Path(__file__).resolve().parent.parent
REPOSITORY_ROOT = PROJECT_ROOT.parents[2]
RUNTIME_NAME = "jarvis-pipecat-voice"


def main() -> None:
    dist = PROJECT_ROOT / "dist"
    work = PROJECT_ROOT / "build"
    if importlib.metadata.version("pipecat-ai") != "1.7.0":
        raise RuntimeError("The frozen voice host requires the reviewed Pipecat 1.7.0 build.")
    with tempfile.TemporaryDirectory(prefix="jarvis-pipecat-overlay-") as overlay_directory:
        create_pipecat_overlay(Path(pipecat.__file__).parent, Path(overlay_directory))
        PyInstaller.__main__.run(
            [
                str(PROJECT_ROOT / "scripts" / "runtime_entry.py"),
                "--name",
                RUNTIME_NAME,
                "--onedir",
                "--clean",
                "--noconfirm",
                "--distpath",
                str(dist),
                "--workpath",
                str(work),
                "--specpath",
                str(work),
                "--paths",
                str(overlay_directory),
                "--paths",
                str(PROJECT_ROOT / "src"),
                "--hidden-import",
                "sherpa_onnx",
                "--copy-metadata",
                "pipecat-ai",
                "--collect-binaries",
                "sherpa_onnx",
                "--exclude-module",
                "onnxruntime",
                "--exclude-module",
                "tkinter",
                "--exclude-module",
                "scipy",
                "--exclude-module",
                "pyloudnorm",
                "--exclude-module",
                "PIL",
                "--exclude-module",
                "nltk",
            ]
        )
    runtime = resolve_native_onnx_runtime(REPOSITORY_ROOT)
    internal = dist / RUNTIME_NAME / "_internal"
    destination = internal / runtime.library.name
    shutil.copy2(runtime.library, destination)
    if sha256(runtime.library) != sha256(destination):
        raise RuntimeError("The staged ONNX Runtime does not match the desktop Sherpa package.")
    for companion in runtime.companion_libraries:
        companion_destination = internal / companion.name
        shutil.copy2(companion, companion_destination)
        if sha256(companion) != sha256(companion_destination):
            raise RuntimeError(
                "The staged ONNX Runtime provider does not match the desktop Sherpa package."
            )
    packaged_runtimes = [
        path
        for path in (dist / RUNTIME_NAME).rglob("*onnxruntime*")
        if path.is_file() and "providers_shared" not in path.name
    ]
    if packaged_runtimes != [destination]:
        paths = ", ".join(str(path.relative_to(dist / RUNTIME_NAME)) for path in packaged_runtimes)
        raise RuntimeError(f"Expected exactly one packaged ONNX Runtime library, found: {paths}")
    artifact = inspect_runtime_artifact(dist / RUNTIME_NAME)
    print(f"Pipecat runtime artifact: {artifact.size_bytes} bytes")


if __name__ == "__main__":
    main()
