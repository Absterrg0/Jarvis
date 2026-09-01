# Jarvis controller

> For maintainers. Using T3 Code? See [Jarvis](../user/jarvis.md).

Jarvis is a provider-neutral command and voice layer over the existing T3 orchestration domain. It does not introduce a manager model or bypass provider adapters. For the multi-node MVP, T3 remains the authority: each running T3 environment is one execution node, and Jarvis routes a request to that node's ordinary orchestration and provider services.

## Multi-node boundary

`EnvironmentId` is the stable node identity. The client does not invent a second Jarvis identity or copy a project's files between nodes. Web and desktop clients keep paired environments in `EnvironmentRegistry`, refresh each node independently, and combine only the presentation catalog.

The combined catalog is node-qualified:

- `ProjectRef` is `{ nodeId, projectId }`. A project ID is meaningful only in its owning environment.
- `TaskRef` is `{ executionNodeId, threadId }`. Project and provider data are read from the owning node's current T3 projection.
- Projects, providers, and task-desk entries are grouped and labeled by node. Equal project titles are candidates, not an implicit selection.
- Provider readiness is read from the target node's live provider registry. A provider that is installed or authenticated on one node is not available on another node until that node is configured independently.

The client sends the selected `ProjectRef` to the target environment. The authenticated WebSocket boundary checks that the reference belongs to its own `EnvironmentId`; a disconnected or mismatched target fails instead of falling back to another node. A continuation uses the `TaskRef`'s execution node and remote thread identity (represented on the execution input by the qualified project and exact reference thread), so the follow-up is executed by the original node and provider conversation even when the controlling client is attached to a different node. Pairing exchanges only the session credential needed to control the selected T3 environment; provider credentials remain node-local.

The MVP has no central discovery service, mobile multi-node surface, or repository synchronization. Nodes enter the directory through explicit pairing or an existing T3 connection path, and every node keeps its own workspace and event store.

## Director seam

The Jarvis Director has two narrow stages. A configurable semantic supervisor—Codex Luna at low reasoning by default—translates the utterance into a schema-constrained `JarvisSemanticIntent` containing action and catalog names, never IDs. The pure `interpretJarvisCommand` validator then resolves those names against authoritative project, task, provider, and model catalogs and produces one discriminated `JarvisCommand`: start, continue, queue, stop, status, review, reroute, focus, answer a pending request, or request clarification. For voice turns, deterministic acoustic project grounding runs before the semantic supervisor.

This boundary is deliberately narrow:

- The web/desktop mesh previews spoken project names against the typed catalogs of connected nodes. It never tells an agent to change directory, and the selected Host validates the target again against its local catalog.
- Full and Controller queue raw recognition envelopes until a fresh catalog is available. Exact and conservative spelling matches produce a stable `ProjectRef` plus canonical utterance; a phonetic match or node collision pauses the request for clarification.
- The supervisor handles natural paraphrases, but its proposal has no authority. It cannot provide internal IDs, authorize a tool, answer an approval without typed pending state, or dispatch a command.
- Voice clients play a local cue before sending the semantic request. For commands that start provider work,
  the supervisor may also return one schema-bounded acknowledgement sentence. The validator carries that
  sentence beside the closed command, never inside it, and the client speaks it only after validation and
  dispatch acceptance. Deterministic clarification, status, stop, focus, and queue responses keep their own text.
- The validator accepts only exact catalog entities or a prior deterministic acoustic resolution. Unknown and tied names become bounded clarification instead of guesses.
- `JarvisController` owns one server turn: it loads the node catalogs and compact Task Desk state, resolves the request, and adapts the result to ordinary T3 commands on the selected execution node. Providers still receive turns through their existing adapters.
- Queued follow-ups are durable rows in `jarvis_follow_up_queue` containing the exact thread, instruction, request metadata, position, status, and timestamps. `JarvisFollowUpDispatcher` atomically claims the oldest pending row when that thread becomes ready and derives a deterministic dispatch identity from the queue ID for retry safety. Model, runtime, and interaction settings come from the fresh T3 thread.
- Approval presentation is an adapter over typed approval data. It keeps the exact command for visual review while speech receives a conservative risk explanation.

The supervisor uses the selected provider instance's ordinary schema-constrained text-generation capability, so Jarvis has no private provider execution path. `ServerSettings.jarvisSupervisorModelSelection` selects the supervisor independently from the coding agent used for the resulting task. Each semantic request runs in a new empty temporary directory that is removed afterward. Codex and Claude disable their execution, MCP, and customization surfaces; OpenCode denies all permissions. An adapter that cannot guarantee a tool-free structured session, currently Cursor and Grok ACP, refuses supervisor generation. The supervisor therefore receives only the semantic prompt and schema and never runs with access to the selected project's repository or tools.

Exact task focus and named-task resolution are specified separately in [Jarvis task desk](./jarvis-task-desk.md). The desk keeps only qualified recent identity and one pending interaction; T3 supplies live task state.

## Request path

1. A Full or Controller client sends `jarvis.execute` over the authenticated WebSocket RPC boundary with a node-qualified `ProjectRef`, an optional exact reference/context thread, request metadata, and utterance. Before dispatching, it previews an explicit spoken project name across the connected-node catalog. Ambiguity—including equal names on different nodes—becomes a clarification with labeled candidates. The server rejects an ambiguous unscoped request instead of guessing from visible or recent UI activity.
2. The selected semantic supervisor returns one schema-constrained proposal using catalog names. `interpretJarvisCommand` then deterministically validates project, task, provider, model, effort, pending approval/input state, and continuation authority against the selected node. A client may instead provide a saved `ModelSelection`; the server revalidates it against that same node. It never substitutes a provider from a different node or accepts a model-invented ID.
3. Before executing a task-control proposal, `JarvisController` reloads the exact selected thread from the authoritative projection. Steering, queueing, stopping, status, and rerouting use that fresh thread's identity, state, model, runtime mode, and interaction mode. If the task disappeared or changed state while the supervisor was responding, execution reports the fresh condition instead of acting on the semantic snapshot.
4. `JarvisController` emits ordinary orchestration commands on the execution node. New work uses `thread.turn.start`; questions and approvals use the existing response commands. Steering, queueing, interruption, and continuation use the exact node-qualified task reference; rerouting creates a new thread in the newly resolved project and node. Clarification is stored in the session's Task Desk state.
5. Cross-provider reviews create an ordinary target-provider thread on the selected node and append reciprocal `jarvis.review.*` activities so the relationship is durable and inspectable.

Unknown or unavailable selections return structured clarification. There is no silent provider or model fallback.

### Node-owned default agent

`ServerSettings.jarvisDefaultModelSelection` is a nullable, atomically replaced model selection.
The control center reads and updates it through the selected environment's existing config and
settings commands, never through primary-environment settings. No additional mesh protocol or
provider-specific dispatch path is needed.

For new tasks, selection precedence is explicit request selection, explicit
spoken provider/model, node Jarvis default, then the project's ordinary default. The Director's
existing clarification behavior applies when none resolves. Defaults are passed as
`fallbackModelSelection`, separately from authoritative `modelSelection`, so a project preference
cannot suppress a spoken provider choice. Continuations, queued work, and reroutes preserve their
existing task's selection. A configured but unavailable selection is an error to explain, not
permission to choose a different agent.

The web/desktop control center projects live registered connections alongside the asynchronously
loaded mesh catalog. It marks the desktop primary environment as this device, but never labels a
browser's remote primary environment as the user's device. Connection membership/status changes
refresh catalogs without polling, and stale refresh responses cannot overwrite newer results.

For routed work, the client supplies a stable `requestId` plus optional origin node and interaction identity. The server derives command and event identifiers from an authenticated acceptance key and persists the request metadata in the task-created activity. T3's command receipts and event metadata are the authoritative deduplication record: retrying the same request reuses the receipt-backed command identifiers, while reusing a request ID with a different payload returns a conflict instead of creating a second task. This is idempotency at the command/event boundary, not a task name that callers may reuse for unrelated work.

## Presentation path

T3 orchestration state is the durable truth for a task's result, pending approval, and pending user
input. Jarvis adds no parallel report or completion state. Provider ingestion appends the generic
`provider.turn.result-finalized` activity after the provider has finalized the turn; approval and
user-input requests use the existing typed T3 activities; runtime failures use the existing session
and activity events. The thread projection remains complete and visible even when speech is disabled,
fails, or the client is absent.

The authoritative node exposes one live `jarvis.subscribePresentation` WebSocket stream. The client
supplies its origin interaction identity (and, when available, origin node identity); the server
projects only Jarvis-owned task events into a minimal `JarvisPresentationEvent` for completed, failed,
approval-needed, or waiting-for-input states. It filters by the exact origin and never routes a
presentation to another controller. Subscriptions start at connection time and do not replay old
orchestration events, so a disconnected controller receives no stale speech after reconnect. The
ordinary T3 task desk and thread UI expose the durable result or blocker on reconnect.

Presentation is ephemeral. The connected Full or Controller client keeps a small in-memory bounded
dedupe set and sends events to its local FIFO/cancel speech path. There is no report inbox or outbox,
cursor, batch acknowledgement, claim, confirmation, release, speaker election, lease, or delivery
retry state. A speech failure may surface a toast, but it never changes or acknowledges the T3 task
state. Headless nodes execute and persist T3 state but do not mount voice presentation.

## Performance boundaries

- The UI host is small; the dialog is dynamically imported.
- Disabled voice clients do not subscribe to the presentation stream.
- Speech recognition exists only for a single user-initiated capture.
- Full Desktop speech uses the resident Parakeet recognizer and quantized Kokoro child process through separate worker commands. Task submission starts speech preparation before Host dispatch. Adaptive retention keeps the worker available during active work and allows up to 120 seconds of idle warmth before offload when it is not active. The user can interrupt current playback without changing T3 task state.
- Live presentation reuses the authenticated WebSocket and T3 Connect transport; it starts at connection time and does not poll or replay durable history.
- No new provider-specific logic exists; adapters continue to receive normal orchestration commands.

The Jarvis wire contracts live in `packages/contracts/src/jarvis.ts`; the server boundary is
`apps/server/src/jarvis/` and the WebSocket handlers. Generic snapshots, thread detail, and
dispatch remain available through `apps/server/src/orchestration/http.ts`.
