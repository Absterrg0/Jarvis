# Glossary

Terms whose meaning matters across T3 Code. Architecture and lifecycle constraints belong in the
[overview](./overview.md), not in these definitions.

## Workspace and conversation

| Term           | Meaning                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------- |
| Environment    | One running server and the machine, credentials, workspace access, and state it owns.             |
| Client         | A web, desktop, or mobile UI connected to an environment. The desktop app can also host a server. |
| Project        | An environment-local workspace record rooted at a directory.                                      |
| Workspace root | The project's base filesystem directory on the environment.                                       |
| Worktree       | A separate Git checkout a thread can use instead of the project's main checkout.                  |
| Thread         | The durable conversation and work history for a project. It survives provider process exits.      |
| Turn           | One user-to-agent work cycle. Provider work can finish before checkpoint and diff work settles.   |
| Activity       | A non-message timeline item, such as a tool action, approval, or failure.                         |
| T3 home        | The base data directory. Runtime state normally lives under its `userdata` directory.             |

## Orchestration

| Term                    | Meaning                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| Command                 | A request to change domain state. Accepting it does not mean its side effects have finished. |
| Event                   | A persisted fact produced by a command.                                                      |
| Decider                 | The pure logic that turns a command and current state into events.                           |
| Projection / read model | A view of current state derived from persisted events.                                       |
| Projector               | The logic that applies events to a read model.                                               |
| Reactor                 | A worker that performs follow-up work in response to recorded intent or runtime signals.     |
| Command receipt         | A durable record of a command's result, used to make retries idempotent.                     |
| Runtime receipt         | A test-only signal that an asynchronous milestone completed.                                 |
| Quiesced                | The relevant follow-up workers have finished, beyond the provider turn merely ending.        |

## Providers and checkpoints

| Term                | Meaning                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| Provider            | The agent runtime T3 Code controls, such as Codex or Claude Code.                                            |
| Driver              | The integration for a provider kind.                                                                         |
| Provider instance   | One configured provider, with its own settings and lifecycle. Multiple instances can use the same driver.    |
| Adapter             | The boundary translating a provider's native protocol into T3 Code operations and events.                    |
| Session             | The provider runtime attached to a thread. A session can be stopped and resumed without deleting the thread. |
| Runtime mode        | The thread's permission policy. See [permission modes](../user/permission-modes.md).                         |
| Interaction mode    | How the agent approaches the task, such as planning. Separate from permission policy.                        |
| Checkpoint          | A saved workspace state used for diffs and restore, stored as a hidden Git ref.                              |
| Checkpoint baseline | The workspace state captured before the work being compared.                                                 |
| Turn diff           | The workspace changes attributed to one turn.                                                                |

## Pull requests

| Term                 | Meaning                                                                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pull request link    | A persisted thread association identified by host, repository, and number. Links can cross projects within an environment and carry a server-maintained snapshot.                        |
| Pull request sync    | The reactor that refreshes each distinct linked review once per cadence and discovers native stack layers. Explicit refreshes and failed stack reads trigger another read.               |
| Current pull request | The link used by single-review controls and older clients. Open work takes precedence; a completed single chain points at its top layer. Unrelated terminal links use the latest update. |

## Circe product terms

The product layer this fork ships over the T3 foundation.

### Circe product

#### Circe

The canonical product name for this fork. Circe adds deterministic voice control, task navigation, multi-node routing, and spoken reports to the T3 coding foundation. Provider CLIs still do the coding work. See [Circe identity](./circe-identity.md).

#### Upstream T3 names

Names inherited from the T3 foundation that stay T3: the `circe` CLI, `T3CODE_*` settings, `t3code:*` storage keys, and the upstream mobile schemes. Circe does not rename upstream contracts it depends on. See [Circe identity](./circe-identity.md).

### Multi-device Circe

#### Node

A paired T3 environment, identified by its stable `EnvironmentId`. A node owns its projects, providers, threads, workspace, event store, and provider credentials. In the multi-node MVP, a node is the unit of execution and availability; a client label is presentation metadata and does not replace the identity. See [the Circe contracts][26] and [the client mesh][27].

#### Node preset

The installer-selected capability set for one Circe installation: Full, Controller, or Headless. A preset controls which workspace, voice, and execution capabilities are present; it is status metadata, not a second identity or a setup task the user must repeat inside the app.

#### Circe installation

The one user-facing Circe product installed on a device. It owns one launcher, uninstall entry, node directory, and lifecycle even when isolated helper processes provide execution.

#### Execution node

The node that actually owns and runs a Circe task. The execution node is carried by `TaskRef` and is authoritative for the provider process, workspace, thread, checkpoints, and continuation. A controller may be connected to another node, but a continuation never moves to that controller's node just because it is visible there.

#### Voice node

The node that owns a live conversation session for a Controller interaction. It may differ from the execution node and never gains project or provider authority from handling audio.

#### Live conversation

The GPT-Live speech-to-speech session a node mints with its stored API key. The renderer owns microphone and speaker media over WebRTC; the node never sends the key to a client. Delegated requests reuse the ordinary Director, grounding, and provider path.

#### Origin interaction

The stable client interaction identity that submitted a routed request. It is carried in `CirceRequestMetadata.origin` and copied to the resulting presentation event. Origin-directed live delivery lets the originating interaction receive speech; the durable T3 result remains in the authoritative thread for every reconnecting client.

#### Node-qualified reference

A cross-node identifier that includes the owning node instead of relying on a locally unique ID. `ProjectRef` is `{ nodeId, projectId }`; `TaskRef` is `{ executionNodeId, threadId }`. The server validates the node portion before dispatch and rejects mismatches rather than guessing or falling back.

#### Environment registry

The client-runtime catalog and lifecycle owner for paired environments. `EnvironmentRegistry` persists connection targets and credentials, supervises connect/reconnect state, routes an operation to one environment, and removes its local cache when a saved environment is removed. It is a client-side directory, not a central Circe authority.

#### Desktop use

The in-house capability that lets a node capture its own display and inject pointer and keyboard events. A node drives only the machine it runs on; there is no cloud or virtual-desktop execution path. Agents reach it through the `t3-code` MCP toolkit and controllers reach it through the `desktopUse.*` WebSocket RPCs. See [desktop-use.md](./desktop-use.md).

#### Multi-node catalog

The client-side presentation of per-node project and provider reads. Catalog entries retain their node reference and label. Equal names are grouped as separate candidates and require clarification; provider readiness is reported from the node that owns the provider.

#### Circe controller

The provider-neutral server controller that resolves a user's requested provider, model, effort, and objective before emitting ordinary orchestration commands. It is not a provider and does not run its own manager model. See [circe-controller.md][25].

#### Semantic supervisor

The separately configured model that translates one natural-language Circe request into a schema-constrained semantic proposal. Codex Luna at low reasoning is the default. The proposal contains catalog names rather than internal IDs and has no dispatch or approval authority; the deterministic Circe validator resolves and authorizes it against live node state. See [circe-controller.md][25].

#### Presentation event

An ephemeral, origin-directed summary of a Circe-managed thread's actual final output, question, approval request, or failure. It is projected live from durable T3 events and is never replayed or acknowledged. See [circe-controller.md][25].

#### Assistant delivery mode

Controls how assistant text reaches the thread timeline. In [the contracts][1], `streaming` updates incrementally and `buffered` accumulates text. Buffered delivery is not held until the turn completes: it spills once accumulated text would exceed 24,000 characters, and flushes at approval and user-input boundaries. See [ProviderRuntimeIngestion.ts][5].

#### Checkpoint ref

The durable identifier for a filesystem checkpoint, stored as a Git ref. It is typed in [the contracts][1], constructed in [Utils.ts][22], and used by [CheckpointStore.ts][19].

#### Checkpoint diff

The patch difference between two checkpoints. Query logic lives in [CheckpointDiffQuery.ts][20], diff parsing lives in [Diffs.ts][23], and finalization is coordinated by [CheckpointReactor.ts][6].

#### Aggregate

The domain object a command or event belongs to. In [the contracts][1], that is usually `project` or `thread`. See [decider.ts][8].

#### Domain Event

A persisted fact that something already happened. In [the contracts][1], events are the source of truth, and [projector.ts][4] shows how they are applied.
Examples include `thread.created`, `thread.message-sent`, and `thread.turn-diff-completed`.

#### Projection

A read-optimized view derived from events. See [projector.ts][4], [ProjectionPipeline.ts][11], and [ProjectionSnapshotQuery.ts][10].

#### Projector

The logic that applies domain events to the read model or projection tables. See [projector.ts][4] and [ProjectionPipeline.ts][11].

#### Read model

The current materialized view of orchestration state. In [the contracts][1], it holds projects, threads, messages, activities, checkpoints, and session state. See [ProjectionSnapshotQuery.ts][10] and [OrchestrationEngine.ts][7].

#### Receipt

A typed signal emitted when an async milestone completes, such as `checkpoint.baseline.captured`, `checkpoint.diff.finalized`, or `turn.processing.quiesced`. Receipts are a test-only mechanism: the production `RuntimeReceiptBusLive` publish is a no-op and only the test layer is PubSub-backed. Do not build production behavior on them. See [RuntimeReceiptBus.ts][13] and [CheckpointReactor.ts][6].

#### Snapshot

A point-in-time view of state. The word is used in multiple layers, including orchestration, provider, and checkpointing. See [ProjectionSnapshotQuery.ts][10], [ProviderAdapter.ts][15], and [CheckpointStore.ts][19].

#### Model manifest

The per-driver list of current model slugs that decides which models land in the model picker's legacy section. Bundled at `apps/server/src/provider/model-manifest.json` and refreshed at runtime from the same file on `main`, so classification updates ship as commits instead of releases. See the [provider architecture][16] model manifest section.
