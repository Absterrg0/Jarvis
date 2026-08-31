# Jarvis task desk

The task desk is the deterministic layer for navigating several Jarvis conversations by voice. It persists only a small authenticated-session context. T3 thread and task projections remain the lifecycle authority. In the multi-node MVP, each stored task identity carries the execution node that owns its project and provider conversation. It is not a thread list disguised as a voice assistant and it is not an LLM choosing arbitrary IDs.

## Domain state

Each authenticated client session owns a small current-state record:

- `focusedThreadId`: the exact thread receiving referential commands. Its project reference is retained when the task is routed.
- `recentTasks`: a bounded list of qualified task identities used only for disambiguation and previous-task targeting. Titles, objectives, status, approvals, and input requests are read from current T3 projections.
- `pendingInteraction`: one discriminated task or project clarification/correction frame, with bounded real candidates, an expiry, and a safe cancellation path.

The desk does not observe or copy task lifecycle events. Approvals and user-input requests remain durable T3 state and are read from the selected thread projection when a command is handled. A disconnected execution node is reported as disconnected; the desk never retargets the task.

## Director interface

The Director receives an utterance plus the task desk projection and returns one closed command:

```ts
type TaskDeskCommand =
  | { action: "start-new"; instruction: string }
  | { action: "focus"; threadId: ThreadId; taskRef?: JarvisTaskRef }
  | { action: "steer"; threadId: ThreadId; instruction: string }
  | { action: "queue"; threadId: ThreadId; instruction: string }
  | { action: "clarify"; frame: TaskClarificationFrame };
```

The interface never accepts a model-generated thread ID. Entity resolution searches only real task identities joined to current T3 projection data. A resolver may match exact titles, project names, ordinals, recency phrases, and conservative phonetic aliases. Low-confidence or tied results create a clarification frame. A task candidate includes its node label, so equal task names on two nodes remain distinct until the user chooses one.

Examples:

- “Start another conversation” creates a thread immediately when an objective is present. If the objective is missing, the request remains in the single pending interaction rather than arming hidden next-turn state.
- “Switch to the Rivvl review task” searches recent identities joined to live title, objective, status, and confirmed aliases.
- “The previous task” searches the bounded recent identities rather than guessing from the visible T3 screen.
- “Second one” fills the candidates stored in the current clarification frame; it is not interpreted as a new task.

## Node-qualified task identity

`ProjectRef` (`nodeId` plus `projectId`) is the only safe project target in a multi-node catalog. `TaskRef` is the execution node plus its thread ID. The task desk stores that reference with the project reference; live project, provider, model, and lifecycle data remain in T3. A task started from a client on Desk but targeted at Laptop therefore remains a Laptop task for status, steering, queueing, interruption, and continuation.

The desk never repairs a disconnected target by choosing another node. If the execution node is offline, the control operation reports that state; after reconnect, the same `TaskRef` can be used again. This is deliberately different from copying a task or synchronizing a repository.

## Placement

Task identity and navigation policy belong on T3/Jarvis Host so web and desktop clients share the behavior. The multi-node client routes through `EnvironmentRegistry` and sends typed commands to the selected T3 host. The server persists direct current state per authenticated client session. Mobile and any central discovery service are outside this MVP.

Project pronunciation is Host-wide rather than part of a device task desk. `JarvisProjectLexicon` writes a bounded current alias set keyed by real project ID. A correction is learned only after a durable project clarification is consumed, or through the authenticated alias-management operation. The WebSocket vocabulary read joins those aliases to the live project shell, so aliases for deleted projects never enter a client vocabulary. Full and Controller pass bounded live project, repository, provider, and model names into the capture-scoped Parakeet decoder hosted by Pipecat. Pipecat emits raw ASR text only. After Parakeet finalizes a push-to-talk capture, the client queues that raw recognition envelope; it does not bind the text to an empty or stale catalog. At dequeue, the shared `groundVoiceTurn` Director scans a project-bearing slot against the fresh node-qualified catalog. Exact aliases and clear spelling corrections produce a canonical utterance. A unique phonetic match pauses that same FIFO item for explicit confirmation, so a later capture cannot overtake it. Tied names become node-labeled choices. Confirmation resumes the original request and stores the pronunciation on the Host; discard removes the paused item without dispatch. Provider selection applies when starting ordinary new work; changing a running task's provider is not an automatic stop-and-restart operation.

Voice requests carry `inputMode: voice` through request metadata so routing finishes before provider dispatch. The pure Director owns the control action, authoritative project grounding, canonical objective, request classification, and execution policy. Full and Controller use the same pure grounding interface for multi-node preview, but the selected Host repeats the decision against its authoritative local catalog before task creation. A grounded result binds the route and canonical objective together; callers cannot consume a project sound-alike while forwarding the conflicting ASR span as provider intent. An explicit project name overrides ambient UI attention; only a deliberate `continueContext` request pins the existing task. An uncertain match returns a clarification without creating a thread or dispatching a provider turn. The original ASR text is retained as `requestMetadata.sourceUtterance` for diagnostics and retry identity; the visible user message, durable task objective, and provider prompt contain only the canonical request. Routing policy is never injected into the chat message. Jarvis does not silently force inspections into supervised mode: new tasks use the normal runtime mode, while an explicitly supervised thread keeps provider approvals enabled.

Outcome presentation is also Host-owned, but it is an ephemeral adapter over durable T3 state. Provider ingestion records a typed terminal-result activity only after it finalizes every assistant segment, including segments resumed after a blocker. A live `jarvis.subscribePresentation` subscriber projects that activity directly into a minimal completion event; it does not create a `jarvis.turn.completion-ready` activity. Approval and user-input activities are presented live from their existing typed T3 events, and their resolution remains durable T3 state. A disconnected client receives no replayed speech; the full result and blocker remain in the ordinary thread and task desk UI. The projection is conservative and does not infer success merely from generic tool activity.

Kokoro streams sentence-sized PCM through one speech queue and one Pipecat-managed output stream per reply. It permits one active playback and preserves local FIFO/cancel behavior. Presentations are not durable delivery items: there is no outbox, lease, election, acknowledgement, retry, or persisted seen state. Production speech uses a slightly slower conversational rate and broader pause scale than the original profile. Pipecat owns chunking and device writes at Kokoro's native format; Linux delegates routing and drain to PipeWire without naming a device. Playback completes only after Pipecat reaches its stopped-speaking boundary, the native stream drains, and no output failure was recorded.

On native Wayland, Electron cannot place a top-level voice dock. Full Desktop therefore keeps its main workspace on Wayland and owns one isolated XWayland helper process for the dock only. The helper has a separate Chromium profile, accepts state over stdin, and exits with the resident Desktop process. X11, Windows, and macOS continue to use the in-process overlay window.

The semantic supervisor proposes a typed action plus catalog entity text for every normal command turn. The server still resolves that text against real task/project candidates, requests clarification for missing or tied targets, and authorizes the final typed command. The model never owns focus, IDs, approvals, or dispatch. Pending clarification, approval, and worker-input frames are typed state and take precedence over a conflicting model proposal.

## Conversation repair

Clarification is state, not another prompt string. A frame records its expected slot, candidates, original instruction, expiry, and safe cancel behavior. The following turn is resolved against that frame before normal intent parsing. This follows established dialogue-manager patterns: explicit slots/entities, persisted conversation events, and separate clarification/correction frames.

Useful references:

- [Apple App Intents entity queries](https://developer.apple.com/documentation/appintents/entity-queries) resolve spoken language into application-owned entity identifiers.
- [Alexa dialog management](https://developer.amazon.com/en-US/docs/alexa/smapi/interaction-model-schema.html) models elicitation, validation, and confirmation explicitly.
- [Rasa dialogue management](https://rasa.com/docs/learn/concepts/dialogue-management/) separates language understanding commands from controlled flow execution and supports multiple active flows.
- [Rasa dialogue frames](https://rasa.com/docs/reference/primitives/conditions/) represent clarification, correction, interruption, and continuation as explicit state.

## Delivery slices

1. **Delivered foundation:** exact focus, qualified bounded history, and one pending interaction persist as direct per-session Host state. The authenticated WebSocket client reads a live view derived from T3 lifecycle and blocking projections.
2. **Delivered typed interface:** authenticated clients can focus an exact known thread and start independent work immediately when its objective is available. There is no hidden one-turn mode or browser-style forward history.
3. **Delivered grounding:** deterministic voice navigation resolves conservative task matches against bounded real titles, objectives, lifecycle state, and confirmed aliases. Project targeting resolves real titles, workspace basenames, repository names, and conservative phonetic matches across node-qualified catalogs; tied names become labeled clarification candidates.
4. **Delivered repair and learning:** ambiguous and unknown task matches persist bounded frames with real candidate IDs; ordinal replies and cancellation resolve them before normal intent handling. Project corrections preserve and resume the exact request, append confirmed pronunciations to a Host-wide lexicon, and expose the combined live vocabulary over WebSocket. Alias removal is the reverse operation.
5. **Delivered multi-node routing:** `EnvironmentId` is the node identity, `ProjectRef` and `TaskRef` cross the wire, provider availability is evaluated per node, deterministic request metadata prevents duplicate routed tasks, and live presentations are directed to the exact origin interaction without replay.
6. **Delivered semantic supervision:** a configurable provider-neutral supervisor proposes schema-constrained intent, while the deterministic validator retains catalogs, authority, clarification, and dispatch.

Each slice must cover restart durability, two-device independence, blocked approval attention, and an integration test that proves the chosen thread ID receives the next turn.
