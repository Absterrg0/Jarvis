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

**Jarvis Companion** is a small Windows tray app for a device that should speak Jarvis reports without hosting agents itself. It keeps one authenticated connection to your Jarvis environment and does not start a T3 server, provider CLI, workspace, or local model.

On first launch, paste a fresh pairing link created from the Jarvis host's **Settings → Connections → Create link** screen. Choose the **Tailscale IP** endpoint if that is the reachable endpoint for the Windows device. The companion stores only the host address; the one-time pairing token is used by the remote page and is not retained in its own configuration.

After pairing, Companion has no normal workspace window. It keeps a hidden authenticated relay and a tray icon only. Press `Ctrl+Shift+J` to show a small corner bubble; it starts listening immediately. Say one task, and Companion routes the transcript automatically, says that the selected provider is starting, then hides the bubble again. On Windows, both listening and speech use operating-system speech services; it does not download or keep a local transcription model running. The laptop remains the only machine running the provider and workspace.

Choose **Open dashboard in browser** from the tray menu only when you intentionally want the full T3 workspace. Choose **Speak to Jarvis** when another program has claimed the shortcut.

## Performance behavior

Jarvis adds no resident AI model. Its report stream is event-driven, speech recognition is created only for one capture and immediately released, and the command dialog is loaded only when opened. Disabling voice reports also removes that client's report-stream subscription.
