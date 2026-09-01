# Jarvis on mobile

The Jarvis mobile app is a Controller. It can browse paired nodes and projects, open the Task Desk, send Jarvis commands, and use foreground push-to-talk. It does not host projects, run coding providers, or load speech models.

Pair the phone with each Jarvis environment through the existing T3 connection flow. Tailnet connections use the same authenticated RPC channel as the rest of the mobile app; Jarvis does not expose a separate audio endpoint.

Open **Jarvis** from Home or Settings, then:

1. Refresh the node catalog and select a project.
2. On an online node marked for voice, choose **Use for voice**. This choice is saved on the phone.
3. Send a text command or hold **Hold to talk** for up to 15 seconds.
4. Open a task from the Task Desk to answer its approvals or questions with the ordinary thread controls.

The selected voice node performs transcription and speech. The project may execute on a different node. If the preferred voice node disconnects, mobile reports that state and offers online voice-capable nodes, but never changes the choice automatically.

Mobile voice is foreground push-to-talk only. Wake words, background listening, historical speech replay, and local phone speech models are not supported.
