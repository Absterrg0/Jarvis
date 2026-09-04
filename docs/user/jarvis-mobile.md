# Jarvis on mobile

The Jarvis mobile app opens directly into Jarvis. It can browse paired nodes and projects, open recent work, send Jarvis commands, and use foreground push-to-talk. It does not host projects, run coding providers, or load speech models.

Pair the phone with each Jarvis environment through the existing T3 connection flow. Tailnet connections use the same authenticated RPC channel as the rest of the mobile app; Jarvis does not expose a separate audio endpoint.

After pairing, open the app and:

1. Hold the microphone for up to 15 seconds, then release to send, or type a command.
2. Open a task under **Recent work** to answer its approvals or questions with the ordinary thread controls.
3. Name a project in your command when you want work somewhere specific; otherwise Jarvis routes to the focused or recent project automatically. Opening **Focus** on a task makes its project the ambient context for follow-ups like "continue fixing it".

The app remembers the last valid project. On a fresh install it follows the focused or most recent
Jarvis task, or selects the project automatically when only one is available. A sole online
voice-capable node is selected automatically. Multiple ambiguous choices still require confirmation
so Jarvis cannot send work or audio to the wrong machine.

The selected voice node performs transcription and speech. The project may execute on a different node. If the preferred voice node disconnects, mobile reports that state and offers online voice-capable nodes, but never changes the choice automatically.

Each submitted voice turn keeps the project and voice node selected when recording began. You can browse another Task Desk or select another project after the command is accepted; the earlier task still executes and speaks through its original voice node. Spoken responses play one at a time in short segments.

General questions need no project. "What is new today?" is answered directly on any online node, even on a fresh install with no projects yet, and creates no task. Coding commands still route to a node-qualified project as above.

While Jarvis speaks, holding the microphone or sending a message stops playback first so you can interrupt a long summary. Spoken completions are short summaries (roughly two sentences); approvals and questions always speak in full. The full result text stays on screen either way.

Push notifications name the outcome only ("Task completed", "Input needed"). They never include thread or project titles.

Backgrounding the app or leaving Jarvis while recording discards that capture. Leaving Jarvis also
stops current playback and cancels active transcription or speech generation on the selected voice
node, but an already submitted coding task continues on its execution node. Return to Jarvis or
open the normal thread screen to inspect durable task state; missed speech is not replayed.

Mobile voice is foreground push-to-talk only. Wake words, background listening, historical speech replay, and local phone speech models are not supported.
