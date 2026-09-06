# Pocket TTS migration

Jarvis speech output runs PocketTTS.cpp with ONNX Runtime behind the existing
Pipecat TTS boundary (`apps/desktop/pipecat`). One voice process with one
model lease serves Full and Controller; Headless and disabled clients stay
idle and never spawn the worker.

## Pinned configuration

- Runtime: PocketTTS.cpp `e801e7d6c2692121a39e80ae525cb5265174a495` plus the
  production edits in `packages/jarvis-native-voice/native/pocket` (mixed
  precision split, three-frame chunks, no disk cache, no legacy space padding,
  BOS voice bias in code, bounded 16-entry stream queue, typed stream errors,
  in-place cancellation, fixed inference budget).
- Models: stephvax `pocket-tts-onnx` `fc68ee7e5a0a29662e218df84b24acb311f7fb6d`,
  bundle `english_2026-04`, mixed precision (INT8 language model, FP32 flow
  network and Mimi decoder).
- Inference: temperature 0.3, one flow step, two CPU threads, first chunk one
  frame, later chunks capped at three frames, 50-token bundle bound, 24 kHz.
- Voice: Kyutai `alba-mackenna/casual.wav`, first three seconds, mono 24 kHz
  (`voices/alba-casual-3s.wav`, CC BY 4.0, Alba MacKenna).
- Onset filter: -50 dBFS, 10 ms RMS window, 40 ms preroll, 2 s maximum
  removal. Only the leading prefix is removed; quiet attacks survive and
  every later pause is preserved.
- ONNX Runtime 1.23.2, SentencePiece v0.2.1, inside the daemon only. The
  frozen Pipecat host keeps sherpa's ONNX Runtime 1.27.1 for Parakeet; the two
  runtimes never share a process.

Pins live in `native/pocket/PINNED_REVISIONS.json`. The build script applies
each production edit as an exact-match replacement and fails loudly on drift.

## Process layout

The Pipecat service (`pocket.py`) owns one `jarvis-pocket-tts` daemon
process: load and warm once, one active synthesis at a time, raw IEEE-float
WAV chunk files per request. Overlapping synthesis is rejected at the daemon
and at the Python handle, so the active model is never used concurrently or
destroyed while busy.

Raw chunks pass through the bounded leading-silence filter and are announced
strictly in daemon order; the terminal event is honored only after every
pending write, so the reported count always matches the announced chunks.
The bounded Pipecat queue (8) carries filtered int16 frames downstream with
the same sentinel discipline as before: the sentinel lands after native
generation returns, which is the point model reuse becomes safe.

Cancellation sends the daemon `cancel` command and aborts in place: generation
stops, queued playback is discarded, workers join, and the model stays loaded,
so the next utterance after a barge-in reuses the warm runtime. Disable,
shutdown, failure, and model release close the daemon through the same path;
decoder state resets per sentence and voice state is in-memory only.

Native failures arrive as typed `failed` events with the daemon's message and
surface as synthesis failures, never silent success and never completion.

## Text handling

The daemon splits sentences, prepares each sentence (capitalization, terminal
punctuation, short-sentence EOS frames), and resets decoder state per
sentence. Long input is bounded by the 500-frame per-request cap and tmp
audio per request stays bounded; it is removed after synthesis. Single
sentences past the bundle's 50-token bound keep whole-sentence prosody:
mid-sentence cuts were measured to trade occasional dropped clauses for
systematic join disfluency, so the bound stays documented, not enforced.

## Packaging

`prepare:voice` runs `ensure-parakeet-resources.mjs` and
`ensure-pocket-resources.mjs`. The Pocket script downloads the pinned ONNX
files with SHA-256 checks, derives the Alba reference and the raw voice-bias
vector, stages the reproducibly built daemon and ONNX Runtime libraries, and
writes `PROVENANCE.json`. Nothing is downloaded at runtime and no checkout,
`/tmp`, or Python paths ship. Pocket resources live beside the retired Kokoro
directory, so upgrades work without manual cache deletion. The frozen
Pipecat bundle is untouched: the daemon and its ONNX Runtime ship beside it
in `jarvis-resources/pocket`, keeping the 180 MiB host budget and the
exactly-one-ORT rule intact.

Desktop and mobile surfaces stage `jarvis-resources/pocket`. Per-platform CI
builds the daemon, runs the Pipecat unit suite and the packaged self-test
against the staged resources, and asserts daemon, ONNX library, model set,
voice reference, and provenance.

## Verification

Pipecat tests cover streaming order and exact counts, onset filtering,
bounded queues, cancellation before first output and mid-stream, error
propagation, warm reuse after cancel, disable/shutdown cleanup, model-lease
exclusivity, and cold/warm timing. `benchmark-pocket.mjs` drives the
production sidecar for cold/warm first-audible latency. Targets: warm audible
under 350 ms, cancellation under 150 ms, peak RSS under 800 MiB, WER under 7%.
Release candidates still need the real-device acceptance pass: physical
speaker, microphone permission, hotkey, and each shipped OS/arch.
