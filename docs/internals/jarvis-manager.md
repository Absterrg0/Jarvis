# Jarvis manager

> For maintainers. Using T3 Code? See [Jarvis command relay](../user/jarvis.md).

Jarvis is a provider-neutral command and voice layer over the existing T3 orchestration domain. It does not introduce a manager model or bypass provider adapters.

## Director seam

The Jarvis Director is a deterministic control module, not an LLM. It accepts an utterance, the project already resolved by the client, and an optional exact task reference. It produces one closed plan: start, steer, queue, interrupt, report status, reroute, focus a project, or request clarification.

This boundary is deliberately narrow:

- Companion resolves spoken project names against the host's typed project catalog. It never tells an agent to change directory.
- The Companion voice adapter treats that catalog as a closed entity vocabulary. Exact, ordinal, and conservative phonetic resolution produce a stable project ID; canonical names replace clear ASR sound-alikes before dispatch.
- The Director interprets only a controlled conversational grammar. It never invents a thread or project when a referential phrase is ambiguous.
- `JarvisManager` adapts the plan to ordinary T3 commands. Providers still receive turns through their existing adapters.
- Queued follow-ups are durable `jarvis.followup.queued` activities. `JarvisQueueReactor` starts the next item when the exact thread becomes ready, with deterministic command identifiers for replay safety.
- Approval presentation is an adapter over typed approval data. It keeps the exact command for visual review while speech receives a conservative risk explanation.

The Director is intentionally extensible through more typed intents and adapters. An optional language model may later normalize unusually phrased speech into this schema, but it must never authorize tools, select an ambiguous target, or dispatch orchestration commands directly.

Multi-conversation focus, back/forward navigation, and named-task resolution are specified separately in [Jarvis task desk](./jarvis-task-desk.md). They require durable per-client focus history rather than expanding the single recent-task reference into more regular expressions.

## Request path

1. A full client sends `jarvis.execute` with an environment-local project, optional context thread, and utterance. Before using the authenticated `POST /api/orchestration/jarvis` boundary, the Windows Companion resolves an explicit spoken project name, the environment's only project, or its last successful voice project. Ambiguity becomes a spoken clarification. An older Companion may omit the project only when the environment has exactly one project; the server rejects an ambiguous unscoped request instead of guessing from visible or recent UI activity.
2. `resolveTaskIntent` deterministically matches explicit provider, model, and effort names against the live provider registry. A Companion may instead provide a saved `ModelSelection`; the server revalidates it against the same live registry and treats the utterance as the objective.
3. `JarvisManager` emits ordinary orchestration commands. New work uses `thread.turn.start`; questions and approvals use the existing response commands. Steering starts a turn on the exact thread, interruption uses `thread.turn.interrupt`, and rerouting creates a new thread in the resolved project.
4. Cross-provider reviews create an ordinary target-provider thread and append reciprocal `jarvis.review.*` activities so the relationship is durable and inspectable.

Unknown or unavailable selections return structured clarification. There is no silent provider or model fallback.

## Report path

`JarvisReportReactor` observes report-worthy orchestration events independently of presentation subscribers, reloads canonical thread detail, and appends each immutable report to a bounded Host outbox. It replays persisted orchestration events on startup, so a crash between the domain commit and report projection does not permanently lose the report. Resolved approval and user-input activities deactivate only the matching request's pending report.

Capability-aware clients use `jarvis.subscribeReportInbox`. The first subscription registers the authenticated session at the current outbox head; later reports remain pending across WebSocket disconnects and Host or Companion restarts until that session monotonically acknowledges a batch. Batches contain at most 32 rows, inactive rows advance the cursor without presentation, and retention is bounded to the newest 512 reports with an explicit truncation marker when a cursor falls behind. Cursors use the authenticated pairing session rather than the renderer's ephemeral speaker-election device ID, so separate paired devices progress independently. `jarvis.subscribeReports` remains the hot, single-report compatibility stream for older clients.

Clients claim each report through `jarvis.claimSpeaker`. `JarvisSpeakerLease` collects claims for 200 ms, chooses the highest priority with a stable device-id tie break, and freezes the winner for the report's retention window. It owns no timer, heartbeat, or polling fiber; expired elections are removed opportunistically on the next claim.

For durable-inbox reports, the winning claim acquires a two-minute Host-persisted speech lease. The client confirms the report only after synthesis succeeds; another device cannot speak during the lease, while a crashed winner leaves the report eligible for a later election after expiry. Confirmed reports remain deduplicated for the outbox retention lifetime, including across Host restarts.

The winning client remembers the report's environment, project, and thread in memory. The next relay response can therefore target the reporting thread even when another thread is visible. The server also rejects a continuation whose thread and project do not match, and a missing continuation thread cannot silently become new work.

## Performance boundaries

- The UI host is small; the dialog is dynamically imported.
- Disabled voice clients do not subscribe to the report stream.
- Speech recognition exists only for a single user-initiated capture.
- Companion speech synthesis uses a locally bundled Piper voice; its process and generated WAV are short-lived, with no resident model. The user can interrupt current playback from the Companion without changing Host report acknowledgement.
- Durable report delivery reuses the authenticated WebSocket and T3 Connect transport; append, acknowledgement, and blocker-resolution events wake subscribers without polling.
- No new provider-specific logic exists; adapters continue to receive normal orchestration commands.

The wire contracts live in `packages/contracts/src/jarvis.ts` and `packages/contracts/src/environmentHttp.ts`; the server boundary is `apps/server/src/jarvis/`, `apps/server/src/orchestration/http.ts`, and the WebSocket handlers. The Companion exchanges its pairing credential for an Electron session cookie, obtains a provider catalog through `GET /api/orchestration/jarvis/providers`, and sends its transcript plus saved selection through `POST /api/orchestration/jarvis` directly. Its hidden page has a report-only preload bridge and is never a task-start relay.
