# Jarvis manager

> For maintainers. Using T3 Code? See [Jarvis command relay](../user/jarvis.md).

Jarvis is a provider-neutral command and voice layer over the existing T3 orchestration domain. It does not introduce a manager model or bypass provider adapters.

## Request path

1. A client sends `jarvis.execute` with an environment-local project, optional context thread, and utterance.
2. `resolveTaskIntent` deterministically matches explicit provider, model, and effort names against the live provider registry.
3. `JarvisManager` emits ordinary orchestration commands. New work uses `thread.turn.start`; questions and approvals use the existing response commands.
4. Cross-provider reviews create an ordinary target-provider thread and append reciprocal `jarvis.review.*` activities so the relationship is durable and inspectable.

Unknown or unavailable selections return structured clarification. There is no silent provider or model fallback.

## Report path

`jarvis.subscribeReports` filters the existing domain-event stream. Only threads marked by a `jarvis.*` activity produce reports. Completed assistant messages and blocking/error activities are reloaded from the projection so a report contains canonical, final text.

Clients claim each report through `jarvis.claimSpeaker`. `JarvisSpeakerLease` collects claims for 200 ms, chooses the highest priority with a stable device-id tie break, and freezes the winner for the report's retention window. It owns no timer, heartbeat, or polling fiber; expired elections are removed opportunistically on the next claim.

The winning client remembers the report's environment, project, and thread in memory. The next relay response can therefore target the reporting thread even when another thread is visible.

## Performance boundaries

- The UI host is small; the dialog is dynamically imported.
- Disabled voice clients do not subscribe to the report stream.
- Speech recognition exists only for a single user-initiated capture.
- Speech synthesis uses the client operating system or browser; no local model is resident.
- Report delivery reuses the authenticated WebSocket and T3 Connect transport.
- No new provider-specific logic exists; adapters continue to receive normal orchestration commands.

The wire contracts live in `packages/contracts/src/jarvis.ts`, shared client operations in `packages/client-runtime/src/operations/jarvis.ts`, and the server boundary in `apps/server/src/jarvis/` plus the WebSocket handlers.
