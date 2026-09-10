# Install ARIS

ARIS runs coding agents on your computer and lets you control them from its
desktop, web, or mobile app. Set up the machine where the agents will work first.

## Requirements

Command-line use, SSH hosts, and WSL backends need Node.js 22.16+ (22.x), 23.11+
(23.x), or 24.10 and later. The native desktop app includes its server runtime.

You need an installed, authenticated provider before starting a thread. You can
launch T3 Code and configure providers afterwards.

## Run without installing

```bash
npx t3@latest
```

This starts the ARIS server on your machine and opens the local web app. Use
`npx t3@latest --help` for the full CLI reference.

## Desktop app

Download a release from [GitHub Releases](https://github.com/pingdotgg/t3code/releases),
or use a package manager:

| Platform           | Install                         |
| ------------------ | ------------------------------- |
| Windows            | `winget install T3Tools.T3Code` |
| macOS              | `brew install --cask t3-code`   |
| Arch Linux         | `yay -S t3code-bin`             |
| Arch Linux nightly | `yay -S t3code-nightly-bin`     |

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Connections** to run agents and projects
there. Install Node.js and provider CLIs inside that distro. T3 Code installs its
matching server runtime there automatically; the first launch after an app
update can take longer.

### Open a project from a terminal

With the desktop app already running on the same machine:

```bash
npx t3 app
```

This opens a new thread for the current directory, adding the project if needed.
Pass a path, such as `npx t3 app ../my-project`, to open another directory. It requires
the desktop app, so a standalone server or an SSH session is not enough. If the
command cannot reach the app, start or update the desktop app and try again.

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

## Mobile app

Install T3 Code from the
[App Store](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824) or
[Google Play](https://play.google.com/store/apps/details?id=com.t3tools.t3code).
The phone connects to a server on another machine. Follow
[remote access](./remote-access.md) to link it through T3 Connect or a pairing URL.

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider    | Install and authenticate                                                                     |
| ----------- | -------------------------------------------------------------------------------------------- |
| Codex       | Install [Codex CLI](https://developers.openai.com/codex/cli), then run `codex login`.        |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`. |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                        |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                           |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                     |
| Antigravity | Install and sign in with Google from ARIS provider settings.                                 |

Provider CLIs must be on the server's `PATH`. If ARIS cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Antigravity can use its managed runtime without a `PATH` entry.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** appears only when ARIS can tell which
installer owns the CLI (its own update command, Homebrew, or a global npm, pnpm,
bun, or Vite+ install) and runs that installer. Otherwise update the CLI the same
way you installed it. Homebrew installs compare against the version Homebrew
offers, which can trail the npm release by a few hours.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, ARIS does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md), and
[Antigravity](./providers-antigravity.md).

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): how much ARIS asks before acting.
- [Remote access](./remote-access.md): connect from a phone, tablet, or another desktop.
- [Headless Node](./headless-node.md): run an execution node on a Linux VPS.
- [Running in the background](./background-service.md): keep a Linux or macOS host available.
- [Updating ARIS](./updating.md): update the app and connected servers.
