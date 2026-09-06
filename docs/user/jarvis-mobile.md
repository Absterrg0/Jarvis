# Jarvis on mobile

The Jarvis mobile app opens directly into Jarvis. It can browse paired nodes and projects, open recent work, send Jarvis commands, and use foreground push-to-talk. It does not host projects, run coding providers, or load speech models.

Pair the phone with each Jarvis environment through the existing T3 connection flow. Tailnet connections use the same authenticated RPC channel as the rest of the mobile app; Jarvis does not expose a separate audio endpoint.

After pairing, open the app and:

1. Hold the microphone for up to 15 seconds, then release to send, or type a command. Text always works, with or without voice support.
2. Open a task under **Recent work** to answer its approvals or questions with the ordinary thread controls.
3. Name a project in your command when you want work somewhere specific; otherwise Jarvis routes to the focused or recent project automatically. Opening **Focus** on a task makes its project the ambient context for follow-ups like "continue fixing it". The route screen shows each node as loading, ready, or unavailable with its recovery action, and an unavailable node never receives the turn.
4. Inspect the selected project and voice node before sending. Each turn pins its project, task context, and pending-request identity when recording begins, and retries reuse the same request identity.

The app remembers the last valid project. On a fresh install it follows the focused or most recent
Jarvis task, or selects the project automatically when only one is available. A sole online
voice-capable node is selected automatically. An explicitly named target that is missing stays
unavailable instead of falling back; multiple ambiguous choices still require confirmation
so Jarvis cannot send work or audio to the wrong machine.

The selected voice node performs transcription and speech. The project may execute on a different node. If the preferred voice node disconnects, mobile reports that state and offers online voice-capable nodes, but never changes the choice automatically.

Each submitted voice turn keeps the project and voice node selected when recording began. You can browse another Task Desk or select another project after the command is accepted; the earlier task still executes and speaks through its original voice node. Spoken responses play one at a time in short segments through the mobile speech queue.

Server-owned project and task questions pin their node, origin turn, exact `clarificationFrameId`, and `expectedReply` pin. The next instruction answers that pinned frame on its original node only when the live frame still matches; a missing or replaced frame rejects without acting, and a rejected repeat keeps its frame guard. A stale exact frame may retire locally without claiming a cancel happened, with no automatic unguarded retry. Retained focus is tri-state: unset restores once from the server durable focus on the same node and project, while an explicit project-only selection stays put and is never overridden by a later desk read. Switching project or task first cancels the waiting frame by exact ID; if the cancel cannot be verified, mobile keeps the frame and asks you to answer it instead of letting the next command be consumed unnoticed. Typed provider, model, and effort answers resend the original utterance with its resolved selection under the same request identity.

General questions need no project. "What is new today?" is answered directly on any online node, even on a fresh install with no projects yet, and creates no task. Coding commands still route to a node-qualified project as above.

While Jarvis speaks, holding the microphone or sending a message stops playback first so you can interrupt a long summary. Spoken completions are short summaries (roughly two sentences); approvals and questions always speak in full. The full result text stays on screen either way.

Push notifications name the outcome only ("Task completed", "Input needed"). They never include thread or project titles. An accepted Expo ticket means the push service accepted the notification, not that the phone delivered it. Only a structured `DeviceNotRegistered` response removes that device registration, and a same-token renewal in flight survives a stale failure.

Backgrounding the app or leaving Jarvis while recording discards that capture. Leaving Jarvis also
stops current playback and cancels active transcription or speech generation on the selected voice
node, but an already submitted coding task continues on its execution node. Return to Jarvis or
open the normal thread screen to inspect durable task state; missed speech is not replayed.

Mobile voice is foreground push-to-talk only. Wake words, background listening, historical speech replay, and local phone speech models are not supported.
