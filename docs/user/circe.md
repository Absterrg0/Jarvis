# Circe

Circe lets you direct coding agents with text or voice and hear their real results on a connected device or paired node. T3 remains the manager: Codex, Claude, Cursor, Grok, OpenCode, and configured provider instances remain workers that T3 starts and links.

## Open Circe

- Choose the Circe mark in the workspace sidebar to open **Circe Control Center**.
- Open the command palette and choose **Open Circe** to reach the same control center.
- In the desktop app, `Ctrl+Shift+J` (`Command+Shift+J` on macOS) toggles the live conversation without opening the control center.

The control center shows every paired node in one environment view. Select a device to inspect its
role, reachability, capabilities, projects, and provider readiness. Device connection management,
provider configuration, setup, and report-speaking preferences are available from that page. Each project and provider stays attached to the device
that owns it; the control center does not merge credentials or workspaces between nodes.

The desktop's own node is listed first as **This device**, alongside connected and offline remote
nodes. Connection changes update the mesh automatically; **Refresh** reloads project and provider
details.

### Desktop activity dot

Full and Controller desktops show a small dot at the right edge of the screen. Headless has no overlay. Its collapsed
window is 48 × 48 pixels, leaving the rest of the screen available to other apps.
Click it to open providers and running agents. Click again or press Escape to
close the panel. The dot stays in the same position as the panel opens.

A green dot indicates a live conversation or agent work. Idle is gray; waiting
and disconnected agents have explicit labels in the panel. Agent entries include
their provider and device, and the list scrolls when necessary. Selecting a
provider changes the default for new tasks. The panel has no chat composer.

The command center's task desk has **Recent tasks** and **Running agents** views.
Both follow task updates across connected devices. Open a task to inspect it.
The device sidebar contains providers, projects, and expandable node settings.
The command center follows the app's light or dark appearance and stacks its
columns on narrow screens. Reduced motion keeps status changes visible without
animation.

### Choose the agent for voice tasks

Select an execution device in **Circe Control Center**, then use **Default agent for new tasks**
to choose its provider, model, and available model options. Save the selection. If the provider is
not ready, use **Providers → Configure** on that device to install or sign in first.

This preference is saved on the selected device and applies to new Circe tasks executed there,
including requests sent from another device. An explicit spoken choice overrides the default.
Existing tasks and their follow-ups keep their original agent. Choose **Use project defaults** and
then **Save** to clear the Circe-specific choice.

## One Circe product per node

The Windows unified installer presents one Circe application, launcher, and uninstall entry. The
Linux Full AppImage likewise provides the workspace and local execution through one
Circe application. The selected node role changes its capabilities, not its product identity:

- **Full** owns the desktop workspace and local execution.
- **Controller** is a lightweight controller surface and opens a paired Host workspace when
  detailed UI is needed; it has no local desktop workspace or runtime.
- **Headless** is the background execution runtime only.

## Command composer in Control Center

The control center has a composer beneath the **Task desk**. Text is
always usable there. Pick an explicit project target such as **Rivvl — Laptop**,
optionally pick one of its recent tasks, type the instruction, and choose **Send**.
The current target line stays visible, for example
**Rivvl — Laptop · Review task** or **Choose where to work**. Choose **Clear**
to reset it. A disconnected selection stays put and reads
**(unavailable)**; it never moves to another node on its own.

One feedback lane shows every submission. Text entries stay visible and never
auto-speak; voice entries speak the same text aloud. Submissions move through
visible stages with no filler speech while Circe waits: a silent receipt first
(`Heard: "..."` text, truncated past 140 characters, never spoken), then
`Heard "...", checking...` at dispatch, still silent. The target line reads
`(provisional, not yet accepted)` until the Host answers. There is no speech
while the semantic supervisor runs. The supervisor may propose one short
present-progress sentence (at most 120 characters). Circe speaks it only after
Host validation and dispatch acceptance, and only for voice turns that start
provider work; text turns stay silent. The sentence is feedback only: it cannot
select a task, authorize a tool, change the instruction, or claim success.
A proposal that names a project, provider, or task outside the accepted command,
claims completion, or runs long is replaced by a derived acceptance naming the
accepted target, such as `Request accepted for Rivvl.` `Working on it.` is
used only when the catalog no longer names the target.

A submission on the wire can still be cancelled before acceptance by its exact
request identity (`requestId` plus execution node and origin). `Cancelled`
means nothing was dispatched, and a retry after a recorded cancel stays
cancelled instead of running again. `Already-accepted` means the dispatch
succeeded and the work runs under the returned thread, task, and project
identity and keeps running; the lane then
reads `That request was already accepted. Watching for its result.`
A cancel that lands while the commit is in flight waits for the dispatch
receipt and reports `unknown` when the commit failed. Success is never claimed
before the receipt. `Unknown` keeps waiting for the receipt instead of claiming anything. Cancel
never touches provider internals. It cannot stop provider work after
acceptance. To stop running provider work, say `stop`; that interrupts the
turn and cancels its queued follow-ups. A new capture or correction cancels the
previous in-flight request by that same identity while it queues behind; if the
old request already committed, its acknowledgement arrives first and the correction
runs as a follow-up. Typing **cancel** while a
question waits sends that exact `clarificationFrameId` back
to its node for verified cancellation; a missing or replaced frame retires
locally without claiming a cancel happened, and a failed cancel keeps the
question waiting. The **Cancel** button discards waiting and failed local
submissions and sends that exact-identity cancel for the in-flight request; it
does not stop provider work after acceptance. Answering a task with more than
one live request, or answering a request that already closed, returns a short
message that names the current state instead of acting on the stale pin.
Retries reuse the same request identity and stored payload even if the desk or
catalog changed since. Retired request records age out of a bounded store, so a
very old cancel answers `unknown`.

When a task's provider asks a question, Circe speaks it once and you can answer it in any later voice turn, even while another task is focused: the answer goes to the task that asked. The control center shows the waiting task with a **Needs answer** state if you would rather answer there.

Circe Host keeps a bounded list of recent task identities for each connected device. To switch by name, use explicit task language such as “Switch to the Rivvl review task.” If more than one recent task matches, Circe asks you to choose instead of guessing. Starting another conversation creates the task immediately once the request includes an objective.

Circe targets the current project and thread. When T3 has just spoken a report, it remembers the exact thread that produced it and shows that thread as the target for your reply. The visible highlight and any spoken progress sentence are feedback only. The typed target plus Host validation decide where the command runs.

A background desktop voice instruction without an explicit project stays local: the Full node's focused task wins, with a lone local project as fallback. Remote nodes stay opt-in through an explicit project phrase.

Project switching is grounded in the projects connected to T3. Circe matches project titles, workspace directory names, repository names, and saved aliases. An explicit destination such as “In Rivvl, …” or “… in Rivvl” routes to the owning node on text and voice alike through the same shared spans the clients use for node routing. A destination wrapper preceded by another project name does not route: Circe asks with the competing projects instead, for example when the wording names Circe first and Rivvl in a wrapper. Close pronunciations such as “Ripple” for “Rivvl” produce a confirmation before Circe changes the target; saying yes resumes the original request instead of starting a new one. That confirmed pronunciation is saved on Circe Host, so every paired device can recognize it directly next time. A name heard on more than one node asks you to choose instead of guessing, and a name on a disconnected node is reported unavailable instead of falling back. Recognition is not always correct: uncertain matches ask before anything runs.

Circe resolves the project and control action before starting a coding agent. What dispatches is always the deterministic resolution of the original transcript: the original wording minus the justified destination wrapper, or the original unchanged when no destination span is justified. The model proposal only proves wording was offered; its instruction text never dispatches, and there is no fidelity reject. Requests that join two actions into one turn, and destructive requests the transcript negates, are refused as unsupported instead of partially running. The original transcript is kept separately for diagnostics and is never added to the visible prompt.

Known semantic boundaries: a correction that denies a project without settling on one, such as “No I meant VPS deployment not Rivvl, verify health”, asks which project should receive the task instead of defaulting. Joining two independent commands in one turn (“Fix auth then add release notes”) is unsupported: Circe answers with needs-input and nothing dispatches. An open-ended or ambiguous request makes no claim: Circe asks for the missing detail instead of guessing.

## Route work

Name the provider, model, effort, and objective naturally:

```text
Use Codex Sol at high effort to implement device presence.
```

T3 resolves those names against the providers and models available in the selected environment. It asks for clarification instead of silently substituting another provider, model, or effort. If you replace a provider or change its account, select the new provider in **Default agent for new tasks** and save it; an unavailable selection is reported clearly instead of being replaced with a different agent.

Circe uses a separate semantic supervisor—Codex Luna at low reasoning by default—to understand natural phrasing. That supervisor only proposes an action and visible catalog names. It runs without project access or tools. Circe Host still validates the real project, task, provider, model, effort, and any pending approval, then reloads the selected task immediately before dispatching through the ordinary T3 provider adapter. The supervisor never chooses internal IDs or authorizes tools, and changing it does not change the coding agent selected for your task.

To review one provider's output with another, open the source thread and ask:

```text
Use Fable to review this Codex output.
```

T3 creates a linked review thread, copies the latest final assistant output into an explicitly delimited review prompt, and records the relationship on both threads.

## Talk and listen

Voice is one full-duplex live conversation. Add an OpenAI API key under the node's **Live conversation** settings, then press **Live conversation** in the command row or tap `Ctrl+Shift+J` (`Command+Shift+J` on macOS). The microphone stays open while Circe listens and speaks at the same time, so you can interrupt, correct yourself, and keep talking while work runs. Press **End conversation**, or tap the same shortcut again, to close the session and release the microphone.

Name a project explicitly, for example **"In Rivvl, review the failing tests"**, to route through the Circe mesh to the owning node; without a name the request stays on the current target. Each utterance is submitted as its own request in speaking order, so a second utterance waits for the first without being joined to it. You can keep speaking while an earlier request is being routed, and typed edits remain in the instruction draft. There is no speech while the supervisor runs, and there is no waiting filler. The supervisor may propose one brief progress sentence, but Circe keeps it beside the command and speaks it only after validation and dispatch acceptance for a command that starts provider work, such as **"Taking a look at the auth."** That sentence is feedback only: it cannot select a task, authorize a tool, change the instruction, or claim the work succeeded. Circe asks aloud when a target or other detail is ambiguous and speaks a bounded live completion presentation when the provider finishes. If live voice reports an error, use **Retry** or speak the next request; submitted tasks remain in T3.

If an uncommon project name still sounds like ordinary words, Circe asks before routing the task. After you confirm it, Circe remembers that pronunciation and corrects later requests.

Closing the Full or Controller workspace window keeps Circe resident so its hotkey and live presentation relay can remain available. A supported desktop may also show a tray icon, but tray availability does not decide whether Circe stays in the background. Use **Quit Circe** from the tray when present, or the operating system's normal application-quit action, to exit fully.

On Linux, launch Full from its AppImage with `chmod +x Circe-<version>-x86_64.AppImage` followed by `./Circe-<version>-x86_64.AppImage`. Full updates are manual: replace the AppImage with the newer release and launch it again.

Spoken presentations use the live session when one is active. With no session live but a key saved, a short muted announcement session speaks the finished report and closes. Otherwise the browser speech lane speaks through one shared queue, so a stale utterance is dropped instead of playing late. Circe Host presents the provider's authoritative finalized result in a bounded form. Only finalized provider results, live approval/input requests, failures, and the post-validation dispatch acceptance for voice turns that start provider work produce speech. Structured status, checks, blockers, or change metadata supplied by T3 may be included; Circe does not infer them by scanning provider prose. Checkpoint capture remains optional workspace bookkeeping, and a capture failure never replaces or delays the task result. Circe never treats an interim message or earlier turn as the current result. Fenced code is omitted from speech, while the written thread keeps the complete provider output.

Voice-originated requests are interpreted once before a task starts. One semantic pass reads the wording and marks which phrases name destinations, tasks, exclusions, or corrections; the request is then grounded against the real project catalog and only a validated destination routes to its owning node. A pinned follow-up to an active task keeps its task even when the wording names another project. If the match is uncertain, Circe asks before creating a task, and a phonetic guess always pauses for confirmation first. A bare project mention inside the work (“compare with X”, “mentioning Y”) stays a mention and never authorizes a route, and a ruled-out project (“but not in X”) is never selected. No recognition or routing instructions are added to the visible prompt. Spoken checks and reviews use the normal runtime mode, so read-only searches do not stop for approval unless you explicitly chose **Supervised**.

If a supervised agent requests approval, the task shows a decision card with the project, a plain-language risk summary, the exact command, and **Deny**, **Allow for this task**, and **Allow once** actions. Circe also retains that exact task as the voice target, so “approve” or “deny” routes back to the pending request. A question or ambiguous reply keeps it pending.

### Faster semantic supervisor with fx

Circe resolves each voice or typed request before any work starts. For bounded commands that resolution is deterministic and instant. For everything else it normally asks the configured semantic supervisor provider, and starting a full coding harness for one small JSON decision can take seconds.

Circe picks the semantic supervisor from the provider you are using: your Codex/Grok agent gets a GPT/Grok supervisor, an OpenCode agent gets a cheap OpenCode model, and so on. For Codex and Grok, Circe routes that supervisor call through `fx` so it does not pay the full coding-harness startup. Install `fx` from its upstream release and sign in once with the same subscription. This repo pins no fx version and checks no checksum, so read the upstream install steps before running them:

```
fx login codex
```

Circe finds `fx` at `~/.fx/bin/fx` (or `CIRCE_FX_BINARY`) and serves the Codex/Grok supervisor through `fx ask` while keeping your task provider exactly as configured. OpenCode and Claude supervisors never involve fx. Without the binary or the login, Circe silently falls back to the provider supervisor.

### Conversations

Ask a general question — what's the weather today, what changed in a release, a follow-up on something just discussed — and Circe runs it as a conversation in the current project. Conversations are ordinary T3 threads: the provider answers with its tools, the exchange stays in the sidebar marked with a chat icon and a `Conversation:` title, and completed answers are spoken through the same report lane as task results. With no project in scope, Circe answers directly without creating a thread.

### Live conversation

Live conversation is the voice path: one full-duplex GPT-Live session. Add an OpenAI API key under the node's **Live conversation** settings in the Circe control center, then press **Live conversation** in the command row or tap `Ctrl+Shift+J` (`Command+Shift+J` on macOS). The microphone stays open while Circe listens and speaks at the same time, so you can interrupt, correct yourself, and keep talking while work runs. Press **End conversation**, or tap the same shortcut again, to close the session and release the microphone. The tray shows **Start** or **End live conversation** with the live status.

The live model handles the spoken conversation only. Requests to start, steer, stop, check, or review work are delegated to the same Director and grounding pipeline as typed turns: names are resolved against real projects and tasks, ambiguous ones trigger a spoken clarification, and the model never invents a target or reports work that did not happen. Task completions, failures, and approval or input requests are spoken as the backend reports them, not from an interim state.

The API key stays on the node and is never sent to a controller, browser, or phone; those clients only ask the node to start a session. Sessions bill by the second on the node's OpenAI account, and the node opens one while live conversation is on, plus a short muted announcement session for a finished report when a key is saved but no session is live. A node without a key reports that plainly.

A single session ends on its own after 60 seconds without user speech and after 10 minutes at most, with whatever was already delegated left running on the node. Ending the conversation, or letting it end, mutes and releases the microphone immediately.

Ordinary requests like **"check pull requests in Rivvl"** are understood directly from the real project catalog, without depending on a model provider. Outside that direct path Circe supervises on the provider family in use: explicit choice first, then the node's default agent, then the stored fallback, with one ready-provider fallback when the first try fails. Change **Default agent for new tasks** to change it.

## Use several devices and nodes

Pair each web or desktop client with the same environment using [remote access](./remote-access.md). The multi-node MVP also lets one web or desktop client pair more than one T3 environment. Each paired environment is a **node**: it has its own projects, providers, threads, workspace, and credentials. There is no central Circe workspace that merges repositories or provider accounts.

In **Settings → Connections**, choose **Add environment** and use the complete pairing link for each T3 environment. The link identifies the environment and creates a durable local connection entry. Pairing the same environment again updates that entry instead of creating a second node. A node can be disconnected and removed from the client directory; removal clears the local connection and cache, not the remote workspace or its T3 state. Reconnect the entry when the network is back. Node labels are display-only names, so changing one does not change its stable identity; choose **Rename** on a paired connection to update its label.

Circe groups the live catalog by node. Projects, providers, and task history carry their owning node even when their titles match. If both **Desk** and **Laptop** contain a project called **Rivvl**, Circe presents **Rivvl — Desk** and **Rivvl — Laptop** and asks you to choose; it never silently chooses the first result or the last visible project. A provider is available only when that provider is ready on the selected node. A model configured on Desk does not make the same model available on Laptop, and Circe asks for a different selection instead of falling back.

When a task is started for a project on Laptop, its continuation stays on Laptop and uses that node's thread, provider, workspace, and checkpoints—even if the request was spoken or typed from Desk. If Laptop is offline, Circe reports that the selected node is unavailable and does not send the task to Desk. Pairing a client transfers a session credential for that node only; it never copies provider credentials between machines.

The mesh is explicit-link based. It has no central node discovery or repository synchronization. Mobile joins the same multi-node mesh; see [Circe on mobile](./circe-mobile.md).

Circe Host sends a live presentation only while the exact origin interaction is connected. If a paired web or desktop client disconnects, its completion, question, or approval is not replayed as speech after reconnect; the ordinary T3 thread and task desk still show the durable result or pending state. The written task always remains the source of truth.

In **Circe Control Center → Voice on this device**, use **Speak agent updates** to turn speaking and the live presentation subscription on or off for this client. Off means the client stays idle: no presentation subscription, no synthesis.

Only the exact origin interaction receives the live presentation. There is no speaker election, lease, acknowledgement, retry, or replay when several devices are connected. An accepted push ticket means Expo accepted the notification, not that it was delivered.

Product naming keeps installed identities intact. Display copy, palette, and corner treatment say Circe. Bundle IDs, schemes, CLI name, asset paths, data directories, release endpoints, and code identifiers stay as shipped. See [Circe identity](../internals/circe-identity.md).

## Performance behavior

Circe Host itself adds no resident AI model. The microphone is open only while a live conversation runs. The live presentation stream is event-driven. The control center
uses one bounded mesh refresh for all devices. Disabling voice reports also removes that
client's live presentation subscription; durable results remain in T3 and are shown by the ordinary
thread UI after reconnect.

### Speech responsiveness

Live speech stays interruptible: speaking over the model yields the floor, and ending the session releases the microphone immediately.

### Retrying or discarding an unsent answer

If a browser or desktop Circe submission fails, use **Retry** to resend the same request. Its task and approval identity stay fixed even if another approval has since appeared. **Cancel** discards queued or failed submissions and sends an exact-identity pre-accept cancel for the in-flight request; it does not stop provider work after acceptance. A request already being submitted remains visible until its result arrives, with no filler speech while it waits. On mobile, repeat an answer after a transport failure to answer the same pending request, or say "cancel" to discard it locally.
