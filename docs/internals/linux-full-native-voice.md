# Linux Full native voice architecture

Linux Full ships one visible Jarvis application and one Electron runtime. Jarvis Desktop owns the global shortcut, command UI, local execution, voice lifecycle, and renderer bridge. Native speech runs in an isolated Node-mode child launched through the Electron executable already packaged with Desktop; Linux Full must not embed or launch the standalone Companion application or another Chromium/Electron distribution.

The native speech implementation is a shared deep module. Its interface exposes speech preparation, capture, transcription, synthesis, interruption, state, and events while hiding Parakeet, Kokoro, audio-device, worker, and model-lifecycle details. Both Desktop and the standalone Companion consume this module. Desktop communicates with its speech child through a bounded typed protocol and remains responsible for startup, restart, shutdown, and user-visible errors.

Offline voice models and the platform-specific native libraries are part of Linux Full and are staged once under the owning Desktop installation. They account for a material size increase over a non-voice Desktop build; a second application runtime does not. The standalone Companion remains independently installable for an additional remote voice/control device and is not a runtime dependency of Linux Full. Windows continues to use its existing unified-setup resource layout; changing that installer is outside this Linux decision.

## Considered options

- Embed the complete Companion unpacked application inside Linux Full. Rejected because it duplicates Electron/Chromium, keeps two application implementations alive inside one artifact, inflates the package, and makes Full depend on Companion pairing semantics it does not need.
- Run native speech in Desktop's main process. Rejected because native audio/model failures and memory pressure should not take down the workspace shell.
- Bundle a separate Node runtime. Rejected because Electron already supports the required Node-mode worker and another runtime adds size without improving the seam.
- Download voice models after installation. Deferred because Full currently promises self-contained offline voice. It can be introduced later as an explicit optional voice-pack policy without changing the shared module interface.

## Consequences

Full onboarding reports local voice capability/readiness and never pairs with a hidden Companion. The integrated Jarvis command UI receives native transcripts and uses native synthesis, with browser speech only as a non-Desktop fallback. Linux initially preserves tap-to-talk through Electron's global shortcut; hold-to-talk is not promised until native key-release behavior is validated across supported desktop environments. Packaging smoke tests must prove that the worker, models, and native libraries exist and that no Companion executable or nested Companion application is present.

## Desktop shell ownership

Desktop keeps the main Jarvis renderer loaded as the single command
orchestration owner. `Ctrl+Shift+J` dispatches `jarvis.voice-toggle` to that
renderer without revealing the workspace; Desktop owns only the compact
always-on-top voice status overlay. On Windows and Linux, closing the workspace
window hides it to the tray while the backend, worker, and shortcut remain
alive. Tray actions are explicit: **Open Jarvis** reveals the workspace,
**Talk to Jarvis** dispatches the background voice action, and **Quit** enters
the normal ordered Electron shutdown path. Updater-controlled and explicit
quit paths synchronously disable the hide-to-tray latch before destroying
windows.
