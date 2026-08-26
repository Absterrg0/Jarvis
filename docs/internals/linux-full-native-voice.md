# Linux Full native voice architecture

Linux Full ships one visible Jarvis application and one Electron runtime. Jarvis Desktop owns the global shortcut, command UI, local execution, voice lifecycle, and renderer bridge. Native speech runs in an isolated Node-mode child launched through the Electron executable already packaged with Desktop; Linux Full must not embed or launch the standalone Companion application or another Chromium/Electron distribution. Headless nodes have no voice capability.

The native speech implementation is a shared deep module. Its interface exposes speech preparation, capture, transcription, synthesis, interruption, state, and events while hiding local Parakeet, Kokoro, audio-device, worker, and model-lifecycle details. For the current Windows/Linux x64 stabilization, GUI capture uses the exact shared `node-cpal` `0.1.1` path. Both Desktop and the standalone Companion may consume this module, but Full never embeds Companion. Desktop communicates with its speech child through a bounded typed protocol and remains responsible for startup, restart, shutdown, and user-visible errors.

Offline voice models and the platform-specific native libraries are part of Linux Full and are staged once under the owning Desktop installation. They account for a material size increase over a non-voice Desktop build; a second application runtime does not. The standalone Companion remains independently installable for an additional remote voice/control device and is not a runtime dependency of Linux Full. Windows continues to use its existing unified-setup resource layout; changing that installer is outside this Linux decision.

## Considered options

- Embed the complete Companion unpacked application inside Linux Full. Rejected because it duplicates Electron/Chromium, keeps two application implementations alive inside one artifact, inflates the package, and makes Full depend on Companion pairing semantics it does not need.
- Run native speech in Desktop's main process. Rejected because native audio/model failures and memory pressure should not take down the workspace shell.
- Bundle a separate Node runtime. Rejected because Electron already supports the required Node-mode worker and another runtime adds size without improving the seam.
- Download voice models after installation. Deferred because Full currently promises self-contained offline voice. It can be introduced later as an explicit optional voice-pack policy without changing the shared module interface.

## Consequences

Full onboarding reports local voice capability/readiness and never pairs with a hidden Companion. The integrated Jarvis command UI receives local Parakeet transcripts and uses native synthesis, with browser speech only as a non-Desktop fallback. Hold-to-talk is platform-specific:

- **Windows (x64):** `uiohook` supplies real key-down / key-up edges for `Ctrl+Shift+J`.
- **Linux:** prefer `org.freedesktop.portal.GlobalShortcuts` (`Activated` / `Deactivated`). The process is moved into a user systemd scope named `app-<appId>-<instance>.scope` so the portal can resolve a host app id. If the portal is unavailable, native X11 may fall back to `uiohook`; GNOME Wayland never loads `uiohook` (Xkb map init fails through XWayland). When neither hold path works, Desktop exposes an explicit tap-toggle via Electron `globalShortcut` and never invents release from a quiet timeout.
- **macOS:** Electron `globalShortcut` uses `Command+Shift+J` as a tap-to-start/tap-to-stop toggle. Chromium `getUserMedia` and an `AudioWorklet` deliver PCM to the voice worker; `uiohook` and `node-cpal` are not loaded.

Packaging smoke tests must prove that the worker, models, and native libraries exist and that no Companion executable or nested Companion application is present, but they cannot prove physical microphone or key-release behavior.

## Desktop shell ownership

Desktop keeps the main Jarvis renderer loaded as the single command
orchestration owner. `Ctrl+Shift+J` dispatches explicit start and release actions on supported
Windows/Linux hold paths, while `Command+Shift+J` on macOS (and Linux tap fallback) dispatches the tap-toggle action, without revealing the workspace; Desktop
owns only the compact always-on-top voice status overlay. On Windows and Linux,
closing the workspace window hides it to the tray while the backend, worker,
and shortcut remain alive. Tray actions are explicit: **Open Jarvis** reveals the workspace,
**Talk to Jarvis** / hold or tap labels dispatch the background voice action, and **Quit** enters
the normal ordered Electron shutdown path. Updater-controlled and explicit
quit paths synchronously disable the hide-to-tray latch before destroying
windows. The headless renderer orchestration consumer remains mounted while Jarvis is resident:
it selects only the originating Full node's focused task or sole local project as an implicit
target, lets explicit project phrases override that choice through the multi-node mesh, and consumes
the same durable report inbox and speaker lease for local and remote completion speech. A real-device acceptance pass must verify capture while hidden, keydown
start, keyup release (or portal Activated/Deactivated), and that both tray quit and window quit stop the hook,
portal session, worker, and microphone before exit.
