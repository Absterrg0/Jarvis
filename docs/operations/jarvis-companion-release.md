# Jarvis Companion release and test loop

Jarvis Companion uses an install-once Windows pipeline. Native microphone, global-hotkey, Piper, and updater behavior still need a real Windows package, but routine releases no longer require users to replace a 300+ MB ZIP manually.

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

## Fast feedback layers

1. Run focused unit and transport tests from the source checkout. These do not build Electron or download speech resources.
2. Use the **Release Jarvis Companion** workflow manually for a non-publishing Windows installer artifact. GitHub retains the installer, blockmap, and `latest.yml` for 14 days.
3. Publish a real update by bumping `apps/companion/package.json`, committing, and pushing an exact `jarvis-companion-v<version>` tag. The tag triggers the Windows workflow automatically.
4. An installed Companion checks the stable feed after 15 seconds and every 10 minutes. It downloads in the background and exposes **Restart to install** in the tray.

## Release invariant

The package version and tag must match exactly. The workflow rejects mismatches before building:

```text
apps/companion/package.json: 0.3.1249
tag:                         jarvis-companion-v0.3.1249
```

The published release must contain all three updater assets:

- `Jarvis-Companion-<version>-x64.exe`
- `Jarvis-Companion-<version>-x64.exe.blockmap`
- `latest.yml`

`latest.yml` points the installed app to the installer and checksum. The blockmap allows `electron-updater` to request changed blocks rather than the complete package when possible. Do not publish a ZIP-only release as the latest Companion release; it cannot advance installed clients.

## Manual test artifact

Run the workflow from **Actions → Release Jarvis Companion → Run workflow**. A manual run builds and verifies Windows but does not create or modify a GitHub Release. Download the `Jarvis-Companion-Windows-<run>` artifact only when testing installer/updater changes before publication.

## First migration

Users of the old extracted ZIP must fully quit its tray process and run one NSIS installer. Pairing, provider defaults, conversation mode, and task attention state remain under the same Electron application identity. After that migration, use the tray update action.
