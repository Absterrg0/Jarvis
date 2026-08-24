# Jarvis–T3 boundary

> For maintainers. This is the dependency-direction contract for Jarvis changes and upstream
> rebases.

Jarvis is a product layer over the T3 harness. Jarvis product packages and adapters may depend on
public T3 seams; T3 infrastructure must remain unaware of Jarvis concepts.

```text
Jarvis UI / mesh / task desk / voice
            │
            ▼
Jarvis adapters and product packages
            │  public seams only
            ▼
T3 contracts, client runtime, provider/session/Git/terminal/approval services
```

## Product composition

Jarvis is one product composition over the T3 harness. Full, Controller, Headless, and the
optional standalone Companion are capability-specific Jarvis surfaces and runtimes; a release has
no requirement to ship or boot a second independently bootable pure-T3 product beside Jarvis.
Companion is a separately packaged Jarvis speech/control surface, not a second T3 product or an
execution host.

Ordinary T3 harness behavior remains intact for normal T3 flows. The seams exist to keep the Jarvis
layer rebaseable onto that harness, not to create a parallel product boundary or move generic
provider, session, Git, terminal, or approval ownership into Jarvis.

## The invariant

T3 provider, session, Git, terminal, and approval internals do not import or name nodes, the mesh,
voice, task desk, Jarvis UI, or other Jarvis product concepts. They expose generic capabilities and
typed events. Jarvis supplies product policy at the composition boundary and translates those
capabilities into Jarvis behavior.

The reverse dependency is intentional: Jarvis may use a public T3 contract or service, but a generic
T3 service must not acquire a Jarvis callback, field, import, or special case to serve it.

## Current ownership

- `packages/jarvis-client-runtime` owns Jarvis client state and mesh-facing adapters. It consumes
  public RPC, authorization, connection, and environment seams; Jarvis-capable web and desktop
  surfaces compose it with their UI and platform layers. Mobile does not currently consume this
  Jarvis runtime.
- `packages/jarvis-core` owns provider-neutral Jarvis decisions and vocabulary: task intent,
  request identity, project targeting, and reports. It has no provider process, filesystem, Git, or
  UI authority.
- `packages/jarvis-native-voice` and `packages/jarvis-native-microphone` own native speech and
  microphone runtime packaging. They are product capabilities, not dependencies of generic T3
  provider or terminal code.
- `apps/server/src/jarvis/` owns the server-side Jarvis adapters and composition. The generic
  `ProviderExecutionPolicy` service lives under the T3 provider services; the Jarvis implementation
  is a layer that supplies policy through that generic interface. Jarvis HTTP endpoints are a
  separate `EnvironmentJarvisHttpApi` group implemented by `apps/server/src/jarvis/http.ts`; the
  generic orchestration HTTP group owns only snapshots, thread detail, and dispatch. Jarvis result
  delivery is likewise owned by `JarvisCompletionReactor`: it consumes generic orchestration events
  through the public engine/projection seams and emits Jarvis completion activity. The generic
  `CheckpointReactor` owns only VCS checkpoint and diff lifecycle work; it neither imports nor
  recognizes Jarvis activities.
- `packages/contracts` is the central wire seam. Shared contracts may mention the product boundary
  when a message is intentionally public, but the implementation behind a generic T3 contract must
  remain product-neutral.
- `apps/server/src/persistence/Migrations.ts` is a historical shared-registry exception: Jarvis
  migrations 41–46 have shipped, and upstream migration 47 was appended after them. Those IDs are
  immutable; future rebases must resolve the shared migration sequence deliberately.

## Permitted seams

Only these seams may temporarily connect the two layers:

1. Central typed contracts in `packages/contracts`.
2. Public T3 service interfaces and adapters, such as provider execution, session, environment,
   Git, terminal, and approval capabilities.
3. Top-level product composition in the server, web, or desktop entrypoint, where a Jarvis layer is
   provided to a generic T3 layer or a generic result is adapted for Jarvis.

Do not add Jarvis imports to T3 provider/session/Git/terminal/approval implementations, add Jarvis
fields to generic domain models, or route around the public seam with a direct reach into another
layer's internals. If a seam is missing, define the smallest generic interface first.

## Rebase and migration order

Keep upstream integration sequenced so the boundary remains reviewable:

1. Rebase or merge the T3 foundation first: contracts, generic services, orchestration, and shared
   client runtime. Resolve conflicts in T3 files without introducing Jarvis names.
2. Reapply or port the extracted Jarvis packages (`jarvis-client-runtime`, `jarvis-core`, and the
   native voice/microphone packages) as product-owned changes.
3. Reconnect `apps/server/src/jarvis/` through the generic T3 seams and top-level composition. Keep
   provider-specific behavior in the Jarvis adapter, never in the generic provider service.
4. Reconcile client and UI integrations after the contracts and server adapters agree. Do not make a
   UI conflict the reason to widen a server-internal dependency.
5. Run ownership/dependency checks and focused tests before resolving unrelated conflicts. A rebase
   is complete only when the dependency direction is unchanged and the generic T3 layer still has
   no Jarvis vocabulary.

For the broader workspace map, see [workspace layout](./workspace-layout.md). The existing request
and report flows are described in [Jarvis manager](./jarvis-manager.md).
