# Jarvis Companion release and test loop

Jarvis Companion is an optional speech/control-only device, not a Host or execution runtime. It is
released as a Windows x64 NSIS installer and a Linux x64 AppImage; neither artifact should be
installed beside Full on the same machine. Companion's local Parakeet path uses the exact shared
`node-cpal` `0.1.1` capture contract for the stabilized Windows/Linux x64 scope. Native microphone,
permissions, device routing, and global-hotkey behavior still require a physical Windows and Linux
interaction pass; CI and package smoke tests cannot prove those conditions. Routine Windows
releases no longer require users to replace an archive manually; Linux users replace the AppImage
when they choose to update. macOS microphone capture is deferred and is not a release claim.

## Local Companion loop

Run this from a checkout when iterating on the Companion:

```bash
vp run --filter @jarvis/companion dev
```

It watches the Electron bundles, restarts only the Companion process it launched, and keeps its
pairing/defaults in `apps/companion/.jarvis-companion-dev`. That state is deliberately separate
from an installed Companion, so a test pairing survives restarts without changing a user's
release configuration. It neither packages an installer nor enables update checks.

Pass text through the same routing and Host submission path used after a transcript:

```bash
vp run --filter @jarvis/companion dev -- --inject-text="In Rivvl, run the focused tests"
```

The optional `--simulate-report=completed`, `waiting-for-input`, `approval-needed`, or `failed`
renders and speaks the corresponding report treatment without touching a Host task. Development
diagnostics append compact JSON lines to
`apps/companion/.jarvis-companion-dev/diagnostics.jsonl`, showing transcript receipt, catalog and
project resolution, clarification, and Host dispatch results. They are enabled only by this local
development launcher and never in a release invocation.

When a scenario is explicitly selected, the Parakeet capture path also retains the exact 16 kHz microphone WAV
under a unique directory in `apps/companion/.jarvis-companion-dev/recognition-recordings`. Label a
capture with one of the stable scenario IDs while speaking its sentence:

```bash
vp run --filter @jarvis/companion dev -- --recognition-scenario=rivvl-pull-request
```

The launcher keeps at most 20 labeled captures and writes a `scenario.json` beside each WAV so
diagnostics can be joined to the exact capture without retaining microphone audio indefinitely.
These local development recordings may contain sensitive speech; delete the recording directory
when a comparison session is finished.

The scenario catalog lives in `src/recognition-evaluation.ts` and covers a Rivvl pull request,
immediate first-word retention, provider/model routing, and a multi-segment follow-up. The same
module scores raw word and character error rates, raw entity accuracy, and post-vocabulary grounded
entity accuracy separately. It then summarizes readiness/final latency, CPU time, observed peak
memory, and packaged resource bytes per engine. Capture IDs, scenario IDs, recording paths, engine,
latency, CPU, memory, and resource-size metadata are written to the development trace. The scorer remains the regression gate for the selected
Parakeet 110M INT8 adapter; a Windows benchmark run must supply real transcripts and resource
observations rather than inferring quality from unit tests.

## Fast feedback layers

1. Run focused unit and transport tests from the source checkout. These do not build Electron or download speech resources.
2. Use the **Release Jarvis Companion** workflow manually for non-publishing Windows and Linux
   artifacts. The Windows job downloads and verifies both model archives, loads and exercises the
   native ASR/TTS libraries, builds the installer, then launches the packaged executable to load
   both models from its installed layout. The Linux job builds the AppImage and verifies its
   native resources and packaged modules. GitHub retains both platform artifacts for 14 days.
3. Publish a real update through `.github/workflows/jarvis-release.yml`. The coordinator reads the
   independent `apps/companion/package.json` version, builds Companion in parallel with Full, and
   stages its five updater assets into the same release transaction. It does not renumber
   Companion to the Full version, and Companion has no separate tag or publisher.
4. Stable publication is currently closed while Companion Windows artifacts remain unsigned. Use
   the coordinator's `preview` channel for unsigned validation; do not bypass the transaction or
   publish Companion separately. An installed Windows Companion checks the stable feed after 15 seconds and every 10 minutes.
   It downloads in the background and exposes **Restart to install** in the tray. Linux users
   update by replacing their AppImage.

## Real-device acceptance boundary

Before calling a Windows or Linux x64 Companion artifact voice-ready, hold `Ctrl+Shift+J` while
the app is visible and hidden, confirm one capture start and one release, and verify the selected
microphone and OS permission path. Exercise both tray quit and application quit; the hook, worker,
and microphone must stop before process exit. These checks complement, but cannot be replaced by,
synthetic tests.

## Release invariant

The Companion package version is independent from Full and must match the version exposed by the
coordinator before building:

```text
apps/companion/package.json: 0.3.1257
coordinator companion_version: 0.3.1257
```

The unified release transaction must contain exactly these Companion assets in addition to the Full
asset set:

- `Jarvis-Companion-<version>-x64.exe`
- `Jarvis-Companion-<version>-x64.exe.blockmap`
- `latest.yml`

`latest.yml` points the installed app to the installer and checksum. The blockmap allows `electron-updater` to request changed blocks rather than the complete package when possible. Do not publish a ZIP-only release as the latest Companion release; it cannot advance installed clients.
The Linux side of the same release must also contain:

- `Jarvis-Companion-<version>-x86_64.AppImage`
- `latest-linux.yml`

`latest.yml` points Windows clients to the installer and checksum. The blockmap allows
`electron-updater` to request changed blocks rather than the complete package when possible. Linux
users replace the AppImage when updating. Do not publish a ZIP-only release as the latest Companion
release; it cannot advance installed Windows clients.

## Manual test artifact

Run the workflow from **Actions → Release Jarvis Companion → Run workflow**. A manual run builds
and verifies Windows and Linux but does not create or modify a GitHub Release. Download the
`Jarvis-Companion-Windows-<package-version>` artifact for installer/updater changes or
`Jarvis-Companion-Linux-<package-version>` for AppImage/resource changes before publication.

## First migration

Users of the old extracted ZIP must fully quit its tray process and run one NSIS installer. Pairing, provider defaults, conversation mode, and task attention state remain under the same Electron application identity. After that migration, use the tray update action.
