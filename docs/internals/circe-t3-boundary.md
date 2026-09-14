# Circe–T3 boundary

> For maintainers. This is the maintenance boundary for Circe changes and upstream rebases.

Circe is a product layer over the T3 harness. This boundary exists to make upstream T3 changes
safe to absorb, not to make this fork ship two independently supported products. Circe product
packages and adapters may depend on stable T3 seams; high-churn T3 internals should remain unaware
of Circe concepts wherever that materially reduces rebase conflicts.

```text
Circe UI / mesh / task desk / voice
            │
            ▼
Circe adapters and product packages
            │  public seams only
            ▼
T3 contracts, client runtime, provider/session/Git/terminal/approval services
```

## Product composition

Circe is one product composition over the T3 harness. Full, Controller, and Headless are
capability-specific Circe node presets. A release has no requirement to ship or boot a second
independently bootable pure-T3 product beside Circe.

Ordinary T3 harness behavior remains intact for normal T3 flows. The seams exist to keep the Circe
layer rebaseable onto that harness, not to create a parallel product boundary or move generic
provider, session, Git, terminal, or approval ownership into Circe.

There is no acceptance requirement to build or boot a separate upstream-branded T3 application
from this fork. The requirement is that the T3 coding-harness behavior Circe uses keeps working
after an upstream merge: providers, sessions, Git, terminals, approvals, and the detailed coding
UI. Circe is the composition we ship and test.

## The rebase invariant

T3 provider, session, Git, terminal, and approval internals do not import or name nodes, the mesh,
voice, task desk, Circe UI, or other Circe product concepts. They expose generic capabilities and
typed events. Circe supplies product policy at the composition boundary and translates those
capabilities into Circe behavior.

The reverse dependency is intentional: Circe may use a public T3 contract or service. Avoid adding
Circe callbacks, fields, imports, or special cases inside provider/session/Git/terminal/approval
implementations because those are upstream-owned, high-conflict areas. Named, shallow changes at a
composition root, contract registry, build entrypoint, or branding hook are acceptable when they
are the smallest honest integration point.

## Current ownership

- `infra/relay` (`@circe/relay`, stack `CirceRelay`, database `circerelay`) is Circe-owned, not inherited T3 infrastructure. It is the product's own control plane and its public identity is Circe's, so a rebase must not restore T3 stack, package, database, domain, or default-identity names there.
- `packages/circe-client-runtime` owns Circe client state and mesh-facing adapters. It consumes
  public RPC, authorization, connection, and environment seams; Circe-capable web and desktop
  surfaces compose it with their UI and platform layers. Mobile composes the same runtime with its
  paired-environment registry; it does not duplicate command resolution or become an execution node.
  The shared command-context helper, per-node readiness policy, and mesh catalog coverage live here
  as product-owned decisions, not as generic T3 connection behavior. The web reporter lane is a web
  composition concern over the same seams.
- `packages/circe-core` owns provider-neutral Circe decisions and vocabulary: task intent,
  request identity, project targeting, and ephemeral presentation projection. The shared activity
  classifier and pending-request identity helpers live here. It has no provider process, filesystem, Git, or
  UI authority.
- Live conversation is the only voice path. The renderer owns microphone and speaker media over
  WebRTC; the node mints the GPT-Live session with its stored key and never sends the key to a
  client. Delegated utterances reuse the ordinary submission queue. The supervisor proposes bounded
  `lookup` and `open-website` actions alongside the task actions: the model names the action, the host
  validates the place against the transcript and the target against the shared website allowlist, and
  no provider thread is created. Lookups run on the node; website launches belong to the originating
  client, while node desktop tools still act on their own node. All other work uses ordinary grounding
  and provider execution. Headless has no voice or quick-lookup capability.
- `apps/server/src/circe/` owns the server-side Circe adapters and composition. The generic
  `ProviderExecutionPolicy` service lives under the T3 provider services; the Circe implementation
  is a layer that supplies policy through that generic interface. Circe commands and task-desk
  operations use the authenticated WebSocket RPC boundary; the generic orchestration HTTP group
  owns snapshots, thread detail, and dispatch. Circe presentation is a shallow adapter over the
  live orchestration event stream: it projects terminal, approval, input, and failure events for the
  exact origin interaction without creating another durable completion or report state. The generic
  `CheckpointReactor` owns only VCS checkpoint and diff lifecycle work; it neither imports nor
  recognizes Circe activities.
- `packages/contracts` is the central wire seam. Shared contracts may mention the product boundary
  when a message is intentionally public, but the implementation behind a generic T3 contract must
  remain product-neutral.
- `ExecutionEnvironmentCapabilities.circeNode` is the intentional public Circe capability marker
  in `packages/contracts`. Live presentation is discovered through the typed WebSocket RPC group;
  there is no durable report-inbox capability or probe endpoint.
- Circe preset parsing and fields in `apps/server/src/cli/config.ts`, `apps/server/src/config.ts`,
  and `apps/server/src/environment/ServerEnvironment.ts` are intentional startup plumbing. The
  server must advertise the capability selected by a packaged node, and keeping that selection in
  the central typed configuration/environment path is smaller and more honest than a parallel
  discovery mechanism.
- These exceptions are accepted because central typed discovery and shallow composition are smaller
  and more honest than probe endpoints, extension bags, or generic callback frameworks: clients need
  a typed capability marker and packaged nodes need startup selection, while product behavior stays
  in Circe adapters and composition roots.
- `apps/server/src/persistence/Migrations.ts` is a historical shared-registry exception: Circe
  migrations 41–46 have shipped, and upstream migration 47 was appended after them. Those IDs are
  immutable; future rebases must resolve the shared migration sequence deliberately.

## Permitted seams

These are the preferred places to connect the two layers:

1. Central typed contracts in `packages/contracts`.
2. Public T3 service interfaces and adapters, such as provider execution, session, environment,
   Git, terminal, and approval capabilities.
3. Top-level product composition in the server, web, or desktop entrypoint, where a Circe layer is
   provided to a generic T3 layer or a generic result is adapted for Circe.
4. Shallow build and branding entrypoints that select the Circe product composition or package its
   capabilities for a target surface.

Outside the documented capability markers and startup plumbing, do not add Circe imports to T3
provider/session/Git/terminal/approval implementations, add Circe fields to generic domain models,
or route around the public seam with a direct reach into another layer's internals. Server, web,
desktop, build, and branding patches are acceptable only when they are shallow composition changes.
If a seam is missing, choose the option with the smaller long-term upstream conflict surface: either
a narrow generic interface that has a real T3 meaning, or one explicit Circe composition patch.
Do not invent probe endpoints, extension bags, or generic callback frameworks for a single Circe
caller.

This is a conflict-budget rule, not a purity rule. A direct edit to a stable composition, discovery,
build, or branding file can be cheaper and clearer than another package or callback. Conversely,
Circe product logic does not belong in an upstream-owned implementation merely because placing it
there saves a file today.

## Rebase and migration order

Keep upstream integration sequenced so the boundary remains reviewable:

1. Rebase or merge the T3 foundation first: contracts, generic services, orchestration, and shared
   client runtime. Preserve the documented capability markers and central discovery seams, while
   keeping Circe names out of provider/session/Git/terminal/approval implementations and unrelated
   high-churn internals.
2. Reapply or port the extracted Circe packages (`circe-client-runtime` and `circe-core`)
   as product-owned changes.
3. Reconnect `apps/server/src/circe/` through the generic T3 seams and top-level composition. Keep
   provider-specific behavior in the Circe adapter, never in the generic provider service.
4. Reconcile client and UI integrations after the contracts and server adapters agree. Do not make a
   UI conflict the reason to widen a server-internal dependency.
5. Run ownership/dependency checks and focused Circe plus upstream-harness tests before resolving
   unrelated conflicts. A rebase is complete when the dependency direction is unchanged, the
   named integration patches remain shallow, and the T3 behaviors Circe relies on still work. A
   standalone pure-T3 build from this fork is not part of that gate.

For the broader workspace map, see [workspace layout](./workspace-layout.md). The existing request
and report flows are described in [Circe controller](./circe-controller.md).
