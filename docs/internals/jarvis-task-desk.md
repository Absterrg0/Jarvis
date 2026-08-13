# Jarvis task desk

The task desk is the proposed deterministic layer for navigating several Jarvis conversations by voice. It is not a thread list disguised as a voice assistant and it is not an LLM choosing arbitrary IDs.

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
- “Switch to the Rivvl review” searches recent tasks by project, title, objective, and task relationship.
- “The task before that” navigates history rather than guessing from the visible T3 screen.
- “Second one” fills the candidates stored in the current clarification frame; it is not interpreted as a new task.

## Placement

Task identity and navigation policy belong on Jarvis Host so web, desktop, mobile, and Companion share the behavior. The Companion remains an adapter: it captures speech, supplies its device/session identity, renders prompts, and sends typed commands. The server persists desk changes as typed events and projects a bounded per-client task desk.

An optional language model can later propose `{ action, entityText }` when the deterministic grammar cannot interpret a long paraphrase. The server must still resolve `entityText` against real task/project candidates, apply confidence thresholds, request clarification, and authorize the final typed command. The model never owns focus, IDs, approvals, or dispatch.

## Conversation repair

Clarification is state, not another prompt string. A frame records its expected slot, candidates, original instruction, expiry, and safe cancel behavior. The following turn is resolved against that frame before normal intent parsing. This follows established dialogue-manager patterns: explicit slots/entities, persisted conversation events, and separate clarification/correction frames.

Useful references:

- [Apple App Intents entity queries](https://developer.apple.com/documentation/appintents/entity-queries) resolve spoken language into application-owned entity identifiers.
- [Alexa dialog management](https://developer.amazon.com/en-US/docs/alexa/smapi/interaction-model-schema.html) models elicitation, validation, and confirmation explicitly.
- [Rasa dialogue management](https://rasa.com/docs/learn/concepts/dialogue-management/) separates language understanding commands from controlled flow execution and supports multiple active flows.
- [Rasa dialogue frames](https://rasa.com/docs/reference/primitives/conditions/) represent clarification, correction, interruption, and continuation as explicit state.

## Delivery slices

1. Persist the task desk and expose a shared typed projection/command contract.
2. Implement back, forward, new-conversation arming, and exact-thread focus.
3. Add bounded task entity search across titles, projects, objectives, relationships, state, and ordinals.
4. Add typed clarification frames and voice alias learning from confirmed corrections.
5. Add an optional constrained language adapter only for utterances the deterministic interpreter rejects.

Each slice must cover HTTP and WebSocket clients, restart durability, two-device independence, blocked approval attention, and an integration test that proves the chosen thread ID receives the next turn.
