# Jarvis

Jarvis lets you direct coding agents through T3 Code with text or voice and hear their real results on a connected device or paired node. T3 remains the manager: Codex, Claude, Cursor, Grok, OpenCode, and configured provider instances remain workers that T3 starts and links.

## Open Jarvis

- Press `Ctrl+Shift+J` on Windows or Linux, or `Command+Shift+J` on macOS.
- In the desktop app, that shortcut is global: it reveals T3 Code even while another application is focused. If another application has already claimed it, the shortcut still works while T3 is focused.
- Open the command palette and choose **Open Jarvis**.

## One Jarvis product per node

The Windows unified installer presents one Jarvis application, launcher, and uninstall entry. The
Linux Full AppImage likewise provides the workspace, local execution, and native voice through one
Jarvis application. The selected node role changes its capabilities, not its product identity:

- **Full** owns the desktop workspace, managed voice, and local execution.
- **Controller** is a lightweight controller/voice surface and opens a paired Host workspace when
  detailed UI is needed; it has no local desktop workspace or runtime.
- **Headless** is the background execution runtime only.

The standalone **Jarvis Companion** installer is for an additional remote voice/control device.
It is not a second Jarvis product installed by the unified setup.

Jarvis targets the current project and thread. When T3 has just spoken a report, it remembers the exact thread that produced it and shows that thread as the target for your reply.

Jarvis Host also keeps a small task history for each connected device. You can say “Go back,” “Go forward,” or “Start another conversation.” To switch by name, use explicit task language such as “Switch to the Rivvl review task.” If more than one recent task matches, Jarvis asks you to choose instead of guessing.

Project switching is grounded in the projects connected to T3. Jarvis matches project titles, workspace directory names, repository names, and saved aliases. Close pronunciations such as “Ripple” for “Rivvl” produce a confirmation before Jarvis changes the target; saying yes resumes the original request instead of starting a new one. That confirmed pronunciation is saved on Jarvis Host, so every paired device can recognize it directly next time.

## Route work

Name the provider, model, effort, and objective naturally:

```text
Use Codex Sol at high effort to implement device presence.
```

T3 resolves those names against the providers and models available in the selected environment. It asks for clarification instead of silently substituting another provider, model, or effort.

To review one provider's output with another, open the source thread and ask:

```text
Use Fable to review this Codex output.
```

T3 creates a linked review thread, copies the latest final assistant output into an explicitly delimited review prompt, and records the relationship on both threads.

## Talk and listen

In Linux Full, `Ctrl+Shift+J` opens the integrated Jarvis command surface and starts local capture;
press it again to release and transcribe the complete utterance. The microphone button uses that
same native path. Parakeet recognition and Kokoro speech run in an isolated worker owned by Jarvis,
so there is no Companion setup or pairing step on a Full node.

In a regular browser, the microphone button instead uses the browser's speech-recognition
capability only while you press it. Browser and operating-system support varies, and recognition
may use an online speech service. That browser surface does not keep a microphone or local model
running in the background; the standalone Windows Companion behavior is described separately
below.

Spoken reports use the device's built-in speech synthesis. Jarvis Host reports a successful provider completion as soon as the authoritative terminal result is finalized, then projects a short briefing from the original goal, provider result, available checkpoint change counts, stated findings and verification, limitations, and useful next actions. Checkpoint capture is optional workspace bookkeeping: its change counts are included when available, while a capture failure remains a diagnostic and never replaces or delays the successful task result. It never treats an interim message or earlier turn as the current result. Code blocks, commands, and file paths are not read aloud; the written thread keeps the complete provider output.

If the agent asks a question or requests approval, open Jarvis and answer normally. T3 routes the answer back to that pending interaction. Only a clear answer such as “approve” or “deny” decides an approval; a question or ambiguous reply keeps it pending.

## Use several devices and nodes

Pair each web or desktop client with the same environment using [remote access](./remote-access.md). The multi-node MVP also lets one web or desktop client pair more than one T3 environment. Each paired environment is a **node**: it has its own projects, providers, threads, workspace, and credentials. There is no central Jarvis workspace that merges repositories or provider accounts.

In **Settings → Connections**, choose **Add environment** and use the complete pairing link for each T3 environment. The link identifies the environment and creates a durable local connection entry. Pairing the same environment again updates that entry instead of creating a second node. A node can be disconnected and removed from the client directory; removal clears the local connection and cache, not the remote workspace or its T3 state. Reconnect the entry when the network is back. Node labels are display-only names, so changing one does not change its stable identity; choose **Rename** on a paired connection to update its label.

Jarvis groups the live catalog by node. Projects, providers, and task history carry their owning node even when their titles match. If both **Desk** and **Laptop** contain a project called **Rivvl**, Jarvis presents **Rivvl — Desk** and **Rivvl — Laptop** and asks you to choose; it never silently chooses the first result or the last visible project. A provider is available only when that provider is ready on the selected node. A model configured on Desk does not make the same model available on Laptop, and Jarvis asks for a different selection instead of falling back.

When a task is started for a project on Laptop, its continuation stays on Laptop and uses that node's thread, provider, workspace, and checkpoints—even if the request was spoken or typed from Desk. If Laptop is offline, Jarvis reports that the selected node is unavailable and does not send the task to Desk. Pairing a client or Companion transfers a session credential for that node only; it never copies provider credentials between machines.

The MVP is explicit-link based. It has no mobile multi-node control surface, central node discovery, or repository synchronization. Mobile can continue to use its existing single-environment connection paths; it is not part of this multi-node flow.

Jarvis Host keeps a bounded report inbox for each paired session after that client first subscribes. If a paired web, desktop, or Companion client disconnects, its unacknowledged reports are replayed when it reconnects—even after either side restarts—while another paired device keeps its own delivery position. A question or approval that was already resolved is removed from replay instead of resurfacing stale attention. A report keeps the interaction identity that created it: the originating interaction receives the short, speakable briefing, while other clients retain the full report in T3 without stealing the speech lease. The written task always remains the source of truth.

Every connected, voice-enabled client receives pending reports, but a short server-side election allows only one to speak each report. In **Settings → General**, use:

- **Jarvis voice reports** to turn speaking and the report subscription on or off for this client.
- **Preferred Jarvis voice device** to make this client win when several devices are connected.

Without an explicit preference, the desktop app is preferred over a desktop browser, and a desktop browser is preferred over a phone. The election runs only when a report arrives; it does not use polling or heartbeats.

## Windows companion

**Jarvis Companion** is a small Windows tray app for a device that should speak Jarvis reports and start work without hosting agents itself. It does not start a T3 server, provider CLI, or workspace.

On first launch, paste a fresh pairing link created from the Jarvis host's **Settings → Connections → Create link** screen. The standard `app.t3.codes` pairing wrapper and a direct host pairing link both work; Companion exchanges the one-time token only with the selected Jarvis Host and does not retain it. Choose the **Tailscale HTTPS** endpoint when your Windows device is on the same tailnet; use **Tailscale IP** only when you deliberately want the private HTTP endpoint.

Companion stores paired host descriptors in its local node directory. Pairing a known host again updates that node's endpoint and label instead of duplicating it; **Disconnect this companion** removes the selected node's local pairing and report connection. A later pairing link reconnects it, while the Host's projects, tasks, repositories, and provider credentials remain on the Host.

Install Companion with the Windows installer rather than keeping it as an extracted ZIP. Installed builds check GitHub Releases shortly after startup and every ten minutes, download new versions in the background, and use Electron blockmaps to avoid transferring unchanged application blocks such as the bundled speech resources. When an update is ready, Windows shows a quiet notification and the tray menu changes to **Restart to install**. Updates also install on a normal application quit. The installer is a one-time migration; subsequent test releases do not require another manual download.

After pairing, Companion opens a compact **Voice defaults** panel for a ready provider, model, any required reasoning level, and conversation behavior. Companion sends those model choices with each spoken task unless you explicitly name another provider in the request, so you can usually say the task itself rather than repeating routing details. Jarvis Host validates those choices before it starts work; if one is no longer available, Companion asks you to update the default instead of guessing.

Projects are conversational rather than another setup field. Say **“In Jarvis, fix the voice overlay”** or **“For the payments API, review the failing tests.”** Companion resolves the spoken name to a T3 project before the provider starts, so the thread, workspace, and checkpoints all belong to the right project; it does not ask the provider to change directory after launch. If only one project exists, it is used automatically. Otherwise Companion remembers the last successful voice project, while an explicit project name always wins. When no choice is safe, it asks which project you meant and accepts the answer through the same hotkey.

The live project and provider catalogs act as a local voice vocabulary. Companion refreshes them during every capture before finalizing the transcript, then applies titles, workspace names, repository names, provider/model names, and previously confirmed pronunciations at its local recognition boundary. Project aliases are repaired only in project-name phrases, so an ordinary phrase such as “ribbon animation” is not rewritten as Rivvl. A new sound-alike such as **“ripple”** or **“ribbon”** for **Rivvl** must be confirmed once; Companion then saves that correction on the Host and recognizes it on every paired device. If saving fails, Companion says so while still allowing the task to proceed. Common product terms such as GitHub are normalized before dispatch. If a match is ambiguous—including the same alias on two projects—Companion keeps the original task pending across restarts and accepts either the name or a positional answer such as **“the second one”**; it never silently falls back to catalog order or the last project.

The tray menu's **Learned project names** submenu shows saved pronunciations and aliases. Choose one there to remove it; Jarvis will require confirmation if it hears that pronunciation again.

Jarvis also understands a small, predictable set of conversational controls for the exact task it last started or reported:

- **“What projects are there?”** reads the live T3 project catalog without starting a provider.
- **“Actually use SQLite instead”** steers the active task.
- **“After that, update the docs”** queues a durable follow-up for the same thread.
- **“What is it doing?”** reports the current task state without starting work.
- **“Stop that task”** interrupts it.
- **“Do that last task in the Fable project”** stops the active run when necessary and starts its original objective in the named project.
- **“Switch to the Fable project”** changes the remembered project for future voice work without starting an agent.

Referential controls are never applied to a guessed task. If the companion has no exact recent target, Jarvis asks you to select one.

Choose **Start a new thread** when each spoken request should be independent, or **Continue latest Jarvis thread** to send the next spoken instruction back into the most recently reported Jarvis task with its existing provider conversation and context. Jarvis Host keeps an exact task focus for each authenticated client session, so that reference survives Companion restarts without becoming whichever task happens to be visible. Different paired devices keep independent focus. The Companion also retains its last exact target as a compatibility hint. The same switch is available from the Companion tray menu, so it can be changed without opening the workspace.

Companion has no normal workspace window. It keeps a hidden authenticated report relay and a tray icon only. Hold `Ctrl+Shift+J` to prepare a local microphone, wait for its soft ready tone, speak, then release to send. If Jarvis is already speaking a report, that same hold stops the voice and starts listening. Choose **Stop speaking** from the tray, or click the overlay hint, to stop the voice without starting a capture. Interrupted speech still counts as delivered, so the report is not replayed. The compact command surface shows its listening state, exact final transcript, and resolved project before routing directly to Jarvis Host. The task-start path does not go through the hidden workspace page. If a device policy prevents Companion's native hold shortcut, its tray menu clearly says that it has fallen back to tap-to-talk.

When Companion speaks a question, approval request, or final report, it retains that report's exact task as the follow-up target. Press `Ctrl+Shift+J` and say your reply—for example, “continue” or “approve”—and Jarvis Host applies it to that task. Starting an explicitly named new provider task still creates new work instead.

Approval speech describes intent and risk in ordinary language rather than reading shell syntax aloud. The exact command remains visible in T3. Known read, test, build, dependency, file-change, and destructive operations receive conservative descriptions; an unfamiliar command is never guessed and must be reviewed on screen.

Wrapped shell commands are inspected as a set of operations rather than described as an opaque shell. For example, a read-only review setup can be spoken as “read the code-review instructions and inspect repository remotes, status, and current branch.” A compound workspace inspection can identify the specific files being read and the directory listing being requested. The visual approval still retains the exact command.

The command surface is temporary: a normal task acknowledgement closes after a few seconds, a completion stays through its spoken briefing and then closes, an error stays long enough to read, and a question or approval prompt stays briefly so you can answer it. Active listening and routing remain visible until they finish.

Companion keeps the included Parakeet TDT/CTC 110M INT8 recognizer resident for quick, fully local transcription. Hold `Ctrl+Shift+J`, speak naturally, and release: the complete 16 kHz utterance is decoded at that explicit boundary, without an arbitrary silence cutoff. If a device policy blocks the hold shortcut, the fallback uses one tap to start and a second tap to send. Spoken confirmations and reports use the bundled quantized Kokoro voice, not the default Windows voice. Starting a valid capture also starts warming Kokoro, overlapping its cold start with the time spent speaking and reviewing the transcript; after review, Companion gives that warm attempt only a short additional grace period before dispatch. It reserves the acknowledgement's speech position before dispatch and commits it only after Host acceptance when Kokoro is currently ready. Rejection releases the reservation, and a voice worker that is still cold or has already offloaded at acceptance skips the now-stale acknowledgement instead of playing it immediately before a fast completion. A slow or broken voice runtime does not prevent the written task from starting. For a multi-device Host report, only the elected speaker warms Kokoro; local prompts warm it only on the Companion handling that voice interaction. Its isolated worker uses adaptive retention: active work keeps it available, and when it is not active it may remain warm for up to 120 seconds before offloading. Companion speaks the bounded briefing supplied by Jarvis Host rather than independently reinterpreting the raw answer; older Hosts retain the local compatibility fallback. The written T3 task retains the full agent response. The short briefing reveals progressively on the Companion while it is spoken. A response-delivery failure remains attached to the pending question or approval so it can be retried, while terminal failures remain explicit alerts.

Choose **Open Jarvis Host** from the tray menu only when you intentionally want the full T3 workspace. Use **Voice defaults…** to change the provider/model choice for future spoken tasks.

The tray menu also shows the installed **Jarvis Companion vX.Y.Z** and contains **Check for updates**. During a download it shows progress, and after completion it becomes **Restart to install**. When the release feed confirms that no newer build exists, it shows **Up to date** until the next check. Source/development builds deliberately disable the updater so tests and local iteration never contact the release feed. The updater action is tied to the label that was rendered: a menu that says **Check for updates** can only start a check, while only **Restart to install** can restart into a downloaded build.

## Performance behavior

Jarvis Host itself adds no resident AI model. Voice-enabled Full and Companion surfaces keep only
the compact Parakeet recognizer resident to make push-to-talk responsive. Microphone capture exists
only while listening, and the heavier Kokoro voice runs in an isolated process with adaptive
retention before offloading after up to 120 seconds of inactivity. The report inbox is event-driven
and the command dialog is loaded only when opened. Disabling voice reports also removes that
client's report subscription; reports remain bounded on the Host and resume when that paired
session subscribes again.
