# Mobile voice ownership

Mobile voice is a node-qualified extension of `JarvisMesh`, not a separate Jarvis implementation.

The phone owns microphone capture, playback, explicit voice-node selection, and the origin interaction for the turn. It buffers signed 16-bit PCM for one utterance and calls the selected environment through the authenticated T3 WebSocket connection.

The server accepts bounded `jarvis.voiceTranscribe` and `jarvis.voiceSynthesize` operations only with orchestration-operate authorization. A Desktop-launched server advertises `voiceCompute` only when Desktop has provisioned an authenticated loopback voice broker. That broker reaches Desktop's existing voice worker, so local speech and remote mobile speech share one Pipecat process and the same Parakeet and Kokoro model lifecycle. Plain server and Headless installations do not start a voice process.

The transcript enters the ordinary server-side Jarvis command path. Its qualified `ProjectRef` determines the execution node; the preferred voice node does not gain execution authority. Durable T3 events remain the source of task state. A bounded live presentation carrying the exact origin interaction triggers Kokoro on the explicitly selected voice node and playback on the initiating phone.

There is no fallback election, public audio listener, speech outbox, or replay ledger. Disconnecting the selected voice node produces an unavailable result and requires a new explicit selection.
