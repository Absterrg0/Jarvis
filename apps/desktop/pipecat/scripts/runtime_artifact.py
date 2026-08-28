from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


MAX_RUNTIME_BYTES = 180 * 1024 * 1024


@dataclass(frozen=True)
class RuntimeArtifact:
    size_bytes: int
    onnx_runtimes: tuple[Path, ...]


def _directory_size(root: Path) -> int:
    # PyInstaller uses relative symlinks for shared native libraries. Count the
    # link itself rather than its target twice so this matches extracted bytes.
    return sum(path.lstat().st_size for path in root.rglob("*") if path.is_file())


def inspect_runtime_artifact(root: Path) -> RuntimeArtifact:
    if not root.is_dir():
        raise RuntimeError(f"Pipecat runtime artifact does not exist: {root}")

    forbidden = (
        "PIL",
        "nltk",
        "nltk_data",
        "pillow.libs",
        "pyloudnorm",
        "scipy",
        "scipy.libs",
    )
    packaged = {path.name for path in root.rglob("*")}
    unexpected = sorted(name for name in forbidden if name in packaged)
    if unexpected:
        raise RuntimeError(
            "The audio-only Pipecat host contains unused runtime dependencies: "
            + ", ".join(unexpected)
        )

    onnx_runtimes = tuple(
        path
        for path in root.rglob("*onnxruntime*")
        if path.is_file() and "providers_shared" not in path.name
    )
    if len(onnx_runtimes) != 1:
        paths = ", ".join(str(path.relative_to(root)) for path in onnx_runtimes)
        raise RuntimeError(f"Expected exactly one packaged ONNX Runtime library, found: {paths}")

    size_bytes = _directory_size(root)
    if size_bytes > MAX_RUNTIME_BYTES:
        raise RuntimeError(
            "The Pipecat runtime artifact exceeds its 180 MiB install budget "
            f"({size_bytes / 1024 / 1024:.1f} MiB)."
        )
    return RuntimeArtifact(size_bytes=size_bytes, onnx_runtimes=onnx_runtimes)


__all__ = ["MAX_RUNTIME_BYTES", "RuntimeArtifact", "inspect_runtime_artifact"]
