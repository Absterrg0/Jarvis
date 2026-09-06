# Pocket speech runtime

Jarvis uses PocketTTS.cpp with the compact `english_2026-04` ONNX export,
INT8 language model and FP32 flow/decoder. The daemon runs beside the frozen
Pipecat host, which keeps Sherpa's ONNX Runtime isolated from Pocket's runtime.
Model and runtime revisions are pinned in
`packages/jarvis-native-voice/native/pocket/PINNED_REVISIONS.json`.

## Streaming and interruption

The daemon produces ordered float WAV chunks. The Python adapter reads each
chunk as it arrives, removes its temporary file, applies the bounded onset
filter, and yields signed PCM through an eight-chunk queue. It does not wait
for the utterance terminal before producing audio. Terminal chunk counts and
sample rate must match the stream; malformed output fails the request and
closes the daemon before reuse.

Cancellation writes directly to the daemon even while the audio reader is
blocked. The runtime drains the terminal and retires the cancelled Pipecat pipeline before
reporting cancellation. The next request builds a fresh pipeline around the same
resident daemon, preventing stale stop events from ending later speech. A two-second
cancellation watchdog closes an unresponsive daemon; process shutdown itself
has a five-second grace period before kill/reap. These are failure bounds,
not normal cancellation latency targets. Startup uses a reader thread with a
bounded ready wait, including on Windows, where `select` cannot read pipes.
Every prepared native handle is closed if capture, shutdown or output setup
prevents ownership from transferring to a live service.

The native stream splits text at sentence, clause and then word boundaries using the
actual tokenizer. Every prepared segment is at most 50 tokens. Words are never
silently truncated; an individual word exceeding that limit produces an error.
This bound applies to local and remote synthesis. It reduces long-clause loss
but does not guarantee the model pronounces every input correctly.

## Inference configuration

Pocket uses two CPU threads, one flow step, temperature 0.3, one-frame initial
chunks and three-frame subsequent chunks. The voice is the first three seconds
of Alba MacKenna's casual reference, mono 24 kHz. The bundle's BOS vector is
prepended to the encoded voice. Voice state is reused in memory; no voice-state
disk cache is used.

The onset filter uses a -50 dBFS RMS threshold over 10 ms windows, preserves
40 ms preroll, and limits leading trimming to two seconds. It preserves pauses
after the first onset. First delivered PCM therefore differs from both first
raw model output and physical speaker onset.

Parakeet uses four CPU threads with both ONNX intra-op and inter-op spin waiting
disabled through Sherpa's provider configuration. The temporary configuration
file is read while sessions are constructed and removed immediately afterward.
No optional VAD or turn-detection model is introduced.

## Model residency

The production host can retain both models on Linux machines with at least
12 GiB total memory and 2 GiB available when it starts. This avoids reconstructing
models between successive voice turns. The models still share one active speech
or capture operation; residency does not authorize concurrent capture/synthesis.

The runtime checks combined current host/daemon RSS and available system memory
when it loads the second model and at inference completion. If sampled combined
RSS exceeds 1 GiB, memory becomes unknown, or system availability drops below
2 GiB, it releases the inactive model and keeps the single-model policy for the
rest of that worker lifetime. This is an event-driven retention budget, not a
hard process memory limit; transient allocations between checks can exceed it.
There is no idle memory polling. Set `JARVIS_VOICE_MODEL_RESIDENCY=single` to keep
the single-model lease. Unknown platforms use that policy by default.

Full and Controller own the voice host. Headless does not gain speech through
this policy. Shutdown releases both resident models. Disabled voice remains
subject to the desktop worker's existing shutdown lifecycle.

## Remote delivery

Mobile already splits presentation text and prefetches one synthesized segment
while another plays. The first ordinary segment is now limited to 96 characters,
with subsequent segments capped at 240. Sentence splitting preserves decimal
values. Individual long words remain subject to the existing 240-character
transport splitting and the native tokenizer's pronunciation bound.

Each remote RPC still returns a complete WAV for one segment. The Python output
buffer, sidecar, authenticated desktop broker, Jarvis RPC, and mobile file player
still use that contract. Native incremental delivery improves local speech;
it does not make this RPC a continuous audio stream. A future byte-streaming
transport must update all of these owners together and prove cancellation and
continuous playback on real devices.

## Metrics and verification

`synthesisCpuMs` includes host plus native CPU. The individual `hostCpuMs`,
`nativeCpuMs`, `nativeSynthesisMs`, and `nativePeakRssBytes` fields keep the process
boundary inspectable. Legacy `peakRssBytes` remains the host high-water mark.
On Linux, `sampledPeakRssBytes` is the maximum simultaneous host-plus-daemon RSS
sample at PCM boundaries, and `currentTotalRssBytes` is the final such sample.
Neither is a sum of independent lifetime peaks or an OS-enforced memory cap.

Use `apps/desktop/pipecat/scripts/benchmark_pipeline.py` with the voice host's
Python environment, its native library path, and `PYTHONPATH` pointing at
`apps/desktop/pipecat/src`. Pass `--parakeet`, `--pocket`, and an external
`--output` directory; `--resident` exercises retention and its budget fallback.
It writes raw timing JSON and WAV fixtures, measures cancellation, and screens
long-output transcripts. It never opens a microphone or physical output device.

The September 2026 i7-1255U development run measured typical first service PCM
at 35–76 ms across three warm draws, compared with a 1,176 ms median in the
original PR's alternating benchmark. Repeated resident handoffs avoided model
construction; initial Parakeet construction remained about 1.35 seconds. Cancellation at 25, 250 and 1,000 ms into
long synthesis completed in 56, 14 and 22 ms respectively.
These are small in-process Linux samples, not p95 or acoustic-onset claims.
The model is stochastic and ASR screening can mishear correct audio.

Focused tests cover first PCM before native completion, cancellation before
any output, malformed chunks, exact order, abandoned preparation, startup,
residency eviction/reuse, shutdown, and protocol metrics. Release acceptance
still requires physical microphone/speaker, hotkey, local and remote mobile
playback, and the supported packaged OS/architecture combinations.
