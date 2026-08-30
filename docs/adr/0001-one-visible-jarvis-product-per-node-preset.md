# One visible Jarvis product per node preset

Jarvis node presets are capability choices, not separate products that a user must coordinate. The unified installer must expose one Jarvis application identity, one launcher, and one uninstall entry: a Full node owns the desktop workspace, local execution, tray, hotkey, and speech; a Controller owns only the controller UI, tray, remote connections, and speech; a Headless node owns only the background runtime and has no voice capability. Full and Controller deliberately install the same signed Jarvis Desktop distribution. The selected preset changes the capabilities exposed by that distribution; it does not select a second Electron application or a separately updated payload. A Full or Controller installation may use helper processes internally, but Jarvis must own their lifecycle and connection state, and they must not appear as a second application that needs separate setup or pairing.

For the current Full voice stabilization, Windows and Linux x64 use one Electron runtime plus an isolated Node-mode worker, local Parakeet recognition, and the exact shared `node-cpal` `0.1.1` capture path. The product-owned Rust microphone path is no longer a production voice path. Full uses `uiohook` for true hold-to-talk; Electron `globalShortcut` is an explicit tap-toggle fallback when the native hook is unavailable. macOS microphone capture is deferred and makes no release claim.

## Considered options

- Keep installing Jarvis Desktop and Jarvis Companion as independent applications. Rejected because it creates two launchers, two setup flows, two connection directories, and ambiguous ownership of the tray and voice experience.
- Merge every implementation into one Electron process. Rejected as a release requirement because native speech isolation and independent task execution are valuable failure boundaries; one product identity does not require one process.
- Build a second Controller executable or embed separate Full and Controller desktop archives. Rejected because it duplicates Electron, native voice models, signing, update authority, and installer work while recreating two application lifecycles. Controller instead uses the shared Desktop distribution with execution, project, and provider capabilities denied at the server, provider-adapter, and client-routing boundaries.
- Use the product-owned Rust microphone path for Full voice. Rejected for production because the stabilized GUI capture contract is the shared `node-cpal` `0.1.1` path on Windows/Linux x64; Rust remains out of the production microphone boundary.
- Promise macOS microphone capture in this release. Deferred because the macOS path is not stabilized; macOS release artifacts must not claim microphone support.

## Consequences

Connection health is the authenticated Jarvis session state; Local, Tailscale, SSH, or Relay is secondary route metadata and never a blocking onboarding verdict. Installer-selected node capabilities are shown as subtle settings/status metadata instead of a repeated onboarding step. A Controller may contain dormant implementation bytes shared with Full, but it must not advertise or execute local projects, providers, or agent sessions; package contents are not permission boundaries. Native voice and workspace helpers share the owning installation's node directory and pairing lifecycle. Task completion and optional checkpoint/VCS capture are separate outcomes, so a checkpoint warning cannot replace a successful task result.

Full and Controller keep their application runtime resident when the workspace window closes. The
tray is an optional navigation and quit affordance, not the authority for background residency;
failure to create a tray icon must not disable the global hotkey, voice, or report lifecycle. The
dedicated Jarvis control-center route is the visible management surface. Explicit open actions must
not resurrect the earlier combined command dialog; voice capture may reuse hidden orchestration
internals without rendering that management UI.

CI, synthetic tests, and package smoke tests can prove protocol wiring, worker/resource presence, and
artifact topology; they cannot prove a microphone, permissions, device routing, or physical
key-release path. Windows and Linux x64 release candidates therefore require a short real-device
acceptance pass, including hold/release capture and ordered shutdown/quit verification.
