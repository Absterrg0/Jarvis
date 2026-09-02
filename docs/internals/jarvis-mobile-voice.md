# Mobile voice ownership

Mobile voice is a node-qualified extension of `JarvisMesh`, not a separate Jarvis implementation.

The phone owns microphone capture, playback, explicit voice-node selection, and the origin interaction for the turn. It buffers signed 16-bit PCM for one utterance and calls the selected environment through the authenticated T3 WebSocket connection.

The server accepts bounded `jarvis.voiceTranscribe` and `jarvis.voiceSynthesize` operations only with orchestration-operate authorization. A Desktop-launched server advertises `voiceCompute` only when Desktop has provisioned an authenticated loopback voice broker. That broker reaches Desktop's existing voice worker, so local speech and remote mobile speech share one Pipecat process and the same Parakeet and Kokoro model lifecycle. Plain server and Headless installations do not start a voice process.

The transcript enters the ordinary server-side Jarvis command path. Its qualified `ProjectRef` determines the execution node; the preferred voice node does not gain execution authority. Durable T3 events remain the source of task state. A bounded live presentation carrying the exact origin interaction triggers Kokoro on the explicitly selected voice node and playback on the initiating phone.

There is no fallback election, public audio listener, speech outbox, or replay ledger. Disconnecting the selected voice node produces an unavailable result and requires a new explicit selection.

## Mobile ownership

Mobile keeps the qualified choices independent even though its primary UI normally resolves them automatically:

- the execution project, including its owning node;
- the node whose Task Desk is being inspected;
- the selected online voice-compute node. A sole candidate may be selected automatically; multiple candidates require an explicit preference.

Each submitted interaction captures an immutable, ephemeral turn with its origin interaction, qualified project, input mode, and voice node. Completion speech uses that captured voice node even if the preference changes while the task runs. The app-level Jarvis provider owns live presentation subscriptions, so navigating into the existing thread screen does not cancel submitted work. It does not persist or replay presentations.

The route-scoped voice hook owns only `idle`, `preparing`, `recording`, `transcribing`, and `speaking`. T3 owns task lifecycle. Backgrounding or leaving the route aborts an active transcription or synthesis RPC, cancels the exact worker operation through the existing broker operation ID, stops capture and playback, and detaches the speech sink. Generation checks still discard a response that raced cancellation. Submitted work and its live presentation subscription continue.

Mobile serializes speech through one FIFO queue. Acknowledgements may speak; live speech is reserved for input, approval, completion, and failure presentations. Presentation text is split into short bounded segments before synthesis. Each segment still returns one complete Base64 WAV and uses a temporary playback file; this is intentionally not a second streaming-media transport. Microphone capture claims the audio owner before the native stream starts so an immediate first buffer is retained.

`DesktopJarvisVoice` is the cross-surface admission owner for local capture, local speech, and remote ASR/TTS. The loopback broker and server do not queue voice work; a concurrent request receives the owner's busy error. The worker keeps an exact remote operation ID for cancellation and protocol defense. Switching between desktop and mobile speech rebuilds the sink-specific Pipecat pipeline but retains the resident Kokoro model.
