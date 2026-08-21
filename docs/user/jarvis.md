# Jarvis command relay

Jarvis lets you direct coding agents through T3 Code with text or voice and hear their real results on one connected device. T3 remains the manager: Codex, Claude, Cursor, Grok, OpenCode, and configured provider instances remain workers that T3 starts and links.

## Open Jarvis

- Press `Ctrl+Shift+J` on Windows or Linux, or `Command+Shift+J` on macOS.
- In the desktop app, that shortcut is global: it reveals T3 Code even while another application is focused. If another application has already claimed it, the shortcut still works while T3 is focused.
- Open the command palette and choose **Open Jarvis command relay**.

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

The microphone button uses the browser's speech-recognition capability only while you press it. Browser and operating-system support varies, and recognition may use an online speech service. Jarvis does not keep a microphone, Whisper process, or local model running in the background.

Spoken reports use the device's built-in speech synthesis. Jarvis Host waits for the turn's terminal checkpoint, correlates its exact final assistant message, then projects a short briefing from the original goal, provider result, checkpoint change counts, stated findings and verification, limitations, and useful next actions. It never treats an interim message or earlier turn as the current result. Code blocks, commands, and file paths are not read aloud; the written thread keeps the complete provider output.

If the agent asks a question or requests approval, open Jarvis and answer normally. T3 routes the answer back to that pending interaction. Only a clear answer such as “approve” or “deny” decides an approval; a question or ambiguous reply keeps it pending.

## Use several devices

Pair each web or desktop client with the same environment using [remote access](./remote-access.md). A phone can use the paired web client, including the browser or keyboard's voice input where supported.

Jarvis Host keeps a bounded report inbox for each paired session after that client first subscribes. If a paired web, desktop, or Companion client disconnects, its unacknowledged reports are replayed when it reconnects—even after either side restarts—while another paired device keeps its own delivery position. A question or approval that was already resolved is removed from replay instead of resurfacing stale attention.

Every connected, voice-enabled client receives pending reports, but a short server-side election allows only one to speak each report. In **Settings → General**, use:

- **Jarvis voice reports** to turn speaking and the report subscription on or off for this client.
- **Preferred Jarvis voice device** to make this client win when several devices are connected.

Without an explicit preference, the desktop app is preferred over a desktop browser, and a desktop browser is preferred over a phone. The election runs only when a report arrives; it does not use polling or heartbeats.

## Windows companion

**Jarvis Companion** is a small Windows tray app for a device that should speak Jarvis reports and start work without hosting agents itself. It does not start a T3 server, provider CLI, or workspace.

On first launch, paste a fresh pairing link created from the Jarvis host's **Settings → Connections → Create link** screen. The standard `app.t3.codes` pairing wrapper and a direct host pairing link both work; Companion exchanges the one-time token only with the selected Jarvis Host and does not retain it. Choose the **Tailscale HTTPS** endpoint when your Windows device is on the same tailnet; use **Tailscale IP** only when you deliberately want the private HTTP endpoint.

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

Companion uses the included local Whisper speech recognizer only while the command surface is listening. The model is stored with the app, but the recorder and model process stop when you release the hold shortcut, after a final transcript, or if you cancel the capture—there is no arbitrary cutoff while you are intentionally holding it. This keeps spoken instructions local to the Windows machine; the laptop remains the only machine running the provider and workspace. Spoken confirmations and reports use the bundled local Piper US-English `hfc_female` voice, not the default Windows voice. Companion speaks the bounded briefing supplied by Jarvis Host rather than independently reinterpreting the raw answer; older Hosts retain the local compatibility fallback. The written T3 task retains the full agent response. The short briefing reveals progressively on the Companion while it is spoken. A response-delivery failure remains attached to the pending question or approval so it can be retried, while terminal failures remain explicit alerts.

Choose **Open Jarvis Host** from the tray menu only when you intentionally want the full T3 workspace. Use **Voice defaults…** to change the provider/model choice for future spoken tasks.

The tray menu also contains **Check for updates**. During a download it shows progress, and after completion it becomes **Restart to install**. Source/development builds deliberately disable the updater so tests and local iteration never contact the release feed.

## Performance behavior

Jarvis adds no resident AI model. Its report inbox is event-driven, Companion starts its local recognizer only for a capture and immediately releases it, and the command dialog is loaded only when opened. The Piper voice and Whisper model are on disk but not resident until used. Disabling voice reports also removes that client's report subscription; reports remain bounded on the Host and resume when that paired session subscribes again.
