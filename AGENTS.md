# Jarvis

Jarvis is the product shipped from this repository. It adds deterministic voice control, task navigation, multi-node routing, and spoken reports to the T3 coding foundation. Provider CLIs still do the coding work. Jarvis gives the user one assistant for directing that work across machines.

This fork does not ship a second, independently supported T3 Code application. Full, Controller, Headless, and the optional Companion are Jarvis capability presets.

## What makes Jarvis special?

### 1. One product

Jarvis should feel like one application even when several processes or machines are involved. Full and Controller share one desktop identity. Headless is the background execution node. Companion is an optional speech and control device, not another host or workspace app.

Do not create duplicate launchers, setup flows, node directories, update authorities, or competing owners for the tray, hotkey, and voice lifecycle.

### 2. Voice must be trustworthy

Spoken control is useful only when it acts on the task the user meant. Jarvis resolves projects and tasks against real, bounded catalogs. It asks for clarification when names are ambiguous. A model may normalize language later, but it never invents IDs, chooses an ambiguous target, authorizes a tool, or dispatches a command directly.

Keep clarification, confirmation, focus, and correction as typed state. Do not hide routing instructions in provider prompts or treat visible UI attention as authority.

### 3. Remote ready

Nodes own their projects, providers, credentials, workspaces, and event stores. A `ProjectRef` or `TaskRef` stays qualified by its execution node. If that node disconnects, report the disconnection. Never move work to another node silently.

Local, LAN, Tailscale, SSH, relay, and tunnel connections are different routes to the same authenticated node. New work must behave correctly across reconnects, multiple devices, and multiple nodes.

### 4. Performance without compromise

Voice workers, report subscriptions, task lists, and WebSocket traffic can make a coding app feel bad quickly. Disabled voice clients must stay idle. Avoid polling when an event can wake the client. Avoid continuously repainting animations. Keep hot UI paths small and load heavy Jarvis UI only when needed.

### 5. Open and provider-neutral

Jarvis is open source. Keep core product behavior inspectable in this repository. Jarvis works through the existing provider adapters for Codex, Claude, Cursor, Grok, and OpenCode. Do not create a Jarvis-only provider execution path. A provider-specific feature needs an explicit decision for every adapter.

## How to work here

Favor ambitious behavior with a small model. Do not preserve complexity because it already exists, and do not add machinery because it looks reusable. Find the real constraint, then choose the smallest design that makes correct behavior unsurprising.

Read and apply `.agents/skills/unslop/SKILL.md` and `.agents/skills/forward-implementation-first/SKILL.md` on every turn. Keep updates concrete and easy to scan. Lead with what changed or what you are doing. Cut canned phrases, vague claims, and long preambles.

Most work on Jarvis is performed through Jarvis itself, often from another machine. Treat live processes, ports, and user data as part of the developer's active environment.

## A small glossary

- **Jarvis** is the only product shipped by this fork.
- **T3** is the inherited coding foundation: orchestration, providers, Git, terminals, approvals, contracts, and the detailed coding UI.
- **node** means one running server and the machine, projects, provider credentials, and state it owns.
- **Full** means desktop workspace, local execution, tray, hotkey, and supported speech capabilities.
- **Controller** means desktop control, remote connections, tray, hotkey, and supported speech, without local execution.
- **Headless** means background execution without desktop or voice capability.
- **Companion** means the optional speech and control app for another device. It is not an execution node.
- **project** means a node-local workspace record rooted at a directory.
- **thread** means the durable provider conversation and work history for a project.
- **task** means the Jarvis-facing reference to work in a thread, including its execution node.
- **turn** means one user-to-agent cycle, including follow-up work such as checkpointing and reporting.

## The Jarvis/T3 boundary

The dependency direction is deliberate: Jarvis may use public T3 contracts and services. T3 provider, session, Git, terminal, and approval implementations must not import or understand Jarvis voice, mesh, task-desk, report, or product concepts.

Use these integration points:

1. Typed contracts in `packages/contracts`.
2. Public T3 service interfaces and adapters.
3. Top-level composition in server, web, and desktop entrypoints.
4. Shallow startup, capability-discovery, build, packaging, and branding hooks.

Do not add Jarvis callbacks or special cases inside provider, session, Git, terminal, or approval internals. Do not put Jarvis fields into a generic domain model just to save an adapter. Do not invent probe endpoints, extension bags, or a callback framework for one Jarvis caller. If the public seam is missing, add either a narrow generic interface with a real T3 meaning or one explicit Jarvis composition patch.

The documented exceptions are intentional:

- `ExecutionEnvironmentCapabilities.jarvisNode` and `jarvisReportInbox` are public capability markers.
- Jarvis preset fields in central server configuration are startup plumbing.
- Shared wire contracts may name Jarvis when the message itself is public product behavior.
- Jarvis migrations 41 through 46 and upstream migration 47 are shipped IDs. Never renumber them.

There is no acceptance requirement for a standalone pure-T3 build from this fork. There is a requirement that the T3 behavior Jarvis depends on still works after an upstream merge. Read `docs/internals/jarvis-t3-boundary.md` before changing this boundary or resolving upstream conflicts.

## The three ways to hurt yourself

1. **Killing by pattern.** Never use `pkill -f`, `pgrep | kill`, or a PID found by matching a name, path, or worktree string. Kill only a PID captured when you started the process, or a port owner verified through `/proc/<pid>/cwd`.
2. **Writing to the live install.** `~/.t3/userdata` is the developer's real Jarvis database. Never start a development server against it, open it read-write, or clean it up.
3. **Baking in origins.** Never set `VITE_HTTP_URL` or `VITE_WS_URL` for development. Vite proxies `/api`, `/ws`, `/oauth`, and `/.well-known`; baked localhost URLs break remote clients.

## Hit every applicable path

Before calling user-facing work done, check what the change touches:

- **Presets.** Full, Controller, Headless, and Companion have different capabilities. Package contents do not grant permission to execute.
- **Entry points.** Chat, the Jarvis control center, Settings, command palette, keybindings, tray, and voice may reach the same behavior.
- **Clients.** Web and desktop share UI, desktop adds Electron and native voice, mobile is separate React Native code, and Companion has no normal workspace window.
- **Providers.** Jarvis policy stays provider-neutral and uses the ordinary provider adapters.
- **Contracts.** A wire change requires schema, server, and every affected client to agree.
- **Reverse states.** Add the way out and the way to inspect it. Learned aliases need removal; pairing needs disconnection; pending work needs cancellation.
- **Connections.** Check local, remote, reconnect, multi-device, and multi-node behavior where relevant.
- **Docs.** Put shipped behavior in `docs/user`, architecture in `docs/internals`, runbooks in `docs/operations`, and new domain terms in `docs/internals/glossary.md`.

## Dev servers

- `vp i` installs dependencies. Worktree setup normally runs it for you.
- `vp run dev` starts server and web with worktree-local `.t3` state. Read the actual ports and pairing URL from the `[dev-runner]` output.
- `vp run dev --share` exposes the development instance over the tailnet. Hand the user the full `pairingUrl`, including its token. Do not configure `tailscale serve` manually.
- If a pairing token was consumed, mint another with `node apps/server/src/bin.ts pair`.
- Stop only processes you started and tracked.

## Test data

An empty database is weak test data. Copy a consistent snapshot into the worktree instead of pointing development at live state.

Use SQLite `VACUUM INTO` against the live database in read-only mode. Put the result under `<worktree>/.t3/userdata`. A plain copy of a live SQLite file is unsafe unless its WAL and SHM files are copied consistently too. Copy state into the sandbox; never symlink the sandbox back to live state.

Bring secrets or settings only when the flow under test needs them.

## Verifying

- Run the smallest proof: `vp test run <files>` for touched tests, plus targeted lint and typecheck for changed packages.
- Do not run repo-wide checks such as `vp check`, `vp run -r test`, or `vp run -r typecheck` unless asked. CI owns the full suite.
- Backend behavior changes need focused tests. Event-sourced async tests wait on typed receipts and worker drains, never sleeps or polling.
- Voice tests can prove protocol wiring, ordering, worker lifecycle, and artifact contents. They cannot prove a real microphone, OS permission, audio routing, or physical key release. Release candidates need the applicable real-device acceptance pass.
- Do not launch browsers, simulators, or other computer-control verification unless the user asks or agrees.

## Pull requests

- Never create a PR unless the developer explicitly asks.
- Use conventional, plain-language titles such as `fix(jarvis): preserve task focus`.
- Keep one concern per PR. Explain the problem, then the fix.
- UI changes need before/after images. Motion, timing, hotkeys, or voice interaction changes need a short video when they can be captured.
- Do not commit PR-only screenshots or videos to the repository.
- When babysitting a PR, inspect checks and comments newer than the last push. Verify bot findings against the source, fix real problems, and explain false positives. Stop when the latest commit is green.

## Plans and work artifacts

- Do not commit implementation plans, research notes, or agent scratch files.
- Keep durable architecture and constraints in `docs/internals`, not in a second implementation checklist.
- Track active work in its issue or project item. The merged PR is the implementation record.

## How it works

A Jarvis request is grounded against real node, project, provider, and task catalogs. The deterministic Director returns a closed control plan. Server-side Jarvis adapters translate that plan into ordinary typed orchestration commands.

The T3 engine persists events and derives the read model. Provider adapters run the selected CLI. Queue-backed reactors handle provider ingestion, checkpoints, Jarvis follow-ups, and completion reports. A successful provider result is the task outcome; checkpoint capture is optional bookkeeping and must not replace or suppress that result.

Jarvis reports retain their exact `TaskRef` and origin interaction. Clients elect one speaker, persist delivery state, and acknowledge only after synthesis succeeds. Reconnects and startup replay must not duplicate work or speech.

The full vocabulary is in `docs/internals/glossary.md`.

## Where code lives

- `apps/server` owns execution, orchestration, persistence, providers, and the server-side Jarvis adapters.
- `apps/web` is the React/Vite workspace; `apps/desktop` wraps it with Electron, local execution, tray, hotkey, and native voice integration.
- `apps/companion` is the optional tray-only speech and control app. `apps/mobile` is the separate React Native client.
- `packages/contracts`, `packages/client-runtime`, and `packages/shared` are generic T3 seams.
- `packages/jarvis-core`, `packages/jarvis-client-runtime`, and `packages/jarvis-native-voice` contain Jarvis-owned policy and runtime code.
- `.repos` contains read-only references. Never edit or import from it.

## Taste

- Keep orchestration pure, adapters explicit, and UI state derived from typed domain state.
- Prefer inferred types. Avoid `any`, unsafe assertions, and barrel imports.
- Comments explain how a function or boundary is used. Do not narrate individual lines.
- A dropped frame, stale label, false success report, repeated sentence, or lying spinner is a product bug.
- If a rule here conflicts with the task, explain the conflict and get explicit approval before breaking it.
