# Jarvis task desk

The task desk is the deterministic layer for navigating several Jarvis conversations by voice. The delivered foundation persists exact per-session focus, temporary blocking attention, lifecycle state, bounded recent-task history, and navigation as typed events plus a Host projection. In the multi-node MVP, each task entry also carries the execution node that owns its project and provider conversation. It is not a thread list disguised as a voice assistant and it is not an LLM choosing arbitrary IDs.

## Domain state

Each authenticated client session owns a small task desk:

- `focusedThreadId`: the exact thread receiving referential commands.
- `backStack` and `forwardStack`: stable thread IDs used by “go back” and “go forward.”
- `recentTasks`: bounded entity records containing thread ID, node-qualified task reference, project ID, title, objective summary, lifecycle state, and learned voice aliases.
- `pendingFrame`: a durable clarification or confirmation frame with typed candidate IDs.
- `newConversationArmed`: a one-turn instruction to create independent work without destroying the current focus history.

Reports may update a task's lifecycle and raise an attention target, but a background completion does not silently rewrite the user's navigation history. A blocking approval may temporarily take attention while preserving the previous focus underneath it.

Provider replacement targets are resolved from the same bounded task records, but ordinals use each
projected thread's immutable `createdAt` order rather than this list's MRU order. A replacement
request such as “actually use Claude for the first task” must carry the known candidate set into
the Host manager; an ambiguous, missing, or legacy task without creation metadata is reported for
clarification before any mutation. The source session is stopped and its correlated receipt is
confirmed before a successor is created; the successor is focused only after its start is accepted.
Once the stop succeeds, queued follow-ups on the retired source remain in its history and are not
restarted by a late ready transition.

## Director interface

The Director receives an utterance plus the task desk projection and returns one closed command:

```ts
type TaskDeskCommand =
  | { action: "start-new"; instruction?: string }
  | { action: "focus"; threadId: ThreadId; taskRef?: JarvisTaskRef }
  | { action: "back" }
  | { action: "forward" }
  | { action: "steer"; threadId: ThreadId; instruction: string }
  | { action: "queue"; threadId: ThreadId; instruction: string }
  | { action: "clarify"; frame: TaskClarificationFrame };
```

The interface never accepts a model-generated thread ID. Entity resolution searches only real task records supplied by the projection. A resolver may match exact titles, project names, ordinals, recency phrases, lifecycle descriptions, and conservative phonetic aliases. Low-confidence or tied results create a clarification frame. A task candidate includes its node label, so equal task names on two nodes remain distinct until the user chooses one.

Examples:

- “Start another conversation” arms `start-new`; the next instruction creates a thread while the old focus moves onto the back stack.
- “Go back” moves the cursor to the previous stable thread without starting an agent.
- “Switch to the Rivvl review task” searches recent tasks by title, objective, state, and confirmed aliases.
- “The task before that” navigates history rather than guessing from the visible T3 screen.
- “Second one” fills the candidates stored in the current clarification frame; it is not interpreted as a new task.

## Node-qualified task identity

`ProjectRef` (`nodeId` plus `projectId`) is the only safe project target in a multi-node catalog. `TaskRef` adds the `executionNodeId` and remote task/thread identity, and may include the project and provider instance. The task desk stores that reference alongside the local thread ID. A task started from a client on Desk but targeted at Laptop therefore remains a Laptop task for status, steering, queueing, interruption, and continuation.

The desk never repairs a disconnected target by choosing another node. If the execution node is offline, the control operation reports that state; after reconnect, the same `TaskRef` can be used again. This is deliberately different from copying a task or synchronizing a repository.

## Placement

Task identity and navigation policy belong on T3/Jarvis Host so web, desktop, and Companion share the behavior. The multi-node web/desktop client routes through `EnvironmentRegistry`; Companion uses its persisted node directory and still sends typed commands to the selected T3 host. The server persists desk changes as typed events and projects a bounded per-client task desk. Mobile and any central discovery service are outside this MVP.

Project pronunciation is Host-wide rather than part of a device task desk. `JarvisProjectLexicon` appends typed learn/forget events and projects a bounded alias set keyed by real project ID. A correction is learned only after a durable project clarification is consumed, or through the authenticated alias-management operation. The HTTP and WebSocket vocabulary reads join those aliases to the live project shell, so aliases for deleted projects never enter a client vocabulary. Full and Controller pass bounded live project, repository, provider, and model names into the capture-scoped Parakeet decoder hosted by Pipecat. Pipecat emits raw ASR text only. After Parakeet finalizes a push-to-talk capture, the client queues that raw recognition envelope; it does not bind the text to an empty or stale catalog. At dequeue, the shared `groundVoiceTurn` Director scans a project-bearing slot against the fresh node-qualified catalog. Exact aliases and clear spelling corrections produce a canonical utterance. A unique phonetic match pauses that same FIFO item for explicit confirmation, so a later capture cannot overtake it. Tied names become node-labeled choices. Confirmation resumes the original request and stores the pronunciation on the Host; discard removes the paused item without dispatch. Provider/model replacements still require provider-routing language.

Voice requests carry `inputMode: voice` through request metadata so routing finishes before provider dispatch. The pure Director owns the control action, authoritative project grounding, canonical objective, request classification, and execution policy. Full and Controller use the same pure grounding interface for multi-node preview, but the selected Host repeats the decision against its authoritative local catalog before task creation. A grounded result binds the route and canonical objective together; callers cannot consume a project sound-alike while forwarding the conflicting ASR span as provider intent. An explicit project name overrides ambient UI attention; only a deliberate `continueContext` request pins the existing task. An uncertain match returns a clarification without creating a thread or dispatching a provider turn. The original ASR text is retained as `requestMetadata.sourceUtterance` for diagnostics and retry identity; the visible user message, durable task objective, and provider prompt contain only the canonical request. Routing policy is never injected into the chat message. Jarvis does not silently force inspections into supervised mode: new tasks use the normal runtime mode, while an explicitly supervised thread keeps provider approvals enabled.

Outcome presentation is also Host-owned. Provider ingestion records a typed terminal-result activity only after it finalizes every assistant segment, including segments resumed after a blocker, and that authoritative successful result immediately emits `jarvis.turn.completion-ready`. Checkpoint capture is optional workspace bookkeeping: when a matching ready checkpoint is available, `buildOutcomeBriefing` includes its change counts as structured metadata; a capture failure is retained as a diagnostic and never suppresses or replaces the provider result. Startup repair replays recent finalized results and is idempotent, so overlapping live delivery and replay produce one completion activity. Neither path treats an interim message or earlier session-ready transition as completion. `buildOutcomeBriefing` projects a bounded goal, outcome, important findings, provider-stated change details, verification and limitations, next actions, and spoken text while `JarvisVoiceReport.text` retains the complete provider result for rolling compatibility. Status-check briefings lead with a direct working/not-working verdict, followed by evidence, the blocking cause, and the next action. Checkpoint file counts are not inserted into speech. The report also retains its `TaskRef` and origin interaction. The originating interaction receives the short briefing; other clients use the durable report replay and full T3 thread without independently reinterpreting it. The projection is deliberately conservative and does not infer success merely from generic tool activity.

Kokoro streams sentence-sized WAV chunks through one speech arbiter and one native output stream per reply. It permits one active playback, keeps task acknowledgements in submission order, collapses only stale pending reports, and clears every pending item on explicit barge-in. Production speech uses a slightly slower conversational rate and broader pause scale than the original profile. Chunks are paced into the same device stream without per-chunk padding; one 140 ms silent tail is written after the final chunk so teardown cannot clip the final phoneme. Playback completion follows paced device delivery rather than a new process exit for every sentence.

On native Wayland, Electron cannot place a top-level voice dock. Full Desktop therefore keeps its main workspace on Wayland and owns one isolated XWayland helper process for the dock only. The helper has a separate Chromium profile, accepts state over stdin, and exits with the resident Desktop process. X11, Windows, and macOS continue to use the in-process overlay window.

An optional language model can later propose `{ action, entityText }` when the deterministic grammar cannot interpret a long paraphrase. The server must still resolve `entityText` against real task/project candidates, apply confidence thresholds, request clarification, and authorize the final typed command. The model never owns focus, IDs, approvals, or dispatch.

## Conversation repair

Clarification is state, not another prompt string. A frame records its expected slot, candidates, original instruction, expiry, and safe cancel behavior. The following turn is resolved against that frame before normal intent parsing. This follows established dialogue-manager patterns: explicit slots/entities, persisted conversation events, and separate clarification/correction frames.

Useful references:

- [Apple App Intents entity queries](https://developer.apple.com/documentation/appintents/entity-queries) resolve spoken language into application-owned entity identifiers.
- [Alexa dialog management](https://developer.amazon.com/en-US/docs/alexa/smapi/interaction-model-schema.html) models elicitation, validation, and confirmation explicitly.
- [Rasa dialogue management](https://rasa.com/docs/learn/concepts/dialogue-management/) separates language understanding commands from controlled flow execution and supports multiple active flows.
- [Rasa dialogue frames](https://rasa.com/docs/reference/primitives/conditions/) represent clarification, correction, interruption, and continuation as explicit state.

## Delivery slices

1. **Delivered foundation:** exact focus, blocking attention, lifecycle state, and bounded history persist as typed events plus a per-session Host projection. Authenticated HTTP and WebSocket clients can read that projection, execution uses Host focus, and a subscriber-independent Host reactor projects blocking, completion, failure, and interruption without rewriting navigation history.
2. **Delivered typed interface:** authenticated clients can move back, move forward, arm a one-turn independent conversation, and focus an exact known thread without guessing IDs.
3. **Delivered grounding:** deterministic voice navigation resolves back, forward, new-conversation, and conservative task matches against bounded real titles, objectives, lifecycle state, and confirmed aliases. Project targeting resolves real titles, workspace basenames, repository names, and conservative phonetic matches across node-qualified catalogs; tied names become labeled clarification candidates.
4. **Delivered repair and learning:** ambiguous and unknown task matches persist bounded frames with real candidate IDs; ordinal replies and cancellation resolve them before normal intent handling. Project corrections preserve and resume the exact request, append confirmed pronunciations to a Host-wide lexicon, and expose the combined live vocabulary over HTTP and WebSocket. Alias removal is the reverse operation.
5. **Delivered multi-node routing:** `EnvironmentId` is the node identity, `ProjectRef` and `TaskRef` cross the wire, provider availability is evaluated per node, and deterministic request metadata prevents duplicate routed tasks. Origin-directed report briefing and per-session replay preserve the interaction that started work.
6. Add an optional constrained language adapter only for utterances the deterministic interpreter rejects.

Each slice must cover HTTP and WebSocket clients, restart durability, two-device independence, blocked approval attention, and an integration test that proves the chosen thread ID receives the next turn.
