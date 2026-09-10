# ARIS

ARIS lets you direct coding agents with text or voice and hear their real results on a connected device or paired node. T3 remains the manager: Codex, Claude, Cursor, Grok, OpenCode, and configured provider instances remain workers that T3 starts and links.

## Open ARIS

- Choose the ARIS mark in the workspace sidebar to open **ARIS Control Center**.
- Open the command palette and choose **Open ARIS** to reach the same control center.
- In the desktop app, `Ctrl+Shift+J` on Windows or Linux is the global voice shortcut. It starts the compact voice surface without opening the control center or the retired command dialog.

The control center shows every paired node in one environment view. Select a device to inspect its
role, reachability, capabilities, projects, and provider readiness. Device connection management,
provider configuration, setup, and this device's microphone/output test and report-speaking
preferences are available from that page. Each project and provider stays attached to the device
that owns it; the control center does not merge credentials or workspaces between nodes.

The desktop's own node is listed first as **This device**, alongside connected and offline remote
nodes. Connection changes update the mesh automatically; **Refresh** reloads project and provider
details.

### Choose the agent for voice tasks

Select an execution device in **ARIS Control Center**, then use **Default agent for new tasks**
to choose its provider, model, and available model options. Save the selection. If the provider is
not ready, use **Providers → Configure** on that device to install or sign in first.

This preference is saved on the selected device and applies to new ARIS tasks executed there,
including requests sent from another device. An explicit spoken choice overrides the default.
Existing tasks and their follow-ups keep their original agent. Choose **Use project defaults** and
then **Save** to clear the ARIS-specific choice.

## One ARIS product per node

The Windows unified installer presents one ARIS application, launcher, and uninstall entry. The
Linux Full AppImage likewise provides the workspace, local execution, and native voice through one
ARIS application. The selected node role changes its capabilities, not its product identity:

- **Full** owns the desktop workspace, managed voice, and local execution.
- **Controller** is a lightweight controller/voice surface and opens a paired Host workspace when
  detailed UI is needed; it has no local desktop workspace or runtime.
- **Headless** is the background execution runtime only.

## Command composer in Control Center

The control center has a **ARIS command** section above the device list. Text is
always usable there. Pick an explicit project target such as **Rivvl — Laptop**,
optionally pick one of its recent tasks, type the instruction, and choose **Send**.
The current target line stays visible, for example
**Rivvl — Laptop · Review task** or **No explicit target**. Choose **No explicit
target** to reset it. A disconnected selection stays put and reads
**(unavailable)**; it never moves to another node on its own.

One feedback lane shows every submission. Text entries stay visible and never
auto-speak; voice entries speak the same text aloud. Submissions move through
visible stages with no filler speech while ARIS waits: a silent receipt first
(`Heard: "..."` text, truncated past 140 characters, never spoken), then
`Heard "...", checking...` at dispatch, still silent. The target line reads
`(provisional, not yet accepted)` until the Host answers. There is no speech
while the semantic supervisor runs. The supervisor may propose one short
present-progress sentence (at most 120 characters). ARIS speaks it only after
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

ARIS Host keeps a bounded list of recent task identities for each connected device. To switch by name, use explicit task language such as “Switch to the Rivvl review task.” If more than one recent task matches, ARIS asks you to choose instead of guessing. Starting another conversation creates the task immediately once the request includes an objective.

ARIS targets the current project and thread. When T3 has just spoken a report, it remembers the exact thread that produced it and shows that thread as the target for your reply. The visible highlight and any spoken progress sentence are feedback only. The typed target plus Host validation decide where the command runs.

A background desktop voice instruction without an explicit project stays local: the Full node's focused task wins, with a lone local project as fallback. Remote nodes stay opt-in through an explicit project phrase.

Project switching is grounded in the projects connected to T3. ARIS matches project titles, workspace directory names, repository names, and saved aliases. An explicit destination such as “In Rivvl, …” or “… in Rivvl” routes to the owning node on text and voice alike through the same shared spans the clients use for node routing. A destination wrapper preceded by another project name does not route: ARIS asks with the competing projects instead, for example when the wording names Jarvis first and Rivvl in a wrapper. Close pronunciations such as “Ripple” for “Rivvl” produce a confirmation before ARIS changes the target; saying yes resumes the original request instead of starting a new one. That confirmed pronunciation is saved on ARIS Host, so every paired device can recognize it directly next time. A name heard on more than one node asks you to choose instead of guessing, and a name on a disconnected node is reported unavailable instead of falling back. Recognition is not always correct: uncertain matches ask before anything runs.

ARIS resolves the project and control action before starting a coding agent. What dispatches is always the deterministic resolution of the original transcript: the original wording minus the justified destination wrapper, or the original unchanged when no destination span is justified. The model proposal only proves wording was offered; its instruction text never dispatches, and there is no fidelity reject. Requests that join two actions into one turn, and destructive requests the transcript negates, are refused as unsupported instead of partially running. The original transcript is kept separately for diagnostics and is never added to the visible prompt.

Known semantic boundaries: a correction that denies a project without settling on one, such as “No I meant VPS deployment not Rivvl, verify health”, asks which project should receive the task instead of defaulting. Joining two independent commands in one turn (“Fix auth then add release notes”) is unsupported: ARIS answers with needs-input and nothing dispatches. An open-ended or ambiguous request makes no claim: ARIS asks for the missing detail instead of guessing.

## Route work

Name the provider, model, effort, and objective naturally:

```text
Use Codex Sol at high effort to implement device presence.
```

T3 resolves those names against the providers and models available in the selected environment. It asks for clarification instead of silently substituting another provider, model, or effort. If you replace a provider or change its account, select the new provider in **Default agent for new tasks** and save it; an unavailable selection is reported clearly instead of being replaced with a different agent.

ARIS uses a separate semantic supervisor—Codex Luna at low reasoning by default—to understand natural phrasing. That supervisor only proposes an action and visible catalog names. It runs without project access or tools. ARIS Host still validates the real project, task, provider, model, effort, and any pending approval, then reloads the selected task immediately before dispatching through the ordinary T3 provider adapter. The supervisor never chooses internal IDs or authorizes tools, and changing it does not change the coding agent selected for your task.

To review one provider's output with another, open the source thread and ask:

```text
Use Fable to review this Codex output.
```

T3 creates a linked review thread, copies the latest final assistant output into an explicitly delimited review prompt, and records the relationship on both threads.

## Talk and listen

In Windows and Linux Full, hold `Ctrl+Shift+J` to open the compact ARIS voice dock above the bottom center and
start local capture. The native `node-cpal` microphone path is Windows and Linux
only. macOS Desktop captures through its renderer PCM path (`getUserMedia` into
the voice worker, macOS-only) with the same packaged Parakeet/Pocket resources;
it does not stage `node-cpal`, `uiohook`, or the retired Rust microphone package.
macOS implements no native OS speech framework. Capture is the custom renderer path, synthesis is the packaged Pocket path.
Release the shortcut to transcribe the complete utterance and route it to the
current Full node's focused task or only local project. Name a project explicitly—for example,
**“In Rivvl, review the failing tests”**—to override that default and route through the same ARIS
mesh to a paired remote node. Each finalized capture is submitted as its own request in speaking
order, so a second utterance waits for the first without being joined to it; a repeated final event
for the same capture is ignored. You can keep speaking while an earlier request is being routed, and
typed edits remain in the instruction draft. ARIS shows a starting state immediately and plays
a short confirmation tone as semantic conversion starts. The receipt cue is local only and never waits for recognition or synthesis. Desktop plays its bundled `listening.wav` file. A browser plays one short oscillator blip. Mobile fires one light haptic tick. A missing player never blocks the release. The receipt text is silent: nothing
is spoken while the supervisor runs, and there is no waiting filler. The supervisor may propose
one brief progress sentence, but ARIS keeps it beside the command and speaks it only after
validation and dispatch acceptance for a command that starts
provider work, such as **“Taking a look at the auth.”**
That sentence is feedback only: it cannot select a task, authorize a tool, change the instruction, or
claim the work succeeded. ARIS asks aloud when a target or
other detail is ambiguous and speaks a bounded live completion presentation when the provider finishes. If
local voice reports an error, you can use
**Retry** or hold the shortcut for the next capture attempt; submitted tasks remain in T3.
On Linux desktops that speak the global-shortcuts portal, that hold/release path
is the normal one. Approve ARIS's shortcut if the desktop asks on first use. The dock says
**Release to send** for hold-to-talk; tap-to-start/tap-to-send is a fallback, not a required second
press in hold mode. If the desktop cannot provide a physical key-release signal, the tray identifies
the shortcut as tap-to-start/tap-to-stop instead of pretending a timed hold is available.
It does not reveal the full command dialog. Parakeet recognition and Pocket synthesis run in
ARIS's bundled Pipecat voice host behind the existing Desktop voice boundary. Pipecat sends the
synthesized audio to the current system output device. There is no system Python requirement or
pairing step on a Full node.
ARIS supplies Parakeet with the current project, repository, provider, and model names before
each utterance is decoded, which helps uncommon names win over similar everyday phrases.
If an uncommon project name still sounds like ordinary words, ARIS asks before routing the task.
After you confirm it, ARIS remembers that pronunciation and corrects later requests.

Local Pocket replies begin playing as soon as Pipecat produces the first audio chunk; later chunks are
synthesized while earlier ones play. Desktop gives Pipecat one finalized response at a time, and
the voice host uses its sentence-mode TTS path without the optional streaming tokenizer package.
All chunks in one reply share one Pipecat-managed output stream, so sentence boundaries do not
restart the system player or add artificial silence. On Linux, PipeWire follows the system's
current default output for each reply, including speakers, newly connected earbuds, USB, and HDMI.
Speech uses a conversational pace and keeps natural pauses between clauses. A single local speech queue prevents acknowledgements and
presentations from overlapping. Local presentations remain in arrival order. When a task's later state replaces an earlier working update,
ARIS cancels only that update; starting another capture stops all current speech immediately.
Pipecat keeps whichever voice model handled the latest operation until capture, speech, or shutdown
claims the lease. Stopping speech or starting microphone capture still interrupts the reply
immediately. Parakeet and Pocket do not stay loaded together except on Linux with memory to spare,
where Pipecat may keep both resident between turns: Pipecat releases one before loading
the other.

Closing the Full or Controller workspace window keeps ARIS resident so its hotkey, live presentation relay,
and voice worker can remain available. A supported desktop may also show a tray icon, but tray
availability does not decide whether ARIS stays in the background. Use **Quit ARIS** from the
tray when present, or the operating system's normal application-quit action, to exit fully.

On Linux, launch Full from its AppImage with `chmod +x Jarvis-<version>-x86_64.AppImage` followed
by `./Jarvis-<version>-x86_64.AppImage`. Full updates are manual: replace the AppImage with the
newer release and launch it again.

In a regular browser, the same command section is text-first. The microphone
button is an optional hold control that uses the browser SpeechRecognition
capability (`SpeechRecognition` or `webkitSpeechRecognition`) only while you
press it. Held recognition buffers finals until release and emits once; cancel
drops the buffer. In the Electron composer the same section keeps its separate
native hold adapter alongside the browser one. Text always works, with or without that capability. When the browser
has no recognition support, the control states the limitation explicitly instead
of pretending to listen. Browser and operating-system support varies, and
recognition may use an online speech service. That browser surface does not keep
a microphone or local model running in the background. It is never used as a
silent fallback for failed native capture: ControlCenter mounts it only on
explicit user action.

On Full and Controller Desktop, spoken presentations use the bundled Pipecat/Pocket path described
above. Browser-only clients use the speech synthesis available on that device through one shared browser speech lane, so a stale queued utterance is dropped instead of playing late. ARIS Host presents
the provider's authoritative finalized result in a bounded form. Only finalized provider results, live approval/input requests, and failures produce speech. Structured status, checks, blockers,
or change metadata supplied by T3 may be included; ARIS does not infer them by scanning provider
prose. Checkpoint capture remains optional workspace bookkeeping, and a capture failure never
replaces or delays the task result. ARIS never treats an interim message or earlier turn as the
current result. Fenced code is omitted from speech, while the written thread keeps the complete
provider output.

Voice-originated requests are interpreted once before a task starts. One semantic pass reads the wording and marks which phrases name destinations, tasks, exclusions, or corrections; the request is then grounded against the real project catalog and only a validated destination routes to its owning node. A pinned follow-up to an active task keeps its task even when the wording names another project. If the match is uncertain, ARIS asks before creating a task, and a phonetic guess always pauses for confirmation first. A bare project mention inside the work (“compare with X”, “mentioning Y”) stays a mention and never authorizes a route, and a ruled-out project (“but not in X”) is never selected. No recognition or routing instructions are added to the visible prompt. Spoken checks and reviews use the normal runtime mode, so read-only searches do not stop for approval unless you explicitly chose **Supervised**.

If a supervised agent requests approval, the task shows a decision card with the project, a plain-language risk summary, the exact command, and **Deny**, **Allow for this task**, and **Allow once** actions. ARIS also retains that exact task as the voice target, so “approve” or “deny” routes back to the pending request. A question or ambiguous reply keeps it pending.

## Use several devices and nodes

Pair each web or desktop client with the same environment using [remote access](./remote-access.md). The multi-node MVP also lets one web or desktop client pair more than one T3 environment. Each paired environment is a **node**: it has its own projects, providers, threads, workspace, and credentials. There is no central ARIS workspace that merges repositories or provider accounts.

In **Settings → Connections**, choose **Add environment** and use the complete pairing link for each T3 environment. The link identifies the environment and creates a durable local connection entry. Pairing the same environment again updates that entry instead of creating a second node. A node can be disconnected and removed from the client directory; removal clears the local connection and cache, not the remote workspace or its T3 state. Reconnect the entry when the network is back. Node labels are display-only names, so changing one does not change its stable identity; choose **Rename** on a paired connection to update its label.

ARIS groups the live catalog by node. Projects, providers, and task history carry their owning node even when their titles match. If both **Desk** and **Laptop** contain a project called **Rivvl**, ARIS presents **Rivvl — Desk** and **Rivvl — Laptop** and asks you to choose; it never silently chooses the first result or the last visible project. A provider is available only when that provider is ready on the selected node. A model configured on Desk does not make the same model available on Laptop, and ARIS asks for a different selection instead of falling back.

When a task is started for a project on Laptop, its continuation stays on Laptop and uses that node's thread, provider, workspace, and checkpoints—even if the request was spoken or typed from Desk. If Laptop is offline, ARIS reports that the selected node is unavailable and does not send the task to Desk. Pairing a client transfers a session credential for that node only; it never copies provider credentials between machines.

The mesh is explicit-link based. It has no central node discovery or repository synchronization. Mobile joins the same multi-node mesh with real text and voice control; see [ARIS on mobile](./jarvis-mobile.md).

ARIS Host sends a live presentation only while the exact origin interaction is connected. If a paired web or desktop client disconnects, its completion, question, or approval is not replayed as speech after reconnect; the ordinary T3 thread and task desk still show the durable result or pending state. The written task always remains the source of truth.

In **ARIS Control Center → Voice on this device**, use:

- **Test microphone** and **Stop and transcribe** to verify this machine's local capture.
- **Test output** to initialize the local engine and verify the selected system audio output.
- **Speak agent updates** to turn speaking and the live presentation subscription on or off for this client. Off means the client stays idle: no capture receipt beyond the local cue, no presentation subscription, no synthesis.

Only the exact origin interaction receives the live presentation. There is no speaker election, lease, acknowledgement, retry, or replay when several devices are connected. An accepted push ticket means Expo accepted the notification, not that it was delivered.

Product naming keeps installed identities intact. Display copy, palette, and corner treatment say ARIS. Bundle IDs, schemes, CLI name, asset paths, data directories, release endpoints, and code identifiers stay as shipped. See [ARIS identity](../internals/aris-identity.md).

## Performance behavior

ARIS Host itself adds no resident AI model. Voice-enabled Full and Controller presets run one
isolated Pipecat process with a single-model lease by default. Parakeet is loaded for listening and Pocket for
speech; the last-used model remains available until the opposite operation or shutdown. Microphone
capture exists only while listening. The live presentation stream is event-driven
and the hidden voice orchestration surface is loaded only for a voice session. The control center
uses one bounded mesh refresh for all devices. Disabling voice reports also removes that
client's live presentation subscription; durable results remain in T3 and are shown by the ordinary
thread UI after reconnect.

### Speech responsiveness

Desktop speech starts playing Pocket audio while synthesis continues. On Linux
desktops with at least 12 GiB total memory and 2 GiB available, ARIS can keep recognition and
speech models ready between turns within a 1 GiB combined budget;
it returns to one model when memory pressure requires it. Other platforms keep the single-model
lease. Mobile starts with a short spoken
segment and prepares the next while playback continues. Speech remains interruptible.

### Retrying or discarding an unsent answer

If a browser or desktop ARIS submission fails, use **Retry** to resend the same request. Its task and approval identity stay fixed even if another approval has since appeared. **Cancel** discards queued or failed submissions and sends an exact-identity pre-accept cancel for the in-flight request; it does not stop provider work after acceptance. A request already being submitted remains visible until its result arrives, with no filler speech while it waits. On mobile, repeat an answer after a transport failure to answer the same pending request, or say “cancel” to discard it locally.
