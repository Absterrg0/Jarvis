from __future__ import annotations

import argparse
import asyncio
import base64
import os
import sys
from pathlib import Path

from .kokoro import validate_model_root as validate_kokoro_model_root
from .parakeet import Recognizer, create_recognizer, validate_model_root
from .runtime import Runtime, run

FORBIDDEN_OPTIONAL_PIPECAT_MODULES = (
    "pipecat.audio.turn.smart_turn.local_smart_turn_v3",
    "pipecat.audio.vad.silero",
)


def validate_pipecat_import_boundary() -> None:
    imported = [name for name in FORBIDDEN_OPTIONAL_PIPECAT_MODULES if name in sys.modules]
    if imported:
        raise RuntimeError(
            "Jarvis push-to-talk imported an optional Pipecat ONNX model: " + ", ".join(imported)
        )


async def pipeline_self_test(
    model_root: Path,
    recognizer: Recognizer,
    kokoro_root: Path | None = None,
) -> None:
    messages: list[dict[str, object]] = []
    speech_done = asyncio.Event()
    speech_audio_seen = False
    speech_audio_end_seen = False
    runtime: Runtime

    def output(message: dict[str, object]) -> None:
        nonlocal speech_audio_seen, speech_audio_end_seen
        messages.append(message)
        if message.get("type") == "speech-audio":
            speech_audio_seen = True
            asyncio.create_task(
                runtime.command(
                    {
                        "type": "speech-audio-consumed",
                        "requestId": "self-test-audio-ack",
                        "speechId": message["speechId"],
                        "sequence": message["sequence"],
                    }
                )
            )
        elif message.get("type") == "speech-audio-end":
            speech_audio_end_seen = True
            asyncio.create_task(
                runtime.command(
                    {
                        "type": "speech-playout-drained",
                        "requestId": "self-test-playout-ack",
                        "speechId": message["speechId"],
                    }
                )
            )
        elif message.get("type") == "speech-result":
            speech_done.set()

    runtime = Runtime(
        model_root,
        kokoro_root=kokoro_root,
        recognizer=recognizer,
        output=output,
    )
    await runtime.command(
        {
            "type": "capture-start",
            "requestId": "self-test-start",
            "captureId": "self-test",
            "sampleRate": 16_000,
            "channels": 1,
            "contextualPhrases": [],
        }
    )
    await runtime.command(
        {
            "type": "pcm",
            "requestId": "self-test-pcm",
            "captureId": "self-test",
            "sequence": 0,
            "sampleRate": 16_000,
            "channels": 1,
            "data": base64.b64encode(bytes(32_000)).decode(),
        }
    )
    await runtime.command(
        {"type": "capture-release", "requestId": "self-test-release", "captureId": "self-test"}
    )
    assert runtime.capture is not None and runtime.capture.release_task is not None
    await runtime.capture.release_task
    if not any(message.get("type") == "capture-result" for message in messages):
        raise RuntimeError("Pipecat pipeline self-test did not finish a capture.")
    if kokoro_root is not None:
        await runtime.command({"type": "speech-prepare", "requestId": "self-test-prepare"})
        await runtime.command(
            {
                "type": "speech-start",
                "requestId": "self-test-speech-start",
                "speechId": "self-test-speech",
                "text": "Pipecat is ready. Voice delivery is working.",
            }
        )
        await asyncio.wait_for(speech_done.wait(), timeout=10)
        result = next(
            message for message in messages if message.get("type") == "speech-result"
        )
        if (
            result.get("status") != "completed"
            or not speech_audio_seen
            or not speech_audio_end_seen
        ):
            raise RuntimeError("Pipecat TTS self-test did not complete speech.")
    await runtime.command({"type": "shutdown", "requestId": "self-test-shutdown"})


def self_test() -> None:
    model_root = Path(os.environ["JARVIS_PIPECAT_MODEL_ROOT"])
    validate_model_root(model_root)
    kokoro_root = (
        Path(os.environ["JARVIS_PIPECAT_KOKORO_ROOT"])
        if os.environ.get("JARVIS_PIPECAT_KOKORO_ROOT")
        else None
    )
    if kokoro_root is not None:
        validate_kokoro_model_root(kokoro_root)
    recognizer = create_recognizer(model_root)
    validate_pipecat_import_boundary()
    asyncio.run(pipeline_self_test(model_root, recognizer, kokoro_root))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    arguments = parser.parse_args()
    if arguments.self_test:
        self_test()
        return
    try:
        asyncio.run(run())
    except BrokenPipeError:
        pass


if __name__ == "__main__":
    main()
