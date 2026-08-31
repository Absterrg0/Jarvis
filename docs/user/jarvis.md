# Jarvis

Jarvis lets you direct coding agents through T3 Code with text or voice and hear their real results on a connected device or paired node. T3 remains the manager: Codex, Claude, Cursor, Grok, OpenCode, and configured provider instances remain workers that T3 starts and links.

## Open Jarvis

- Choose the Jarvis mark in the workspace sidebar to open **Jarvis Control Center**.
- Open the command palette and choose **Open Jarvis** to reach the same control center.
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

Select an execution device in **Jarvis Control Center**, then use **Default agent for new tasks**
to choose its provider, model, and available model options. Save the selection. If the provider is
not ready, use **Providers → Configure** on that device to install or sign in first.

This preference is saved on the selected device and applies to new Jarvis tasks executed there,
including requests sent from another device. An explicit spoken choice overrides the default.
Existing tasks and their follow-ups keep their original agent. Choose **Use project defaults** and
then **Save** to clear the Jarvis-specific choice.

## One Jarvis product per node

The Windows unified installer presents one Jarvis application, launcher, and uninstall entry. The
Linux Full AppImage likewise provides the workspace, local execution, and native voice through one
Jarvis application. The selected node role changes its capabilities, not its product identity:

- **Full** owns the desktop workspace, managed voice, and local execution.
- **Controller** is a lightweight controller/voice surface and opens a paired Host workspace when
  detailed UI is needed; it has no local desktop workspace or runtime.
- **Headless** is the background execution runtime only.

Jarvis targets the current project and thread. When T3 has just spoken a report, it remembers the exact thread that produced it and shows that thread as the target for your reply.

Jarvis Host keeps a bounded list of recent task identities for each connected device. To switch by name, use explicit task language such as “Switch to the Rivvl review task.” If more than one recent task matches, Jarvis asks you to choose instead of guessing. Starting another conversation creates the task immediately once the request includes an objective.

Project switching is grounded in the projects connected to T3. Jarvis matches project titles, workspace directory names, repository names, and saved aliases. Close pronunciations such as “Ripple” for “Rivvl” produce a confirmation before Jarvis changes the target; saying yes resumes the original request instead of starting a new one. That confirmed pronunciation is saved on Jarvis Host, so every paired device can recognize it directly next time.

Jarvis resolves the project and control action before starting a coding agent. The task shown in T3 and sent to the agent contains the clean, corrected instruction only. The original speech transcript is retained separately for diagnostics, so recognition context never leaks into the visible prompt.

## Route work

Name the provider, model, effort, and objective naturally:

```text
Use Codex Sol at high effort to implement device presence.
```

T3 resolves those names against the providers and models available in the selected environment. It asks for clarification instead of silently substituting another provider, model, or effort. If you replace a provider or change its account, select the new provider in **Default agent for new tasks** and save it; an unavailable selection is reported clearly instead of being replaced with a different agent.

Jarvis uses a separate semantic supervisor—Codex Luna at low reasoning by default—to understand natural phrasing. That supervisor only proposes an action and visible catalog names. It runs without project access or tools. Jarvis Host still validates the real project, task, provider, model, effort, and any pending approval, then reloads the selected task immediately before dispatching through the ordinary T3 provider adapter. The supervisor never chooses internal IDs or authorizes tools, and changing it does not change the coding agent selected for your task.

To review one provider's output with another, open the source thread and ask:

```text
Use Fable to review this Codex output.
```

T3 creates a linked review thread, copies the latest final assistant output into an explicitly delimited review prompt, and records the relationship on both threads.

## Talk and listen

In Linux Full, hold `Ctrl+Shift+J` to open the compact Jarvis voice dock above the bottom center and
start local capture. Release the shortcut to transcribe the complete utterance and route it to the
current Full node's focused task or only local project. Name a project explicitly—for example,
**“In Rivvl, review the failing tests”**—to override that default and route through the same Jarvis
mesh to a paired remote node. Each finalized capture is submitted as its own request in speaking
order, so a second utterance waits for the first without being joined to it; a repeated final event
for the same capture is ignored. You can keep speaking while an earlier request is being routed, and
typed edits remain in the instruction draft. Jarvis shows a starting state immediately and says
a short confirmation tone for a spoken instruction while the Host accepts the task. It asks aloud when a target or
other detail is ambiguous and speaks a bounded live completion presentation when the provider finishes. If
local voice reports an error, you can use
**Retry** or hold the shortcut for the next capture attempt; submitted tasks remain in T3.
On Linux desktops that speak the global-shortcuts portal, that hold/release path
is the normal one. Approve Jarvis's shortcut if the desktop asks on first use. The dock says
**Release to send** for hold-to-talk; tap-to-start/tap-to-send is a fallback, not a required second
press in hold mode. If the desktop cannot provide a physical key-release signal, the tray identifies
the shortcut as tap-to-start/tap-to-stop instead of pretending a timed hold is available.
It does not reveal the full command dialog. Parakeet recognition and Kokoro synthesis run in
Jarvis's bundled Pipecat voice host behind the existing Desktop voice boundary. Pipecat sends the
synthesized audio to the current system output device. There is no system Python requirement or
pairing step on a Full node.
Jarvis supplies Parakeet with the current project, repository, provider, and model names before
each utterance is decoded, which helps uncommon names win over similar everyday phrases.
If an uncommon project name still sounds like ordinary words, Jarvis asks before routing the task.
After you confirm it, Jarvis remembers that pronunciation and corrects later requests.

Local Kokoro replies begin playing as soon as Pipecat produces the first audio chunk; later chunks are
synthesized while earlier ones play. Desktop gives Pipecat one finalized response at a time, and
the voice host uses its sentence-mode TTS path without the optional streaming tokenizer package.
All chunks in one reply share one Pipecat-managed output stream, so sentence boundaries do not
restart the system player or add artificial silence. On Linux, PipeWire follows the system's
current default output for each reply, including speakers, newly connected earbuds, USB, and HDMI.
Speech uses a conversational pace and keeps natural pauses between clauses. A single local speech queue prevents acknowledgements and
presentations from overlapping. Local presentations remain in arrival order. When a task's later state replaces an earlier working update,
Jarvis cancels only that update; starting another capture stops all current speech immediately. Kokoro
stays warm for five minutes after speech becomes idle, then releases its model memory. Stopping
speech or starting microphone capture still interrupts the reply immediately. Parakeet and Kokoro
do not stay loaded together: Pipecat switches the model lease when capture or speech begins.

Closing the Full or Controller workspace window keeps Jarvis resident so its hotkey, live presentation relay,
and voice worker can remain available. A supported desktop may also show a tray icon, but tray
availability does not decide whether Jarvis stays in the background. Use **Quit Jarvis** from the
tray when present, or the operating system's normal application-quit action, to exit fully.

On Linux, launch Full from its AppImage with `chmod +x Jarvis-<version>-x86_64.AppImage` followed
by `./Jarvis-<version>-x86_64.AppImage`. Full updates are manual: replace the AppImage with the
newer release and launch it again.

In a regular browser, the microphone button instead uses the browser's speech-recognition
capability only while you press it. Browser and operating-system support varies, and recognition
may use an online speech service. That browser surface does not keep a microphone or local model
running in the background.

On Full and Controller Desktop, spoken presentations use the bundled Pipecat/Kokoro path described
above. Browser-only clients use the speech synthesis available on that device. Jarvis Host presents
the provider's authoritative finalized result in a bounded form. Structured status, checks, blockers,
or change metadata supplied by T3 may be included; Jarvis does not infer them by scanning provider
prose. Checkpoint capture remains optional workspace bookkeeping, and a capture failure never
replaces or delays the task result. Jarvis never treats an interim message or earlier turn as the
current result. Fenced code is omitted from speech, while the written thread keeps the complete
provider output.

Voice-originated requests are grounded before a task starts. Jarvis matches a spoken project against the live project catalog, repairs a strong spelling match to the project's canonical name, switches the task target, and only then submits the clean request. An explicit project name wins over whichever task happens to be open. If the match is uncertain, Jarvis asks before creating a task. No recognition or routing instructions are added to the visible prompt. Spoken checks and reviews use the normal runtime mode, so read-only searches do not stop for approval unless you explicitly chose **Supervised**.

If a supervised agent requests approval, the task shows a decision card with the project, a plain-language risk summary, the exact command, and **Deny**, **Allow for this task**, and **Allow once** actions. Jarvis also retains that exact task as the voice target, so “approve” or “deny” routes back to the pending request. A question or ambiguous reply keeps it pending.

## Use several devices and nodes

Pair each web or desktop client with the same environment using [remote access](./remote-access.md). The multi-node MVP also lets one web or desktop client pair more than one T3 environment. Each paired environment is a **node**: it has its own projects, providers, threads, workspace, and credentials. There is no central Jarvis workspace that merges repositories or provider accounts.

In **Settings → Connections**, choose **Add environment** and use the complete pairing link for each T3 environment. The link identifies the environment and creates a durable local connection entry. Pairing the same environment again updates that entry instead of creating a second node. A node can be disconnected and removed from the client directory; removal clears the local connection and cache, not the remote workspace or its T3 state. Reconnect the entry when the network is back. Node labels are display-only names, so changing one does not change its stable identity; choose **Rename** on a paired connection to update its label.

Jarvis groups the live catalog by node. Projects, providers, and task history carry their owning node even when their titles match. If both **Desk** and **Laptop** contain a project called **Rivvl**, Jarvis presents **Rivvl — Desk** and **Rivvl — Laptop** and asks you to choose; it never silently chooses the first result or the last visible project. A provider is available only when that provider is ready on the selected node. A model configured on Desk does not make the same model available on Laptop, and Jarvis asks for a different selection instead of falling back.

When a task is started for a project on Laptop, its continuation stays on Laptop and uses that node's thread, provider, workspace, and checkpoints—even if the request was spoken or typed from Desk. If Laptop is offline, Jarvis reports that the selected node is unavailable and does not send the task to Desk. Pairing a client transfers a session credential for that node only; it never copies provider credentials between machines.

The MVP is explicit-link based. It has no mobile multi-node control surface, central node discovery, or repository synchronization. Mobile can continue to use its existing single-environment connection paths; it is not part of this multi-node flow.

Jarvis Host sends a live presentation only while the exact origin interaction is connected. If a paired web or desktop client disconnects, its completion, question, or approval is not replayed as speech after reconnect; the ordinary T3 thread and task desk still show the durable result or pending state. The written task always remains the source of truth.

In **Jarvis Control Center → Voice on this device**, use:

- **Test microphone** and **Stop and transcribe** to verify this machine's local capture.
- **Test output** to initialize the local engine and verify the selected system audio output.
- **Speak agent updates** to turn speaking and the live presentation subscription on or off for this client.

Only the exact origin interaction receives the live presentation. There is no speaker election, lease, acknowledgement, retry, or replay when several devices are connected.

## Performance behavior

Jarvis Host itself adds no resident AI model. Voice-enabled Full and Controller surfaces keep only
the compact Parakeet recognizer resident to make push-to-talk responsive. Microphone capture exists
only while listening, and the heavier Kokoro voice runs in an isolated process with adaptive
retention before offloading after up to 120 seconds of inactivity. The live presentation stream is event-driven
and the hidden voice orchestration surface is loaded only for a voice session. The control center
uses one bounded mesh refresh for all devices. Disabling voice reports also removes that
client's live presentation subscription; durable results remain in T3 and are shown by the ordinary
thread UI after reconnect.
