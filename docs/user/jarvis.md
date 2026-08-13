# Jarvis command relay

Jarvis lets you direct coding agents through T3 Code with text or voice and hear their real results on one connected device. T3 remains the manager: Codex, Claude, Cursor, Grok, OpenCode, and configured provider instances remain workers that T3 starts and links.

## Open Jarvis

- Press `Ctrl+Shift+J` on Windows or Linux, or `Command+Shift+J` on macOS.
- In the desktop app, that shortcut is global: it reveals T3 Code even while another application is focused. If another application has already claimed it, the shortcut still works while T3 is focused.
- Open the command palette and choose **Open Jarvis command relay**.

Jarvis targets the current project and thread. When T3 has just spoken a report, it remembers the exact thread that produced it and shows that thread as the target for your reply.

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

Spoken reports use the device's built-in speech synthesis. Reports include the agent's actual final output, question, approval request, or runtime failure—not only a generic completion notice. Code blocks are not read aloud; the written thread keeps the complete output.

If the agent asks a question or requests approval, open Jarvis and answer normally. T3 routes the answer back to that pending interaction. A clear negative answer such as “deny” or “cancel” rejects an approval; other replies accept it.

## Use several devices

Pair each web or desktop client with the same environment using [remote access](./remote-access.md). A phone can use the paired web client, including the browser or keyboard's voice input where supported.

Every connected, voice-enabled client receives the report event, but a short server-side election allows only one to speak it. In **Settings → General**, use:

- **Jarvis voice reports** to turn speaking and the report subscription on or off for this client.
- **Preferred Jarvis voice device** to make this client win when several devices are connected.

Without an explicit preference, the desktop app is preferred over a desktop browser, and a desktop browser is preferred over a phone. The election runs only when a report arrives; it does not use polling or heartbeats.

## Windows companion

**Jarvis Companion** is a small Windows tray app for a device that should speak Jarvis reports and start work without hosting agents itself. It does not start a T3 server, provider CLI, or workspace.

On first launch, paste a fresh pairing link created from the Jarvis host's **Settings → Connections → Create link** screen. The standard `app.t3.codes` pairing wrapper and a direct host pairing link both work; Companion exchanges the one-time token only with the selected Jarvis Host and does not retain it. Choose the **Tailscale HTTPS** endpoint when your Windows device is on the same tailnet; use **Tailscale IP** only when you deliberately want the private HTTP endpoint.

After pairing, Companion opens a compact **Voice defaults** panel. Choose a ready provider, model, and any required reasoning level once, then save. Companion sends that exact selection with each spoken task, so you can say the task itself rather than repeating “use Codex Sol high” every time. Jarvis Host validates the saved choice against its current provider setup before it starts work; if it is no longer available, Companion sends you back to defaults instead of guessing.

Choose **Start a new thread** when each spoken request should be independent, or **Continue latest Jarvis thread** to send the next spoken instruction back into the most recently reported Jarvis task with its existing provider conversation and context. The same switch is available from the Companion tray menu, so it can be changed without opening the workspace.

Companion has no normal workspace window. It keeps a hidden authenticated report relay and a tray icon only. Hold `Ctrl+Shift+J` to prepare a local microphone, wait for its soft ready tone, speak, then release to send. The compact water-lens command strip shows its listening state and the exact final transcript before it is routed directly to Jarvis Host. The task-start path does not go through the hidden workspace page. If a device policy prevents Companion's native hold shortcut, its tray menu clearly says that it has fallen back to tap-to-talk.

When Companion speaks a question, approval request, or final report, it retains that report's exact task as the follow-up target. Press `Ctrl+Shift+J` and say your reply—for example, “continue” or “approve”—and Jarvis Host applies it to that task. Starting an explicitly named new provider task still creates new work instead.

Companion uses the included local Whisper speech recognizer only while the command strip is listening. The model is stored with the app, but the recorder and model process stop when you release the hold shortcut, after a final transcript, or if you cancel the capture—there is no arbitrary cutoff while you are intentionally holding it. This keeps spoken instructions local to the Windows machine; the laptop remains the only machine running the provider and workspace. Spoken confirmations and reports use the bundled local Piper US-English `hfc_female` voice, not the default Windows voice. Completion reports begin with a short natural acknowledgement and the actual result; questions, approval requests, and failures are surfaced as an actionable companion prompt rather than a generic completion alert.

Choose **Open Jarvis Host** from the tray menu only when you intentionally want the full T3 workspace. Use **Voice defaults…** to change the provider/model choice for future spoken tasks.

## Performance behavior

Jarvis adds no resident AI model. Its report stream is event-driven, Companion starts its local recognizer only for a capture and immediately releases it, and the command dialog is loaded only when opened. The Piper voice and Whisper model are on disk but not resident until used. Disabling voice reports also removes that client's report-stream subscription.
