# Jarvis manager

> For maintainers. Using T3 Code? See [Jarvis command relay](../user/jarvis.md).

Jarvis is a provider-neutral command and voice layer over the existing T3 orchestration domain. It does not introduce a manager model or bypass provider adapters.

## Request path

1. A full client sends `jarvis.execute` with an environment-local project, optional context thread, and utterance. Before using the authenticated `POST /api/orchestration/jarvis` boundary, the Windows Companion resolves an explicit spoken project name, the environment's only project, or its last successful voice project. Ambiguity becomes a spoken clarification. An older Companion may omit the project only when the environment has exactly one project; the server rejects an ambiguous unscoped request instead of guessing from visible or recent UI activity.
2. `resolveTaskIntent` deterministically matches explicit provider, model, and effort names against the live provider registry. A Companion may instead provide a saved `ModelSelection`; the server revalidates it against the same live registry and treats the utterance as the objective.
3. `JarvisManager` emits ordinary orchestration commands. New work uses `thread.turn.start`; questions and approvals use the existing response commands.
4. Cross-provider reviews create an ordinary target-provider thread and append reciprocal `jarvis.review.*` activities so the relationship is durable and inspectable.

Unknown or unavailable selections return structured clarification. There is no silent provider or model fallback.

## Report path

`jarvis.subscribeReports` filters the existing domain-event stream. Only threads marked by a `jarvis.*` activity produce reports. Completed assistant messages and blocking/error activities are reloaded from the projection so a report contains canonical, final text.

Clients claim each report through `jarvis.claimSpeaker`. `JarvisSpeakerLease` collects claims for 200 ms, chooses the highest priority with a stable device-id tie break, and freezes the winner for the report's retention window. It owns no timer, heartbeat, or polling fiber; expired elections are removed opportunistically on the next claim.

The winning client remembers the report's environment, project, and thread in memory. The next relay response can therefore target the reporting thread even when another thread is visible. The server also rejects a continuation whose thread and project do not match, and a missing continuation thread cannot silently become new work.

## Performance boundaries

- The UI host is small; the dialog is dynamically imported.
- Disabled voice clients do not subscribe to the report stream.
- Speech recognition exists only for a single user-initiated capture.
- Companion speech synthesis uses a locally bundled Piper voice; its process and generated WAV are short-lived, with no resident model.
- Report delivery reuses the authenticated WebSocket and T3 Connect transport.
- No new provider-specific logic exists; adapters continue to receive normal orchestration commands.

The wire contracts live in `packages/contracts/src/jarvis.ts` and `packages/contracts/src/environmentHttp.ts`; the server boundary is `apps/server/src/jarvis/`, `apps/server/src/orchestration/http.ts`, and the WebSocket handlers. The Companion exchanges its pairing credential for an Electron session cookie, obtains a provider catalog through `GET /api/orchestration/jarvis/providers`, and sends its transcript plus saved selection through `POST /api/orchestration/jarvis` directly. Its hidden page has a report-only preload bridge and is never a task-start relay.
