# Linux Full native voice architecture

Linux Full ships one visible Jarvis application and one Electron runtime. Jarvis Desktop owns the
global shortcut, command UI, local execution, voice lifecycle, and renderer bridge. A small
Node-mode voice worker preserves Desktop's typed process boundary and supervises the bundled
Python Pipecat host. Headless nodes have no voice capability.

Desktop keeps its existing typed voice-worker boundary, but transcription now runs in a bundled
Python Pipecat sidecar behind that boundary. The sidecar is the voice runtime, not a Jarvis agent:
it owns the capture-scoped audio-frame pipeline, Parakeet and Kokoro model lifecycles,
segmentation, raw transcript frames, and synthesized-audio playback. It never receives project or task IDs
and cannot ground, authorize, route, choose a report, or dispatch a request. For the current
Windows/Linux x64 stabilization, microphone capture uses the shared `node-cpal` `0.1.1` path.
macOS sends Chromium `AudioWorklet` microphone PCM. Pipecat owns Kokoro speaker output. On Linux,
a Pipecat output transport writes native PCM to PipeWire's `pw-play` client; other Desktop targets
use Pipecat's local PyAudio transport. Desktop is
responsible for sidecar startup, bounded commands, crash recovery, and shutdown.

Each explicit push-to-talk turn creates one current Pipecat 1.x worker at button-down. PCM enters
that worker as it arrives, release closes the segment, and the unchanged INT8 Parakeet recognizer
emits one raw `TranscriptionFrame`. The recognizer and Python process stay resident across turns;
workers do not, because hotwords and input rates are capture-scoped and Pipecat does not expose a
safe public reset for a cancelled segmented turn. This is intentionally not always-on VAD.
Pipecat latency records include model readiness, capture/audio duration, resampling, decode,
release-to-transcript, total time, and peak RSS without transcript text.

The frozen host has an audio-only packaging contract. Linux requires `pw-play` from the system
PipeWire utilities package and fails preparation with an actionable error when it is absent; it
does not package or fall back to PortAudio. Other targets package PyAudio and PortAudio. A
version-guarded build overlay moves
Pipecat 1.7's optional loudness and image imports onto the paths that use them; PyInstaller then
excludes SciPy, pyloudnorm, Pillow, and NLTK. Kokoro receives one finalized Desktop
`TTSSpeakFrame` per response and uses Pipecat sentence aggregation, so its bounded TTS path does
not need the streaming sentence tokenizer or NLTK. The build fails closed if the
reviewed Pipecat sources drift, if those closures reappear, if more than one ONNX Runtime is
staged, or if the extracted runtime exceeds 180 MiB. On the Linux x64 reference build this reduced
the host from about 267 MiB to 138 MiB. It also reduced the same silent-capture self-test from
552,532 KiB peak RSS to 457,652 KiB (446.9 MiB). The former Node Parakeet path measured roughly
435–445 MiB on that machine. This puts the sidecar close to the old envelope, but release
acceptance still measures the complete Desktop worker plus sidecar process tree with the same
spoken fixture on every target. Warm RSS, peak RSS, CPU time, and packaged bytes are reviewed
together.

Offline voice models, the platform-specific native libraries, and the PyInstaller onedir Pipecat
host are staged once under the owning Desktop installation. Production builds run a real-model
sidecar self-test on Linux x64, Windows x64, macOS arm64, and macOS x64. No host Python, runtime
download, or second application is required. The Parakeet and Kokoro artifacts remain unchanged;
future model candidates must improve quality while staying at or below the current package size,
warm RSS, and latency envelope.

## Kokoro response latency

Pipecat owns Kokoro synthesis without taking over Jarvis speech policy. In Full and Controller,
the existing TypeScript speech queue still orders acknowledgements and FIFO presentations and decides
when speech may start. Task-and-turn-scoped terminal state cancels superseded work-start speech in
the Desktop Pipecat runtime by its unique delivery ID; push-to-talk remains the global interruption
path. Browser speech fallbacks keep their existing interruption behavior.
The queue submits the selected text to the sidecar. Pipecat runs the unchanged int8 Kokoro
model with speaker 0, speed 0.97, silence scale 0.42, one sentence per generation batch, and two
CPU threads. The Jarvis adapter uses sentence aggregation for the already-finalized utterance and
keeps text frames enabled because it has no word timestamps. Sherpa's native progress callback
becomes bounded signed-int16 PCM frames. Callback frames stream as soon as Sherpa produces them;
the returned sample buffer is reconciled afterward so a partial callback cannot truncate the
utterance or duplicate its prefix.

Pipecat chunks those frames and writes their unchanged 24 kHz signed mono PCM to one output stream
per utterance. Linux launches `pw-play` without a target, so WirePlumber selects and can move the
current default across speakers, earbuds, USB, or HDMI without a Jarvis device cache. After
Pipecat's downstream `BotStoppedSpeakingFrame`, closing pw-play's stdin flushes the PipeWire stream;
Jarvis reports completion only after the child exits successfully from PipeWire's drained callback.
Open, write, drain, or nonzero-exit failures cannot claim task success. Starting capture
terminates that exact child before waiting for Kokoro, drops late
results by speech ID, and waits for Sherpa's native generation call to return before switching
models. No synthesized PCM crosses the Desktop worker protocol.

The sidecar holds one model lease. Parakeet is resident while listening; speech preparation
releases Parakeet before loading Kokoro. Starting capture releases Kokoro before restoring
Parakeet. The last-used model remains loaded until the opposite operation or shutdown; there is no
idle eviction timer. On glibc Linux, a true Parakeet/Kokoro handoff trims freed native allocator
arenas after the old worker and model references are gone. Same-model preparation and
desktop/mobile output-sink changes do not trim or reload Kokoro. Successful speech publishes a
text-free timing record with cold/warm state, model load, first PCM, synthesis CPU/wall time, total
time through native playout, chunk count, current RSS where available, and peak sidecar RSS. The
first PCM measurement is synthesis readiness, not a claim about DAC onset.

Run `vp run --filter @t3tools/jarvis-native-voice benchmark:model-swap -- --cycles=5` against the
bundled models for a target-host ASR→TTS repetition. On the i7-1255U Linux reference host, the
September 2026 five-cycle run measured Parakeet construction at 1.37–2.13 seconds, warm inference
for the 0.99-second fixture at 40–67 milliseconds, Parakeet→Kokoro preparation at 1.02–1.31
seconds, Kokoro construction at 0.94–1.21 seconds, and first PCM for the benchmark sentence at
3.08–3.82 seconds. Full remote WAV availability, including model preparation, took 4.23–5.20
seconds. Current RSS returned to roughly 676–722 MiB after each handoff and peak RSS stayed at
721.3 MiB across the fresh five-cycle process, below the benchmark's 1 GiB acceptance limit.

The former Node Kokoro benchmark established the two-thread baseline on an i7-1255U Linux laptop:
its warm median was 1.42 seconds to the first WAV, 7.89 seconds total synthesis, and 15.72 CPU
seconds. Three and four threads were slower and consumed more CPU. The Pipecat path therefore
keeps two threads and records equivalent first-PCM, total, CPU, and RSS measurements. The legacy
`benchmark-kokoro.mjs` script remains a historical benchmark, but it is no longer the Desktop
production path.

## Considered options

- Embed a second unpacked Electron speech application inside Linux Full. Rejected because it duplicates Electron/Chromium, keeps two application implementations alive inside one artifact, inflates the package, and adds pairing semantics Full does not need.
- Run native speech in Desktop's main process. Rejected because native audio/model failures and memory pressure should not take down the workspace shell.
- Keep the old Node Parakeet and Kokoro workers as Desktop's voice runtime. Rejected because it
  would preserve two competing runtime lifecycles and leave Pipecat as a superficial wrapper. The
  legacy functions are not part of the Desktop production path.
- Download voice models after installation. Deferred because Full currently promises self-contained offline voice. It can be introduced later as an explicit optional voice-pack policy without changing the shared module interface.

## Consequences

Full onboarding reports local voice capability/readiness. The integrated Jarvis command UI receives local Parakeet transcripts and uses native synthesis, with browser speech only as a non-Desktop fallback. Hold-to-talk is platform-specific:

- **Windows (x64):** `uiohook` supplies real key-down / key-up edges for `Ctrl+Shift+J`.
- **Linux:** prefer `org.freedesktop.portal.GlobalShortcuts` (`Activated` / `Deactivated`). Before creating the session, register the stable application id through `org.freedesktop.host.portal.Registry`. Packaged startup creates the matching hidden `com.abstergo.jarvis.desktop` entry before installing shortcuts; AppImageLauncher's visible launcher name is not the portal identity. Only older portals without the host registry use the legacy user-systemd-scope identity path. If the portal is unavailable, native X11 may fall back to `uiohook`; GNOME Wayland never loads `uiohook` (Xkb map init fails through XWayland). When neither hold path works, Desktop exposes an explicit tap-toggle via Electron `globalShortcut` and never invents release from a quiet timeout.
- **macOS:** Electron `globalShortcut` uses `Command+Shift+J` as a tap-to-start/tap-to-stop toggle.
  Chromium `getUserMedia` and an `AudioWorklet` deliver microphone PCM to the voice worker;
  `uiohook` is absent; Pipecat uses its local PyAudio output transport.

Packaging smoke tests prove that the worker, Pipecat host, models, and native libraries exist;
that the real frozen Parakeet and Kokoro pipelines run; and that no nested application, legacy
Desktop Kokoro worker, or Desktop Sherpa Node runtime is present.
They cannot prove physical microphone, speaker routing, or key-release behavior.

Each portal session binds its shortcut once and checks that the successful response includes
`jarvis.voice`. A pre-bind `ListShortcuts` response may describe a previous session, so it is not
proof that the current session can receive key edges. Signals are scoped to both the session
handle and shortcut id.

## Desktop shell ownership

Desktop keeps the main Jarvis renderer loaded as the single task
orchestration owner. On Windows/Linux, `Ctrl+Shift+J` starts and releases native capture directly
through the main-process voice service; microphone control does not round-trip through React.
Linux tap fallback calls the same service with a toggle. macOS uses a renderer action for its
Chromium microphone path. None of these shortcuts reveal the workspace. Desktop owns the compact
always-on-top status overlay, whose meter receives measured microphone levels from the worker.
Worker startup is awaited once; capture commands have bounded acknowledgements and a failed worker
is replaced on the next attempt. A startup-ready message must not clear an in-flight capture's hold
state. On Windows and Linux,
closing the workspace window hides it to the tray while the backend, worker,
and shortcut remain alive. Tray actions are explicit: **Open Jarvis** reveals the workspace,
**Talk to Jarvis** / hold or tap labels dispatch the background voice action, and **Quit** enters
the normal ordered Electron shutdown path. Updater-controlled and explicit
quit paths synchronously disable the hide-to-tray latch before destroying
windows. The headless renderer orchestration consumer remains mounted while Jarvis is resident:
it selects only the originating Full node's focused task or sole local project as an implicit
target, lets explicit project phrases override that choice through the multi-node mesh, and consumes
the same live origin-directed presentation stream for local and remote completion speech. A real-device acceptance pass must verify capture while hidden, keydown
start, keyup release (or portal Activated/Deactivated), and that both tray quit and window quit stop the hook,
portal session, worker, and microphone before exit.
