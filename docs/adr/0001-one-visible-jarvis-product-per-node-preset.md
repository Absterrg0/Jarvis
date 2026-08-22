# One visible Jarvis product per node preset

Jarvis node presets are capability choices, not separate products that a user must coordinate. The unified installer must expose one Jarvis application identity, one launcher, and one uninstall entry: a Full node owns the desktop workspace, local execution, tray, hotkey, and speech; a Controller owns only the lightweight controller/tray surface and opens a paired Host workspace when detailed UI is needed; a Headless node owns only the background runtime. A Full or Controller installation may use helper processes internally, but Jarvis must own their lifecycle and connection state, and they must not appear as a second application that needs separate setup or pairing. The standalone Companion installer remains available only for an additional remote voice/control device and is not co-installed as another user-facing product by Jarvis Setup.

## Considered options

- Keep installing Jarvis Desktop and Jarvis Companion as independent applications. Rejected because it creates two launchers, two setup flows, two connection directories, and ambiguous ownership of the tray and voice experience.
- Merge every implementation into one Electron process. Rejected as a release requirement because native speech isolation and independent task execution are valuable failure boundaries; one product identity does not require one process.
- Treat Controller as the complete desktop package without execution. Rejected because it duplicates a large local workspace shell when the authoritative workspace is already served by the paired Host.

## Consequences

Connection health is the authenticated Jarvis session state; Local, Tailscale, SSH, or Relay is secondary route metadata and never a blocking onboarding verdict. Installer-selected node capabilities are shown as subtle settings/status metadata instead of a repeated onboarding step. Native voice and workspace helpers share the owning installation's node directory and pairing lifecycle. Task completion and optional checkpoint/VCS capture are separate outcomes, so a checkpoint warning cannot replace a successful task result.
