# Jarvis task desk

The task desk is the deterministic layer for navigating several Jarvis conversations by voice. The delivered foundation persists exact per-session focus, temporary blocking attention, lifecycle state, bounded recent-task history, and navigation as typed events plus a Host projection; entity resolution and clarification commands remain planned. It is not a thread list disguised as a voice assistant and it is not an LLM choosing arbitrary IDs.

## Domain state

Each companion session owns a small task desk:

- `focusedThreadId`: the exact thread receiving referential commands.
- `backStack` and `forwardStack`: stable thread IDs used by “go back” and “go forward.”
- `recentTasks`: bounded entity records containing thread ID, project ID, title, objective summary, lifecycle state, and learned voice aliases.
- `pendingFrame`: a durable clarification or confirmation frame with typed candidate IDs.
- `newConversationArmed`: a one-turn instruction to create independent work without destroying the current focus history.

Reports may update a task's lifecycle and raise an attention target, but a background completion does not silently rewrite the user's navigation history. A blocking approval may temporarily take attention while preserving the previous focus underneath it.

## Director interface

The Director receives an utterance plus the task desk projection and returns one closed command:

```ts
type TaskDeskCommand =
  | { action: "start-new"; instruction?: string }
  | { action: "focus"; threadId: ThreadId }
  | { action: "back" }
  | { action: "forward" }
  | { action: "steer"; threadId: ThreadId; instruction: string }
  | { action: "queue"; threadId: ThreadId; instruction: string }
  | { action: "clarify"; frame: TaskClarificationFrame };
```

The interface never accepts a model-generated thread ID. Entity resolution searches only real task records supplied by the projection. A resolver may match exact titles, project names, ordinals, recency phrases, lifecycle descriptions, and conservative phonetic aliases. Low-confidence or tied results create a clarification frame.

Examples:

- “Start another conversation” arms `start-new`; the next instruction creates a thread while the old focus moves onto the back stack.
- “Go back” moves the cursor to the previous stable thread without starting an agent.
- “Switch to the Rivvl review task” searches recent tasks by title, objective, state, and confirmed aliases.
- “The task before that” navigates history rather than guessing from the visible T3 screen.
- “Second one” fills the candidates stored in the current clarification frame; it is not interpreted as a new task.

## Placement

Task identity and navigation policy belong on Jarvis Host so web, desktop, mobile, and Companion share the behavior. The Companion remains an adapter: it captures speech, supplies its device/session identity, renders prompts, and sends typed commands. The server persists desk changes as typed events and projects a bounded per-client task desk.

Project pronunciation is Host-wide rather than part of a device task desk. `JarvisProjectLexicon` appends typed learn/forget events and projects a bounded alias set keyed by real project ID. A correction is learned only after a durable project clarification is consumed, or through the authenticated alias-management operation. The HTTP and WebSocket vocabulary reads join those aliases to the live project shell, so aliases for deleted projects never enter a client vocabulary. Companion refreshes vocabulary during every capture before transcript finalization, reads provider/model names, and passes collision-checked terms through the local recognizer adapter. Project replacements require a project-name span; provider/model replacements require provider-routing language. The current Whisper binary does not offer acoustic hotword biasing, so the adapter applies exact vocabulary to decoded segments; unlearned phonetics still enter an explicit confirmation exchange. Companion persists its pending confirmation locally for restart/reconnection, surfaces persistence failures, and exposes learned aliases with idempotent removal actions in its tray.

Outcome presentation is also Host-owned. Provider ingestion records a typed terminal-result activity only after it finalizes every assistant segment, including segments resumed after a blocker. For Git-backed work, a Host reactor joins that terminal result to the matching finalized checkpoint before it emits `jarvis.turn.completion-ready`; non-git work uses an explicit no-checkpoint fallback. Neither path treats an interim message or earlier session-ready transition as completion. `buildOutcomeBriefing` projects a bounded goal, outcome, important findings, matching ready-checkpoint change counts, provider-stated change details, verification and limitations, next actions, and spoken text while `JarvisVoiceReport.text` retains the complete provider result for rolling compatibility. Web, desktop, mobile, and the Companion relay render that typed projection; client-side prose heuristics remain only as an older-Host fallback. The projection is deliberately conservative and does not infer a successful test merely from generic tool activity.

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
3. **Delivered grounding:** deterministic voice navigation resolves back, forward, new-conversation, and conservative task matches against bounded real titles, objectives, lifecycle state, and confirmed aliases. Project targeting resolves real titles, workspace basenames, repository names, and conservative phonetic matches.
4. **Delivered repair and learning:** ambiguous and unknown task matches persist bounded frames with real candidate IDs; ordinal replies and cancellation resolve them before normal intent handling. Project corrections preserve and resume the exact request, append confirmed pronunciations to a Host-wide lexicon, and expose the combined live vocabulary over HTTP and WebSocket. Alias removal is the reverse operation.
5. Add an optional constrained language adapter only for utterances the deterministic interpreter rejects.

Each slice must cover HTTP and WebSocket clients, restart durability, two-device independence, blocked approval attention, and an integration test that proves the chosen thread ID receives the next turn.
