# Mobile voice ownership

Mobile voice is a node-qualified extension of `JarvisMesh`, not a separate Jarvis implementation.

The phone owns microphone capture, playback, explicit voice-node selection, and the origin interaction for the turn. It buffers signed 16-bit PCM for one utterance and calls the selected environment through the authenticated T3 WebSocket connection.

The server accepts bounded `jarvis.voiceTranscribe`, `jarvis.voiceSynthesize`, and finite `jarvis.voiceStream` operations only with orchestration-operate authorization. A Desktop-launched server advertises `voiceCompute` only when Desktop has provisioned an authenticated loopback voice broker. That broker reaches Desktop's existing voice worker, so local speech and remote mobile speech share one Pipecat process and the same Parakeet and Pocket model lifecycle. Plain server and Headless installations do not start a voice process.

The transcript enters the ordinary server-side Jarvis command path. Its qualified `ProjectRef` determines the execution node; the preferred voice node does not gain execution authority. Durable T3 events remain the source of task state. A bounded live presentation carrying the exact origin interaction triggers Pocket on the explicitly selected voice node and playback on the initiating phone.

There is no fallback election, public audio listener, speech outbox, or replay ledger. Disconnecting the selected voice node produces an unavailable result and requires a new explicit selection.

## Mobile ownership

Mobile keeps the qualified choices independent even though its primary UI normally resolves them automatically:

- the execution project, including its owning node;
- the node whose Task Desk is being inspected;
- the selected online voice-compute node. A sole candidate may be selected automatically; multiple candidates require an explicit preference.

## Transcription backend and speech output

Transcription backend (`preferredVoiceStt` in `apps/mobile/src/persistence/mobile-preferences.ts`) is explicit and separate from the voice node. `local` runs on-device transcription. `remote` uploads to the selected voice node. Unset defaults to `remote`. Availability never overrides the choice.

`useJarvisVoice` in `apps/mobile/src/features/jarvis/useJarvisVoice.ts` snapshots the backend at capture start as `local` (locale plus live flag) or `remote` (exact voice node id). The snapshot never changes mid-operation. A local failure reports locally and never uploads audio. A disconnected remote node reports the disconnection instead of redirecting to another node or service.

Speech output stays independent. `ttsAvailable` is true only when a voice node is selected. Local transcription with no voice node can fill the draft through `onTranscript`, but it cannot synthesize. See `useJarvisVoice.sttExplicit.test.ts` and `useJarvisVoice.localAsr.test.ts`.

Platform paths differ:

- iOS uses a recorded file. `apps/mobile/src/native/voiceTranscription.ios.ts` records PCM, then calls `@react-native-ai/apple` `transcribe(audio, locale)` with the device locale. It requires a supported device with iOS 26 or later. `getLocalLiveVoiceRecognizer` returns null on iOS. The `JarvisLocalAsr` iOS module is a stub that reports no support.
- Android uses a live session. `apps/mobile/src/native/voiceTranscription.android.ts` drives `JarvisLocalAsr` `startListening` and `stopListening` through `SpeechRecognizer.createOnDeviceSpeechRecognizer` only. The online constructor is never called. `getLocalVoiceTranscriber` returns null on Android, so there is no file path. First use may download the on-device pack. Offline behavior beyond what the framework reports is not claimed.

Neither path is proven on hardware in this tree. The Android native module notes physical-device verification is pending with no Android device in CI. The iOS Apple path notes the same with no device in CI. Static tests mock the native module and prove adapter wiring, error mapping, and gating only. They do not prove microphone permission, pack download, locale support, recognition accuracy, or playback on a phone. Release notes must not claim on-device readiness. The same holds for macOS desktop: capture is the Chromium `getUserMedia` AudioWorklet renderer PCM path into the voice worker, with the same packaged Parakeet and Pocket resources. macOS does not stage `node-cpal`, `uiohook`, or the retired Rust microphone package, and it implements no native OS speech framework.

Prerequisites for local input: microphone permission granted, a supported device locale, and the on-device pack for that locale where the platform requires one. Prerequisites for remote input and for all speech output: one explicitly selected online voice-compute node. A missing node reports `no-voice-node` and stays idle.

Each submitted interaction captures an immutable, ephemeral turn with its origin interaction, qualified project, input mode, and voice node. Completion speech uses that captured voice node even if the preference changes while the task runs. The app-level Jarvis provider owns live presentation subscriptions, so navigating into the existing thread screen does not cancel submitted work. It does not persist or replay presentations.

The route-scoped voice hook owns only `idle`, `preparing`, `recording`, `transcribing`, `synthesizing`, and `speaking`. T3 owns task lifecycle. Backgrounding or leaving the route aborts an active transcription or synthesis RPC, cancels the exact worker operation through the existing broker operation ID, stops capture and playback, and detaches the speech sink. Generation checks still discard a response that raced cancellation. Submitted work and its live presentation subscription continue.

Mobile serializes speech through one FIFO queue. Acknowledgements may speak; live speech is reserved for input, approval, completion, and failure presentations. Reports up to 2,000 characters use one finite RPC stream; longer reports split at word boundaries. Ordered 24 kHz mono signed 16-bit PCM chunks pass from the existing Pipecat output through the worker and authenticated broker to the same WebSocket session. Streaming consumers do not retain a complete WAV or create temporary playback files. The unary synthesis method remains available to existing clients.

The Jarvis native audio module uses Android AudioTrack or iOS AVAudioPlayerNode. Each write awaits native buffer capacity; completion waits for playback to drain. Chunk validation enforces sequence, sample format, a 45 KB chunk limit, and an 8 MB utterance limit. The mobile queue holds at most eight reports, and reconnect never replays a speech stream. Cancellation invalidates the native session before queued writes can reuse it. Microphone capture claims the audio owner before the native stream starts so an immediate first buffer is retained.

Spoken summaries share one normalization policy with web (`@t3tools/jarvis-core/spokenSummary`): code fences and Markdown punctuation are stripped before synthesis, and completions speak a bounded summary while the full text stays in the task UI. Stop speaking or sending a message stops current playback first.

Push notifications default to generic outcome copy. Thread and project titles leave the node for Expo only behind an explicit descriptive-preview opt-in, bounded to one redacted line each. The event subscription resubscribes on capped exponential backoff with jitter; shutdown interruption propagates instead of restarting.

Project-free conversation never pre-empts task context. When a focused task exists, question-shaped follow-ups route through the ordinary execute path so the semantic supervisor can choose continuation; the converse shortcut applies only with a positively current unfocused desk snapshot, never on unknown or stale state. Converse node choice uses each node's own advertised supervisor readiness (`conversationReady`, derived from its configured supervisor instance plus provider snapshot): first ready node wins, unknown-capability catalogs fall back to first-online, explicitly unready nodes are never selected, and with none ready the client reports no conversation provider instead of guessing.

`DesktopJarvisVoice` is the cross-surface admission owner for local capture, local speech, and remote ASR/TTS. The loopback broker and server do not queue voice work; a concurrent request receives the owner's busy error. The worker keeps an exact remote operation ID for cancellation and protocol defense. Switching between desktop and mobile speech rebuilds the sink-specific Pipecat pipeline but retains the resident Pocket model.
