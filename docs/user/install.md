# Install ARIS

ARIS is a web and desktop GUI for running coding agents on your machine.

## Requirements

Node.js `^22.16 || ^23.11 || >=24.10` on the machine that runs the ARIS server.

At least one provider CLI, installed and authenticated. See [Providers](#providers) below.

## Run Without Installing

```bash
npx t3@latest
```

This starts the ARIS server on your machine and opens the local web app. Use
`npx t3@latest --help` for the full CLI reference.

## Desktop App

Download the latest release from
[GitHub Releases](https://github.com/pingdotgg/t3code/releases), or install from a package
registry.

Windows:

```bash
winget install T3Tools.T3Code
```

macOS:

```bash
brew install --cask t3-code
```

Arch Linux:

Stable:

```bash
yay -S t3code-bin
```

Nightly:

```bash
yay -S t3code-nightly-bin
```

### Windows unified installer

Windows releases use one installer, `Jarvis-Setup.exe`, with one ARIS application identity,
launcher (`ARIS.lnk` on the Desktop and in the Start Menu `ARIS` folder, still targeting the
preserved `desktop\Jarvis.exe`), and uninstall entry in Installed Apps. Installing or
uninstalling also removes legacy `Jarvis.lnk` shortcuts. Choose the node role during setup:

- **Full** owns the desktop workspace, managed voice, and local execution.
- **Controller** is the lightweight controller and voice surface. It opens the paired Host
  workspace when you need detailed UI and does not install a local desktop workspace or runtime.
- **Headless** installs only the background execution runtime. It has no desktop UI or voice
  surface.

The installer stores the selected role in `%USERPROFILE%\.jarvis\config` and preserves user data
under `%USERPROFILE%\.jarvis\userdata` when you upgrade or uninstall. To remove ARIS, use its
single entry in Windows **Installed Apps**; this removes the managed product and its helpers
without creating a second uninstall flow. Provider credentials and authentication remain on the
machine where each provider is configured; a Controller does not copy them from another node.

### Linux Full

The Linux `Jarvis-<version>-x86_64.AppImage` is the Full node: one ARIS desktop application with
the workspace, local execution, global shortcut, and offline native voice included. Full uses its
own isolated speech worker and the Electron runtime already present in ARIS.

Download the AppImage, make it executable, and launch it:

```bash
chmod +x Jarvis-<version>-x86_64.AppImage
./Jarvis-<version>-x86_64.AppImage
```

Full releases are updated manually: replace the AppImage with the newer one and launch it again.

The offline Parakeet and Pocket models make Linux Full substantially larger than a desktop-only
build. They remain local after installation and do not require a browser speech service.

## Providers

ARIS drives provider CLIs; it does not ship them. Install the CLI for each provider you want
to use, then authenticate it.

| Provider   | CLI                                                   | Default binary | Log in with           |
| ---------- | ----------------------------------------------------- | -------------- | --------------------- |
| Codex      | [Codex CLI](https://developers.openai.com/codex/cli)  | `codex`        | `codex login`         |
| Claude     | [Claude Code](https://claude.com/product/claude-code) | `claude`       | `claude auth login`   |
| Cursor     | [Cursor CLI](https://cursor.com/cli)                  | `cursor-agent` | `agent login`         |
| Grok Build | [Grok Build CLI](https://x.ai/cli)                    | `grok`         | `grok login`          |
| OpenCode   | [OpenCode](https://opencode.ai)                       | `opencode`     | `opencode auth login` |

Codex and Claude are on by default. Cursor, Grok Build, and OpenCode are off by default; turn
them on in **Settings** → the provider's card when you want to use them.

Cursor is the one to watch: install Cursor CLI, which provides the `cursor-agent` binary that
ARIS looks for, but authenticate with `agent login`, not `cursor-agent login`.

Run the login command on the machine running the ARIS server, not on the device you browse
from.

### Binary Discovery

Each provider CLI must be on the server's `PATH`, or have an explicit binary path set in
**Settings** → the provider instance → **Binary path**. Use the explicit path when a version
manager or a non-standard install location keeps the CLI off the `PATH` of the shell that
started ARIS.

### When Auth Is Needed

Provider auth is required before you start a session with that provider, not before you start
ARIS. You can install ARIS, open it, and add providers afterwards. A provider that is not
authenticated shows its status in **Settings** and fails at session start with the login command
to run.

For multi-account setups, see [Codex](./providers-codex.md) and [Claude](./providers-claude.md).

## Next Steps

- [Permission modes](./permission-modes.md): how much ARIS asks before acting
- [Remote access](./remote-access.md): connect from a phone, tablet, or another desktop
- [Headless Node](./headless-node.md): run an execution node on a Linux VPS
- [Keeping ARIS in sync](./updating.md): client and server version skew
- [Running in the background](./background-service.md): Linux background service
