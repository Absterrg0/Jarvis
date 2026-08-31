from __future__ import annotations

import hashlib
import importlib.metadata
import json
import platform
import sys
from dataclasses import dataclass
from pathlib import Path


EXPECTED_ONNX_RUNTIME_VERSION = "1.27.1"

# These platform npm packages are the frozen Pipecat worker's native ONNX
# Runtime source. They are not the removed Node Sherpa speech pipeline.


@dataclass(frozen=True)
class NativeOnnxRuntime:
    library: Path
    companion_libraries: tuple[Path, ...]
    package_directory: Path
    package_name: str
    version: str
    onnx_runtime_version: str


def _target(platform_id: str, machine: str) -> tuple[str, str]:
    architecture = machine.lower()
    if platform_id.startswith("linux") and architecture in {"amd64", "x86_64"}:
        return "sherpa-onnx-linux-x64", "libonnxruntime.so"
    if platform_id == "darwin" and architecture in {"arm64", "aarch64"}:
        return "sherpa-onnx-darwin-arm64", "libonnxruntime.dylib"
    if platform_id == "darwin" and architecture in {"amd64", "x86_64"}:
        return "sherpa-onnx-darwin-x64", "libonnxruntime.dylib"
    if platform_id == "win32" and architecture in {"amd64", "x86_64"}:
        return "sherpa-onnx-win-x64", "onnxruntime.dll"
    raise RuntimeError(f"Jarvis does not package Pipecat voice for {platform_id}/{machine}.")


def resolve_native_onnx_runtime(
    repository_root: Path,
    *,
    platform_id: str = sys.platform,
    machine: str | None = None,
) -> NativeOnnxRuntime:
    package_name, library_name = _target(platform_id, machine or platform.machine())
    package_directory = (
        repository_root / "packages" / "jarvis-native-voice" / "node_modules" / package_name
    )
    manifest_path = package_directory / "package.json"
    library = package_directory / library_name
    if not manifest_path.is_file() or not library.is_file():
        raise RuntimeError(
            f"Jarvis could not locate the installed {package_name} native runtime. Run vp i first."
        )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    python_version = importlib.metadata.version("sherpa-onnx")
    if manifest.get("name") != package_name:
        raise RuntimeError(f"The installed native runtime is not {package_name}.")
    package_version = manifest.get("version")
    if package_version != python_version:
        raise RuntimeError(
            "The Python and desktop Sherpa runtimes must have the same version "
            f"({python_version} != {package_version})."
        )
    if EXPECTED_ONNX_RUNTIME_VERSION.encode() not in library.read_bytes():
        raise RuntimeError(
            f"The {package_name} ONNX Runtime is not {EXPECTED_ONNX_RUNTIME_VERSION}."
        )
    companion_libraries = tuple(
        path.resolve()
        for path in (package_directory / "onnxruntime_providers_shared.dll",)
        if path.is_file()
    )
    return NativeOnnxRuntime(
        library=library.resolve(),
        companion_libraries=companion_libraries,
        package_directory=package_directory.resolve(),
        package_name=package_name,
        version=python_version,
        onnx_runtime_version=EXPECTED_ONNX_RUNTIME_VERSION,
    )


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
