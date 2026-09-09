"""Measure real models through Runtime without opening a microphone or speaker.

Run with the voice host's Python environment and native library path. Output is
raw JSON plus WAV fixtures under --output, which must be outside the repository.
PCM availability is not acoustic onset. Quality transcripts are an ASR screen.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import time
import wave
from pathlib import Path
from unittest.mock import patch

from jarvis_voice_runtime.pocket import JarvisPocketTTSService
from jarvis_voice_runtime.runtime import Runtime

TEXTS = {
    "short": "Done.",
    "typical": "The task is complete. I updated the login flow and added regression tests. All targeted checks passed. You can review the changes in the workspace.",
    "long": "The connection dropped while the provider was working, so I have kept the task on its original node and will show its durable result when that node reconnects, while the other projects remain available and the selected task stays unchanged until you choose a different one.",
    "negation": "I have not pushed the changes. The tests passed, but the build failed.",
    "numbers": "Three checks passed and two failed. Keep version 3.14, not 3.41.",
    "names": "ARIS is ready. The Codex task is waiting for approval.",
}


async def benchmark(args: argparse.Namespace) -> None:
    args.output.mkdir(parents=True, exist_ok=True)
    rows = []
    messages = []
    finished = asyncio.Event()
    marks = {}
    pcm = bytearray()
    started = 0.0
    original = JarvisPocketTTSService.run_tts

    def mark(name: str) -> None:
        marks.setdefault(name, (time.monotonic() - started) * 1000)

    async def measured(service, text, context_id):
        async for frame in original(service, text, context_id):
            mark("firstServicePcmMs")
            yield frame

    def emit(message: dict[str, object]) -> None:
        messages.append(message)
        if message.get("type") == "result" and message.get("ok") is False:
            print(json.dumps(message), flush=True)
            finished.set()
        if message.get("type") == "synthesis-audio":
            mark("firstRemoteEventMs")
            pcm.extend(base64.b64decode(str(message["data"])))
        if message.get("type") == "synthesis-result":
            mark("terminalMs")
            finished.set()

    runtime = Runtime(
        args.parakeet, pocket_root=args.pocket, retain_models=args.resident, output=emit
    )

    def save() -> None:
        (args.output / "results.json").write_text(
            json.dumps(
                {
                    "residentRequested": args.resident,
                    "residentStillEnabled": runtime._retain_models,
                    "definitions": "In-process commands, real models, buffered fake output; excludes OS/DAC/network. No percentile claim from this small corpus.",
                    "runs": rows,
                },
                indent=2,
            )
        )

    try:
        with patch.object(JarvisPocketTTSService, "run_tts", measured):
            for trial in range(args.iterations):
                for name, text in TEXTS.items():
                    marks.clear()
                    pcm.clear()
                    messages.clear()
                    finished.clear()
                    started = time.monotonic()
                    request_id = f"{name}-{trial}"
                    await runtime.command(
                        {
                            "type": "synthesis-start",
                            "requestId": request_id,
                            "synthesisId": request_id,
                            "text": text,
                        }
                    )
                    await asyncio.wait_for(finished.wait(), 60)
                    terminal = next(m for m in messages if m.get("type") == "synthesis-result")
                    if not terminal.get("ok"):
                        raise RuntimeError(str(terminal))
                    with wave.open(str(args.output / f"{request_id}.wav"), "wb") as wav:
                        wav.setparams((1, 2, 24_000, 0, "NONE", ""))
                        wav.writeframes(pcm)
                    row = {
                        "mode": "synthesis",
                        "name": name,
                        "trial": trial,
                        "reference": text,
                        **marks,
                        "audioMs": len(pcm) / 48,
                        "timing": terminal.get("timing"),
                    }
                    rows.append(row)
                    print(json.dumps(row), flush=True)
                    save()
            for trial in range(args.iterations):
                started = time.monotonic()
                await runtime._prepare_listening()
                listening_ms = (time.monotonic() - started) * 1000
                from jarvis_voice_runtime.parakeet import ParakeetSegmentedSTT

                with wave.open(str(args.output / f"long-{trial}.wav"), "rb") as wav:
                    audio = wav.readframes(wav.getnframes())
                service = ParakeetSegmentedSTT(runtime._recognizer, "", sample_rate=24_000)
                transcripts = [frame.text async for frame in service.run_stt(audio)]
                decode_ms = service.decode_ms
                del service
                started = time.monotonic()
                await runtime._prepare_speech(remote=True)
                rows.append(
                    {
                        "mode": "handoff",
                        "trial": trial,
                        "listeningReadyMs": listening_ms,
                        "speechReadyMs": (time.monotonic() - started) * 1000,
                        "decodeMs": decode_ms,
                        "transcripts": transcripts,
                    }
                )
                save()
            for trigger in (25, 250, 1000):
                finished.clear()
                messages.clear()
                request_id = f"cancel-{trigger}"
                await runtime.command(
                    {
                        "type": "synthesis-start",
                        "requestId": request_id,
                        "synthesisId": request_id,
                        "text": " ".join([TEXTS["long"]] * 4),
                    }
                )
                await asyncio.sleep(trigger / 1000)
                started = time.monotonic()
                await runtime.command(
                    {
                        "type": "synthesis-cancel",
                        "requestId": request_id + "-stop",
                        "synthesisId": request_id,
                    }
                )
                await asyncio.wait_for(finished.wait(), 10)
                terminal = next(m for m in messages if m.get("type") == "synthesis-result")
                if terminal.get("code") != "cancelled":
                    raise RuntimeError(f"Cancellation did not interrupt synthesis: {terminal}")
                rows.append(
                    {
                        "mode": "cancel",
                        "triggerMs": trigger,
                        "cancelMs": (time.monotonic() - started) * 1000,
                    }
                )
                save()
    finally:
        await runtime.command({"type": "shutdown", "requestId": "bye"})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--parakeet", type=Path, required=True)
    parser.add_argument("--pocket", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--iterations", type=int, default=3, choices=range(2, 31))
    parser.add_argument("--resident", action="store_true")
    asyncio.run(benchmark(parser.parse_args()))
