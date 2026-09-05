import {
  EnvironmentId,
  EnvironmentAuthorizationError,
  JarvisExecutionError,
  jarvisNodeCapabilitiesForPreset,
  JarvisProjectRef,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
  type JarvisExecutionResult,
  type JarvisNodeCapabilities,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { RpcClientError } from "effect/unstable/rpc";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  EnvironmentNotRegisteredError,
  EnvironmentRegistry,
  type ConnectionCatalogEntry,
  type PreparedConnection,
  type NetworkStatus,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import * as EnvironmentSupervisor from "@t3tools/client-runtime/connection";
import {
  EnvironmentRpcUnavailableError,
  type WsRpcProtocolClient,
  type RpcSession,
} from "@t3tools/client-runtime/rpc";
import {
  JarvisMeshNodeUnavailableError,
  JARVIS_MESH_REFRESH_CONCURRENCY,
  make as makeJarvisMesh,
  resolveJarvisMeshInstructionProject,
} from "./mesh.ts";

const NODE_DESKTOP = EnvironmentId.make("node-desktop");
const NODE_LAPTOP = EnvironmentId.make("node-laptop");

function provider(instanceId: string, overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    displayName: instanceId === "codex" ? "Codex" : instanceId,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-21T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

function vocabulary(projectId: string, title: string, alias?: string) {
  return {
    projectId: ProjectId.make(projectId),
    title,
    workspaceRoot: `/work/${projectId}`,
    repositoryNames: [title.toLowerCase()],
    aliases: alias === undefined ? [] : [alias],
    aliasDetails: alias === undefined ? [] : [{ alias, kind: "user-defined" as const }],
  };
}

interface FakeNode {
  readonly target: PrimaryConnectionTarget;
  readonly supervisor: EnvironmentSupervisor.EnvironmentSupervisor["Service"];
  readonly vocabulary: ReturnType<typeof vocabulary>[];
  readonly providers: ServerProvider[];
  readonly catalogFailure?: boolean;
  readonly jarvisNodeCapabilities: JarvisNodeCapabilities;
}

type CatalogErrorKindForTest = "unreachable" | "authentication" | "incompatible" | "service";

type CatalogErrorForTest =
  | EnvironmentRpcUnavailableError
  | EnvironmentAuthorizationError
  | RpcClientError.RpcClientError
  | Error;

function catalogErrorForTest(
  kind: CatalogErrorKindForTest,
  nodeId: EnvironmentId,
): CatalogErrorForTest {
  switch (kind) {
    case "unreachable":
      return new EnvironmentRpcUnavailableError({
        environmentId: nodeId,
        message: "Node is not connected.",
      });
    case "authentication":
      return new EnvironmentAuthorizationError({
        message: "The token is missing the required scope.",
        requiredScope: "orchestration:read",
      });
    case "incompatible":
      return new RpcClientError.RpcClientError({
        reason: new RpcClientError.RpcClientDefect({
          message: "incompatible Jarvis catalog response",
          cause: new Error("schema mismatch"),
        }),
      });
    case "service":
      return new Error("catalog service failed");
  }
}

const makeNode = Effect.fn("JarvisMeshTest.makeNode")(function* (input: {
  readonly nodeId: EnvironmentId;
  readonly label: string;
  readonly liveLabel?: string;
  readonly vocabulary: ReturnType<typeof vocabulary>[];
  readonly providers: ServerProvider[];
  readonly phase?: "connected" | "offline";
  readonly catalogFailure?: boolean;
  readonly configFailure?: boolean;
  readonly catalogErrorKind?: CatalogErrorKindForTest;
  readonly onVocabularyRead?: () => Effect.Effect<void>;
  readonly legacyDescriptor?: boolean;
  readonly jarvisNodeCapabilities?: JarvisNodeCapabilities;
  readonly supervisorInstanceId?: string;
  /** Omit settings from the config response (predates the supervisor selection). */
  readonly omitSettings?: boolean;
  readonly executeResult?: JarvisExecutionResult;
  readonly executeFailure?: JarvisExecutionError;
}) {
  const target = new PrimaryConnectionTarget({
    environmentId: input.nodeId,
    label: input.label,
    httpBaseUrl: `http://${input.nodeId}.test`,
    wsBaseUrl: `ws://${input.nodeId}.test`,
  });
  const calls: Array<{ readonly method: string; readonly input: unknown }> = [];
  const client = {
    [WS_METHODS.jarvisGetProjectVocabulary]: (requestInput: unknown) =>
      Effect.gen(function* () {
        calls.push({ method: WS_METHODS.jarvisGetProjectVocabulary, input: requestInput });
        if (input.onVocabularyRead !== undefined) yield* input.onVocabularyRead();
        if (input.catalogErrorKind !== undefined) {
          return yield* Effect.fail(catalogErrorForTest(input.catalogErrorKind, input.nodeId));
        }
        if (input.catalogFailure === true) {
          return yield* new EnvironmentNotRegisteredError({ environmentId: input.nodeId });
        }
        return input.vocabulary;
      }),
    [WS_METHODS.serverGetConfig]: (requestInput: unknown) =>
      Effect.gen(function* () {
        calls.push({ method: WS_METHODS.serverGetConfig, input: requestInput });
        if (input.configFailure === true) {
          return yield* new EnvironmentNotRegisteredError({ environmentId: input.nodeId });
        }
        return {
          providers: input.providers,
          ...(input.omitSettings === true
            ? {}
            : {
                settings: {
                  jarvisSupervisorModelSelection: {
                    instanceId: input.supervisorInstanceId ?? "codex",
                  },
                },
              }),
          ...(input.legacyDescriptor
            ? {}
            : {
                environment: {
                  label: input.liveLabel ?? input.label,
                  capabilities: {
                    jarvisNode:
                      input.jarvisNodeCapabilities ?? jarvisNodeCapabilitiesForPreset("full"),
                  },
                },
              }),
        };
      }),
    [WS_METHODS.jarvisExecute]: (requestInput: unknown) =>
      Effect.gen(function* () {
        calls.push({ method: WS_METHODS.jarvisExecute, input: requestInput });
        if (input.executeFailure !== undefined) {
          return yield* input.executeFailure;
        }
        return (
          input.executeResult ?? {
            status: "started" as const,
            threadId: ThreadId.make("thread-routed"),
            objective: "Run the routed task.",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5",
            },
          }
        );
      }),
    [WS_METHODS.jarvisGetTaskDesk]: (requestInput: unknown) =>
      Effect.sync(() => {
        calls.push({ method: WS_METHODS.jarvisGetTaskDesk, input: requestInput });
        return {
          focusedTask: null,
          recentTasks: [],
          pendingInteraction: null,
          updatedAt: null,
        };
      }),
    [WS_METHODS.jarvisFocusTask]: (requestInput: unknown) =>
      Effect.sync(() => {
        calls.push({ method: WS_METHODS.jarvisFocusTask, input: requestInput });
        return {
          focusedTask: null,
          recentTasks: [],
          pendingInteraction: null,
          updatedAt: null,
        };
      }),
    [WS_METHODS.jarvisManageProjectAlias]: (requestInput: unknown) =>
      Effect.sync(() => {
        calls.push({ method: WS_METHODS.jarvisManageProjectAlias, input: requestInput });
        return { changed: true };
      }),
    [WS_METHODS.jarvisVoiceTranscribe]: (requestInput: unknown) =>
      Effect.sync(() => {
        calls.push({ method: WS_METHODS.jarvisVoiceTranscribe, input: requestInput });
        return { text: "run on the desktop" };
      }),
    [WS_METHODS.jarvisVoiceSynthesize]: (requestInput: unknown) =>
      Effect.sync(() => {
        calls.push({ method: WS_METHODS.jarvisVoiceSynthesize, input: requestInput });
        return { wavBase64: "AAAA" };
      }),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: Effect.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const state = yield* SubscriptionRef.make<SupervisorConnectionState>({
    ...AVAILABLE_CONNECTION_STATE,
    desired: true,
    phase: input.phase ?? "connected",
    stage: null,
  });
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target,
    state,
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  return {
    target,
    supervisor,
    vocabulary: input.vocabulary,
    providers: input.providers,
    calls,
    jarvisNodeCapabilities: input.jarvisNodeCapabilities ?? jarvisNodeCapabilitiesForPreset("full"),
  };
});

const makeMesh = Effect.fn("JarvisMeshTest.makeMesh")(function* (nodes: ReadonlyArray<FakeNode>) {
  const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
    new Map(
      nodes.map((node) => [
        node.target.environmentId,
        { target: node.target, profile: Option.none() },
      ]),
    ),
  );
  const registry = EnvironmentRegistry.of({
    entries,
    networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
    start: Effect.void,
    register: () => Effect.void,
    registerPlatform: () => Effect.void,
    reconcilePlatform: () => Effect.void,
    remove: () => Effect.void,
    removeRelayEnvironments: () => Effect.void,
    retryNow: () => Effect.void,
    state: (environmentId) => {
      const node = nodes.find((candidate) => candidate.target.environmentId === environmentId);
      return node === undefined
        ? Effect.fail(new EnvironmentNotRegisteredError({ environmentId }))
        : SubscriptionRef.get(node.supervisor.state);
    },
    stateChanges: () => {
      throw new Error("stateChanges is not used by JarvisMesh tests");
    },
    run: (environmentId, effect) => {
      const node = nodes.find((candidate) => candidate.target.environmentId === environmentId);
      if (node === undefined) {
        return Effect.fail(new EnvironmentNotRegisteredError({ environmentId }));
      }
      return Effect.provideService(
        effect,
        EnvironmentSupervisor.EnvironmentSupervisor,
        node.supervisor,
      );
    },
    runStream: () => {
      throw new Error("runStream is not used by JarvisMesh tests");
    },
    followStream: () => {
      throw new Error("followStream is not used by JarvisMesh tests");
    },
  });
  const mesh = yield* makeJarvisMesh.pipe(Effect.provideService(EnvironmentRegistry, registry));
  return { mesh, nodes };
});

describe("Jarvis mesh", () => {
  it.effect(
    "routes a Laptop-origin Rivvl task to Desktop and keeps its follow-up on that node/thread",
    () =>
      Effect.gen(function* () {
        const desktop = yield* makeNode({
          nodeId: NODE_DESKTOP,
          label: "Desktop",
          vocabulary: [vocabulary("rivvl-desktop", "Rivvl", "ripple")],
          providers: [provider("codex")],
        });
        const laptop = yield* makeNode({
          nodeId: NODE_LAPTOP,
          label: "Laptop",
          vocabulary: [vocabulary("jarvis-laptop", "Jarvis")],
          providers: [provider("codex")],
        });
        const { mesh } = yield* makeMesh([desktop, laptop]);
        const catalog = yield* mesh.refresh;
        const resolution = yield* mesh.resolveProject("ripple");

        expect(resolution).toMatchObject({
          status: "resolved",
          project: {
            ref: { nodeId: NODE_DESKTOP, projectId: "rivvl-desktop" },
            nodeLabel: "Desktop",
          },
        });
        expect(
          catalog.providers.find(
            ({ nodeId, snapshot }) => nodeId === NODE_DESKTOP && snapshot.instanceId === "codex",
          ),
        ).toMatchObject({ nodeLabel: "Desktop", available: true });

        if (resolution.status !== "resolved") return;
        const origin = { originNodeId: NODE_LAPTOP, originInteractionId: "laptop-capture-1" };
        const requestMetadata = { requestId: "laptop-request-1", origin };
        const first = yield* mesh.execute({
          kind: "control",
          projectRef: resolution.project.ref,
          requestMetadata,
          utterance: "Review Rivvl.",
        });
        expect(first).toMatchObject({ status: "started", threadId: "thread-routed" });

        if (first.status !== "started") return;
        yield* mesh.execute({
          kind: "control",
          projectRef: resolution.project.ref,
          requestMetadata: { requestId: "laptop-follow-up-1", origin },
          contextThreadId: first.threadId,
          continueContext: true,
          utterance: "Now summarize the findings.",
        });

        expect(desktop.calls.filter(({ method }) => method === WS_METHODS.jarvisExecute)).toEqual([
          {
            method: WS_METHODS.jarvisExecute,
            input: {
              kind: "control",
              projectId: "rivvl-desktop",
              projectRef: resolution.project.ref,
              requestMetadata,
              utterance: "Review Rivvl.",
            },
          },
          {
            method: WS_METHODS.jarvisExecute,
            input: {
              kind: "control",
              projectId: "rivvl-desktop",
              projectRef: resolution.project.ref,
              requestMetadata: { requestId: "laptop-follow-up-1", origin },
              contextThreadId: first.threadId,
              continueContext: true,
              utterance: "Now summarize the findings.",
            },
          },
        ]);
        expect(laptop.calls.filter(({ method }) => method === WS_METHODS.jarvisExecute)).toEqual(
          [],
        );
      }),
  );

  it.effect("routes a Desktop-origin Jarvis task to Laptop", () =>
    Effect.gen(function* () {
      const desktop = yield* makeNode({
        nodeId: NODE_DESKTOP,
        label: "Desktop",
        vocabulary: [vocabulary("rivvl-desktop", "Rivvl")],
        providers: [provider("codex")],
      });
      const laptop = yield* makeNode({
        nodeId: NODE_LAPTOP,
        label: "Laptop",
        vocabulary: [vocabulary("jarvis-laptop", "Jarvis")],
        providers: [provider("codex")],
      });
      const { mesh } = yield* makeMesh([desktop, laptop]);
      yield* mesh.refresh;
      const resolution = yield* mesh.resolveProject("Jarvis");

      expect(resolution).toMatchObject({
        status: "resolved",
        project: {
          ref: { nodeId: NODE_LAPTOP, projectId: "jarvis-laptop" },
          nodeLabel: "Laptop",
        },
      });
      if (resolution.status !== "resolved") return;

      const requestMetadata = {
        requestId: "desktop-request-1",
        origin: { originNodeId: NODE_DESKTOP, originInteractionId: "desktop-capture-1" },
      };
      const result = yield* mesh.execute({
        kind: "control",
        projectRef: resolution.project.ref,
        requestMetadata,
        utterance: "Fix the voice overlay.",
      });

      expect(result).toMatchObject({ status: "started", threadId: "thread-routed" });
      expect(laptop.calls.filter(({ method }) => method === WS_METHODS.jarvisExecute)).toEqual([
        {
          method: WS_METHODS.jarvisExecute,
          input: {
            kind: "control",
            projectId: "jarvis-laptop",
            projectRef: resolution.project.ref,
            requestMetadata,
            utterance: "Fix the voice overlay.",
          },
        },
      ]);
      expect(desktop.calls.filter(({ method }) => method === WS_METHODS.jarvisExecute)).toEqual([]);
    }),
  );

  it.effect("contrasts local and remote execution while preserving the report origin", () =>
    Effect.gen(function* () {
      const desktop = yield* makeNode({
        nodeId: NODE_DESKTOP,
        label: "Desktop",
        vocabulary: [vocabulary("rivvl-desktop", "Rivvl")],
        providers: [provider("codex")],
      });
      const laptop = yield* makeNode({
        nodeId: NODE_LAPTOP,
        label: "Laptop",
        vocabulary: [vocabulary("jarvis-laptop", "Jarvis")],
        providers: [provider("codex")],
      });
      const { mesh } = yield* makeMesh([desktop, laptop]);
      yield* mesh.refresh;

      const localRequestMetadata = {
        requestId: "laptop-local-request",
        origin: { originNodeId: NODE_LAPTOP, originInteractionId: "laptop-local-capture" },
      };
      const localProjectRef = { nodeId: NODE_LAPTOP, projectId: ProjectId.make("jarvis-laptop") };
      const local = yield* mesh.execute({
        kind: "control",
        projectRef: localProjectRef,
        requestMetadata: localRequestMetadata,
        utterance: "Fix the local Jarvis task.",
      });
      expect(local).toMatchObject({ status: "started", threadId: "thread-routed" });

      const remoteRequestMetadata = {
        requestId: "laptop-remote-request",
        origin: { originNodeId: NODE_LAPTOP, originInteractionId: "laptop-remote-capture" },
      };
      const remoteProjectRef = { nodeId: NODE_DESKTOP, projectId: ProjectId.make("rivvl-desktop") };
      const remote = yield* mesh.execute({
        kind: "control",
        projectRef: remoteProjectRef,
        requestMetadata: remoteRequestMetadata,
        utterance: "Fix the remote Rivvl task.",
      });
      expect(remote).toMatchObject({ status: "started", threadId: "thread-routed" });

      expect(laptop.calls.filter(({ method }) => method === WS_METHODS.jarvisExecute)).toEqual([
        {
          method: WS_METHODS.jarvisExecute,
          input: {
            kind: "control",
            projectId: "jarvis-laptop",
            projectRef: localProjectRef,
            requestMetadata: localRequestMetadata,
            utterance: "Fix the local Jarvis task.",
          },
        },
      ]);
      expect(desktop.calls.filter(({ method }) => method === WS_METHODS.jarvisExecute)).toEqual([
        {
          method: WS_METHODS.jarvisExecute,
          input: {
            kind: "control",
            projectId: "rivvl-desktop",
            projectRef: remoteProjectRef,
            requestMetadata: remoteRequestMetadata,
            utterance: "Fix the remote Rivvl task.",
          },
        },
      ]);
    }),
  );

  it.effect("clarifies duplicate project names with node labels and does not dispatch", () =>
    Effect.gen(function* () {
      const desktop = yield* makeNode({
        nodeId: NODE_DESKTOP,
        label: "Desktop",
        vocabulary: [vocabulary("rivvl-desktop", "Rivvl")],
        providers: [provider("codex")],
      });
      const laptop = yield* makeNode({
        nodeId: NODE_LAPTOP,
        label: "Laptop",
        vocabulary: [vocabulary("rivvl-laptop", "Rivvl")],
        providers: [provider("codex")],
      });
      const { mesh } = yield* makeMesh([desktop, laptop]);
      yield* mesh.refresh;

      const resolution = yield* mesh.resolveProject("Rivvl");

      expect(resolution).toMatchObject({
        status: "needs-clarification",
        candidates: [
          { label: "Rivvl — Desktop", ref: { nodeId: NODE_DESKTOP } },
          { label: "Rivvl — Laptop", ref: { nodeId: NODE_LAPTOP } },
        ],
      });
      expect(desktop.calls.filter(({ method }) => method === WS_METHODS.jarvisExecute)).toEqual([]);
      expect(laptop.calls.filter(({ method }) => method === WS_METHODS.jarvisExecute)).toEqual([]);
    }),
  );

  it.effect("returns the selected node's provider error without substituting another node", () =>
    Effect.gen(function* () {
      const desktop = yield* makeNode({
        nodeId: NODE_DESKTOP,
        label: "Desktop",
        vocabulary: [vocabulary("rivvl-desktop", "Rivvl")],
        providers: [provider("codex", { enabled: false, status: "disabled" })],
        executeResult: {
          status: "needs-input",
          reason: "provider-unavailable",
          prompt: "Codex is not ready on Desktop. Install, enable, and authenticate it first.",
          choices: [],
        },
      });
      const laptop = yield* makeNode({
        nodeId: NODE_LAPTOP,
        label: "Laptop",
        vocabulary: [vocabulary("jarvis-laptop", "Jarvis")],
        providers: [provider("codex")],
      });
      const { mesh } = yield* makeMesh([desktop, laptop]);
      const catalog = yield* mesh.refresh;
      const resolution = yield* mesh.resolveProject("Rivvl");

      expect(catalog.providers).toContainEqual(
        expect.objectContaining({
          nodeId: NODE_DESKTOP,
          nodeLabel: "Desktop",
          available: false,
          snapshot: expect.objectContaining({ instanceId: "codex" }),
        }),
      );
      expect(resolution).toMatchObject({ status: "resolved", project: { nodeId: NODE_DESKTOP } });
      if (resolution.status !== "resolved") return;

      const result = yield* mesh.execute({
        kind: "control",
        projectRef: resolution.project.ref,
        requestMetadata: { requestId: "desktop-provider-unavailable" },
        utterance: "Use Codex to review Rivvl.",
      });

      expect(result).toEqual({
        status: "needs-input",
        reason: "provider-unavailable",
        prompt: "Codex is not ready on Desktop. Install, enable, and authenticate it first.",
        choices: [],
      });
      expect(
        desktop.calls.filter(({ method }) => method === WS_METHODS.jarvisExecute),
      ).toHaveLength(1);
      expect(laptop.calls.filter(({ method }) => method === WS_METHODS.jarvisExecute)).toEqual([]);
    }),
  );

  it.effect("aggregates node-qualified project and provider catalogs", () =>
    Effect.gen(function* () {
      const desktop = yield* makeNode({
        nodeId: NODE_DESKTOP,
        label: "Desktop",
        vocabulary: [vocabulary("rivvl-desktop", "Rivvl", "ripple")],
        providers: [provider("codex")],
      });
      const laptop = yield* makeNode({
        nodeId: NODE_LAPTOP,
        label: "Laptop",
        vocabulary: [vocabulary("rivvl-laptop", "Rivvl")],
        providers: [provider("codex", { status: "disabled", enabled: false })],
      });
      const { mesh } = yield* makeMesh([desktop, laptop]);

      const catalog = yield* mesh.refresh;

      expect(
        catalog.nodes.map(({ nodeId, label, reachability }) => ({ nodeId, label, reachability })),
      ).toEqual([
        { nodeId: NODE_DESKTOP, label: "Desktop", reachability: "online" },
        { nodeId: NODE_LAPTOP, label: "Laptop", reachability: "online" },
      ]);
      expect(
        catalog.projects.map(({ ref, nodeLabel, title }) => ({ ref, nodeLabel, title })),
      ).toEqual([
        {
          ref: { nodeId: NODE_DESKTOP, projectId: "rivvl-desktop" },
          nodeLabel: "Desktop",
          title: "Rivvl",
        },
        {
          ref: { nodeId: NODE_LAPTOP, projectId: "rivvl-laptop" },
          nodeLabel: "Laptop",
          title: "Rivvl",
        },
      ]);
      expect(
        catalog.providers.map(({ nodeId, snapshot }) => ({
          nodeId,
          instanceId: snapshot.instanceId,
        })),
      ).toEqual([
        { nodeId: NODE_DESKTOP, instanceId: "codex" },
        { nodeId: NODE_LAPTOP, instanceId: "codex" },
      ]);
      expect(catalog.providers[1]?.available).toBe(false);
    }),
  );

  it.effect("advertises conversation readiness from the node's own supervisor instance", () =>
    Effect.gen(function* () {
      const desktop = yield* makeNode({
        nodeId: NODE_DESKTOP,
        label: "Desktop",
        vocabulary: [vocabulary("rivvl-desktop", "Rivvl")],
        providers: [provider("codex")],
      });
      const laptop = yield* makeNode({
        nodeId: NODE_LAPTOP,
        label: "Laptop",
        vocabulary: [vocabulary("jarvis-laptop", "Jarvis")],
        // Supervisor points at codex, but only fable is available here.
        providers: [provider("fable")],
      });
      const vps = yield* makeNode({
        nodeId: EnvironmentId.make("node-vps"),
        label: "VPS",
        vocabulary: [vocabulary("ops-vps", "Ops")],
        providers: [provider("codex", { status: "disabled", enabled: false })],
      });
      const { mesh } = yield* makeMesh([desktop, laptop, vps]);

      const catalog = yield* mesh.refresh;
      const ready = (nodeId: EnvironmentId) =>
        catalog.nodes.find((node) => node.nodeId === nodeId)?.conversationReady;

      // Desktop: supervisor instance available. Laptop: a provider is
      // available, but not the configured supervisor instance. VPS: the
      // supervisor instance exists but is disabled.
      expect(ready(NODE_DESKTOP)).toBe(true);
      expect(ready(NODE_LAPTOP)).toBe(false);
      expect(ready(EnvironmentId.make("node-vps"))).toBe(false);
    }),
  );

  it.effect("leaves conversation readiness unknown without settings data", () =>
    Effect.gen(function* () {
      const desktop = yield* makeNode({
        nodeId: NODE_DESKTOP,
        label: "Desktop",
        vocabulary: [vocabulary("rivvl-desktop", "Rivvl")],
        providers: [provider("codex")],
        omitSettings: true,
      });
      const { mesh } = yield* makeMesh([desktop]);
      const catalog = yield* mesh.refresh;
      // No successful read ever confirmed the supervisor: unknown, so the
      // normal execute fallback stays eligible instead of refusing.
      expect(catalog.nodes[0]?.conversationReady).toBeUndefined();
    }),
  );

  it.effect("refuses conversation on a known-unready node instead of failing remotely", () =>
    Effect.gen(function* () {
      const desktop = yield* makeNode({
        nodeId: NODE_DESKTOP,
        label: "Desktop",
        vocabulary: [vocabulary("rivvl-desktop", "Rivvl")],
        providers: [provider("codex")],
      });
      const laptop = yield* makeNode({
        nodeId: NODE_LAPTOP,
        label: "Laptop",
        vocabulary: [vocabulary("jarvis-laptop", "Jarvis")],
        providers: [provider("codex", { status: "disabled", enabled: false })],
      });
      const { mesh } = yield* makeMesh([desktop, laptop]);
      yield* mesh.refresh;

      const refused = yield* mesh
        .converse({ nodeId: NODE_LAPTOP, utterance: "What is new today?" })
        .pipe(Effect.flip);
      expect(refused._tag).toBe("JarvisMeshConversationUnavailableError");

      const answered = yield* mesh.converse({
        nodeId: NODE_DESKTOP,
        utterance: "What is new today?",
      });
      expect(answered.status).not.toBe("needs-input");
    }),
  );

  it.effect("resolves a unique alias and grounds duplicate exact names with node labels", () =>
    Effect.gen(function* () {
      const desktop = yield* makeNode({
        nodeId: NODE_DESKTOP,
        label: "Desktop",
        vocabulary: [vocabulary("rivvl-desktop", "Rivvl", "ripple")],
        providers: [provider("codex")],
      });
      const laptop = yield* makeNode({
        nodeId: NODE_LAPTOP,
        label: "Laptop",
        vocabulary: [vocabulary("rivvl-laptop", "Rivvl")],
        providers: [provider("codex")],
      });
      const { mesh } = yield* makeMesh([desktop, laptop]);
      yield* mesh.refresh;

      expect(yield* mesh.resolveProject("ripple")).toEqual({
        status: "resolved",
        project: expect.objectContaining({
          ref: { nodeId: NODE_DESKTOP, projectId: "rivvl-desktop" },
        }),
      });
      expect(yield* mesh.resolveProject("Rivvl")).toMatchObject({
        status: "needs-clarification",
        candidates: [
          { label: "Rivvl — Desktop", nodeLabel: "Desktop" },
          { label: "Rivvl — Laptop", nodeLabel: "Laptop" },
        ],
      });
    }),
  );

  it("resolves an explicit project phrase without changing the original instruction", () => {
    const desktopProject = {
      projectId: ProjectId.make("rivvl-desktop"),
      nodeId: NODE_DESKTOP,
      title: "Rivvl",
      workspaceRoot: "/work/rivvl-desktop",
      repositoryNames: ["rivvl"],
      aliases: [],
      aliasDetails: [],
      ref: { nodeId: NODE_DESKTOP, projectId: ProjectId.make("rivvl-desktop") },
      nodeLabel: "Desktop",
    };
    const laptopProject = {
      ...desktopProject,
      ref: { nodeId: NODE_LAPTOP, projectId: ProjectId.make("rivvl-laptop") },
      nodeId: NODE_LAPTOP,
      projectId: ProjectId.make("rivvl-laptop"),
      nodeLabel: "Laptop",
    };
    const catalog = {
      nodes: [],
      projects: [desktopProject, laptopProject],
      providers: [],
    };

    expect(
      resolveJarvisMeshInstructionProject(catalog, "In Rivvl, review the current changes."),
    ).toMatchObject({
      projectQuery: "Rivvl",
      resolution: {
        status: "needs-clarification",
        candidates: [{ label: "Rivvl — Desktop" }, { label: "Rivvl — Laptop" }],
      },
    });
  });

  it("resolves explicit saved aliases and clarifies alias collisions by node", () => {
    const desktopProject = {
      projectId: ProjectId.make("rivvl-desktop"),
      nodeId: NODE_DESKTOP,
      title: "Rivvl",
      workspaceRoot: "/work/rivvl-desktop",
      repositoryNames: ["rivvl"],
      aliases: ["ripple"],
      aliasDetails: [{ alias: "ripple", kind: "user-defined" as const }],
      ref: { nodeId: NODE_DESKTOP, projectId: ProjectId.make("rivvl-desktop") },
      nodeLabel: "Desktop",
    };
    const laptopProject = {
      ...desktopProject,
      ref: { nodeId: NODE_LAPTOP, projectId: ProjectId.make("rivvl-laptop") },
      nodeId: NODE_LAPTOP,
      projectId: ProjectId.make("rivvl-laptop"),
      nodeLabel: "Laptop",
    };
    const catalog = {
      nodes: [],
      projects: [desktopProject, laptopProject],
      providers: [],
    };

    expect(
      resolveJarvisMeshInstructionProject(
        { ...catalog, projects: [desktopProject] },
        "In ripple, review the changes.",
      ),
    ).toMatchObject({
      projectQuery: "ripple",
      resolution: {
        status: "resolved",
        project: { ref: { nodeId: NODE_DESKTOP, projectId: "rivvl-desktop" } },
      },
    });

    expect(
      resolveJarvisMeshInstructionProject(catalog, "In ripple, review the changes."),
    ).toMatchObject({
      projectQuery: "ripple",
      resolution: {
        status: "needs-clarification",
        candidates: [{ label: "Rivvl — Desktop" }, { label: "Rivvl — Laptop" }],
      },
    });
  });

  it.effect("bounds concurrent node catalog refreshes and preserves partial results", () =>
    Effect.gen(function* () {
      const activeReads = yield* Ref.make(0);
      const maxActiveReads = yield* Ref.make(0);
      const reachedLimit = yield* Deferred.make<void>();
      const releaseReads = yield* Deferred.make<void>();
      const nodes = yield* Effect.forEach(
        Array.from({ length: JARVIS_MESH_REFRESH_CONCURRENCY * 2 }, (_, index) => index),
        (index) =>
          makeNode({
            nodeId: EnvironmentId.make(`refresh-node-${index}`),
            label: `Refresh ${index}`,
            vocabulary: [vocabulary(`refresh-project-${index}`, `Refresh ${index}`)],
            providers: [provider("codex")],
            onVocabularyRead: () =>
              Effect.gen(function* () {
                const active = yield* Ref.updateAndGet(activeReads, (count) => count + 1);
                yield* Ref.update(maxActiveReads, (maximum) => Math.max(maximum, active));
                if (active === JARVIS_MESH_REFRESH_CONCURRENCY) {
                  yield* Deferred.succeed(reachedLimit, undefined);
                }
                yield* Deferred.await(releaseReads);
                yield* Ref.update(activeReads, (count) => count - 1);
              }),
          }),
        { concurrency: "unbounded" },
      );
      const { mesh } = yield* makeMesh(nodes);
      const refreshFiber = yield* Effect.forkChild(mesh.refresh);

      yield* Deferred.await(reachedLimit);
      yield* Deferred.succeed(releaseReads, undefined);
      const catalog = yield* Fiber.join(refreshFiber);

      expect(yield* Ref.get(maxActiveReads)).toBe(JARVIS_MESH_REFRESH_CONCURRENCY);
      expect(catalog.projects).toHaveLength(nodes.length);
      expect(catalog.providers).toHaveLength(nodes.length);
    }),
  );

  it.effect("classifies catalog failures and keeps reachability truthful", () =>
    Effect.gen(function* () {
      const healthy = yield* makeNode({
        nodeId: NODE_DESKTOP,
        label: "Healthy",
        vocabulary: [vocabulary("healthy-project", "Healthy")],
        providers: [provider("codex")],
      });
      const unreachable = yield* makeNode({
        nodeId: EnvironmentId.make("unreachable-node"),
        label: "Unreachable",
        vocabulary: [vocabulary("unreachable-project", "Unreachable")],
        providers: [provider("codex")],
        catalogErrorKind: "unreachable",
      });
      const authentication = yield* makeNode({
        nodeId: EnvironmentId.make("authentication-node"),
        label: "Authentication",
        vocabulary: [vocabulary("authentication-project", "Authentication")],
        providers: [provider("codex")],
        catalogErrorKind: "authentication",
      });
      const incompatible = yield* makeNode({
        nodeId: EnvironmentId.make("incompatible-node"),
        label: "Incompatible",
        vocabulary: [vocabulary("incompatible-project", "Incompatible")],
        providers: [provider("codex")],
        catalogErrorKind: "incompatible",
      });
      const service = yield* makeNode({
        nodeId: EnvironmentId.make("service-node"),
        label: "Service",
        vocabulary: [vocabulary("service-project", "Service")],
        providers: [provider("codex")],
        catalogErrorKind: "service",
      });
      const { mesh } = yield* makeMesh([
        healthy,
        unreachable,
        authentication,
        incompatible,
        service,
      ]);

      const catalog = yield* mesh.refresh;
      const node = (label: string) => catalog.nodes.find((candidate) => candidate.label === label);

      expect(catalog.projects.map((project) => project.title)).toEqual(["Healthy"]);
      expect(node("Healthy")).toMatchObject({ reachability: "online" });
      expect(node("Unreachable")).toMatchObject({
        reachability: "offline",
        catalogErrorKind: "unreachable",
      });
      expect(node("Authentication")).toMatchObject({
        reachability: "online",
        catalogErrorKind: "authentication",
      });
      expect(node("Incompatible")).toMatchObject({
        reachability: "online",
        catalogErrorKind: "incompatible",
      });
      expect(node("Service")).toMatchObject({
        reachability: "online",
        catalogErrorKind: "service",
      });
    }),
  );

  it.effect("keeps healthy node catalogs when another node's catalog fails", () =>
    Effect.gen(function* () {
      const desktop = yield* makeNode({
        nodeId: NODE_DESKTOP,
        label: "Desktop",
        vocabulary: [vocabulary("rivvl-desktop", "Rivvl")],
        providers: [provider("codex")],
      });
      const laptop = yield* makeNode({
        nodeId: NODE_LAPTOP,
        label: "Laptop",
        vocabulary: [vocabulary("jarvis-laptop", "Jarvis")],
        providers: [provider("codex")],
        catalogFailure: true,
      });
      const { mesh } = yield* makeMesh([desktop, laptop]);

      const catalog = yield* mesh.refresh;

      expect(catalog.projects.map((project) => project.title)).toEqual(["Rivvl"]);
      expect(catalog.nodes).toMatchObject([
        { label: "Desktop", reachability: "online" },
        {
          label: "Laptop",
          reachability: "online",
          catalogError: `Environment ${NODE_LAPTOP} is not registered.`,
        },
      ]);
    }),
  );

  it.effect("uses the live server descriptor label for paired mesh entries", () =>
    Effect.gen(function* () {
      const node = yield* makeNode({
        nodeId: NODE_DESKTOP,
        label: "stale connection target",
        liveLabel: "Studio node",
        vocabulary: [vocabulary("studio-project", "Studio")],
        providers: [provider("codex")],
      });
      const { mesh } = yield* makeMesh([node]);

      const catalog = yield* mesh.refresh;

      expect(catalog.nodes[0]?.label).toBe("Studio node");
      expect(catalog.projects[0]?.nodeLabel).toBe("Studio node");
      expect(catalog.providers[0]?.nodeLabel).toBe("Studio node");
    }),
  );

  it.effect("routes every node-sensitive operation to its explicit node", () =>
    Effect.gen(function* () {
      const desktop = yield* makeNode({
        nodeId: NODE_DESKTOP,
        label: "Desktop",
        vocabulary: [vocabulary("rivvl-desktop", "Rivvl")],
        providers: [provider("codex")],
      });
      const laptop = yield* makeNode({
        nodeId: NODE_LAPTOP,
        label: "Laptop",
        vocabulary: [vocabulary("jarvis-laptop", "Jarvis")],
        providers: [provider("codex")],
      });
      const { mesh } = yield* makeMesh([desktop, laptop]);
      const projectRef: JarvisProjectRef = {
        nodeId: NODE_DESKTOP,
        projectId: ProjectId.make("rivvl-desktop"),
      };
      const requestMetadata = {
        requestId: "request-1",
        origin: { originNodeId: NODE_LAPTOP, originInteractionId: "interaction-1" },
      };

      yield* mesh.refresh;

      yield* mesh.execute({
        kind: "control",
        projectRef,
        requestMetadata,
        utterance: "Fix the tests.",
      });
      yield* mesh.getTaskDesk(NODE_DESKTOP);
      yield* mesh.manageProjectAlias({
        projectRef,
        action: "set",
        alias: "riv",
        kind: "user-defined",
      });
      expect(desktop.calls).toEqual([
        { method: WS_METHODS.jarvisGetProjectVocabulary, input: {} },
        { method: WS_METHODS.serverGetConfig, input: {} },
        {
          method: WS_METHODS.jarvisExecute,
          input: {
            kind: "control",
            projectId: "rivvl-desktop",
            projectRef,
            requestMetadata,
            utterance: "Fix the tests.",
          },
        },
        { method: WS_METHODS.jarvisGetTaskDesk, input: {} },
        {
          method: WS_METHODS.jarvisManageProjectAlias,
          input: {
            action: "set",
            projectId: "rivvl-desktop",
            nodeId: NODE_DESKTOP,
            alias: "riv",
            kind: "user-defined",
          },
        },
      ]);
      expect(laptop.calls).toEqual([
        { method: WS_METHODS.jarvisGetProjectVocabulary, input: {} },
        { method: WS_METHODS.serverGetConfig, input: {} },
      ]);
    }),
  );

  it.effect("passes the controller execution error through from the selected node", () =>
    Effect.gen(function* () {
      const executionError = new JarvisExecutionError({
        code: "execution-unavailable",
        message: "Controller nodes cannot execute Jarvis tasks.",
      });
      const controller = yield* makeNode({
        nodeId: NODE_DESKTOP,
        label: "Controller",
        vocabulary: [vocabulary("controller-project", "Controller Project")],
        providers: [provider("codex")],
        jarvisNodeCapabilities: jarvisNodeCapabilitiesForPreset("controller"),
        executeFailure: executionError,
      });
      const { mesh } = yield* makeMesh([controller]);

      yield* mesh.refresh;
      const error = yield* mesh
        .execute({
          kind: "control",
          projectRef: { nodeId: NODE_DESKTOP, projectId: ProjectId.make("controller-project") },
          requestMetadata: { requestId: "controller-request" },
          utterance: "Run this on the controller.",
        })
        .pipe(Effect.flip);

      expect(error).toBe(executionError);
      expect(error).toMatchObject({ code: "execution-unavailable" });
      expect(
        controller.calls.filter(({ method }) => method === WS_METHODS.serverGetConfig),
      ).toEqual([{ method: WS_METHODS.serverGetConfig, input: {} }]);
      expect(
        controller.calls.filter(({ method }) => method === WS_METHODS.jarvisExecute),
      ).toHaveLength(1);
    }),
  );

  it.effect("allows execution on headless nodes", () =>
    Effect.gen(function* () {
      const headless = yield* makeNode({
        nodeId: NODE_DESKTOP,
        label: "Headless",
        vocabulary: [vocabulary("headless-project", "Headless Project")],
        providers: [provider("codex")],
        jarvisNodeCapabilities: jarvisNodeCapabilitiesForPreset("headless"),
      });
      const { mesh } = yield* makeMesh([headless]);

      yield* mesh.refresh;
      const result = yield* mesh.execute({
        kind: "control",
        projectRef: { nodeId: NODE_DESKTOP, projectId: ProjectId.make("headless-project") },
        requestMetadata: { requestId: "headless-request" },
        utterance: "Run this on the headless node.",
      });

      expect(result).toMatchObject({ status: "started" });
      expect(
        headless.calls.filter(({ method }) => method === WS_METHODS.jarvisExecute),
      ).toHaveLength(1);
    }),
  );

  it.effect("dispatches an explicit node-qualified request without a config probe", () =>
    Effect.gen(function* () {
      const node = yield* makeNode({
        nodeId: NODE_DESKTOP,
        label: "Unavailable",
        vocabulary: [vocabulary("unavailable-project", "Unavailable Project")],
        providers: [provider("codex")],
        configFailure: true,
      });
      const { mesh } = yield* makeMesh([node]);

      const result = yield* mesh.execute({
        kind: "control",
        projectRef: { nodeId: NODE_DESKTOP, projectId: ProjectId.make("unavailable-project") },
        requestMetadata: { requestId: "unavailable-request" },
        utterance: "Run this without a capability probe.",
      });

      expect(result).toMatchObject({ status: "started" });
      expect(node.calls.filter(({ method }) => method === WS_METHODS.serverGetConfig)).toEqual([]);
      expect(node.calls.filter(({ method }) => method === WS_METHODS.jarvisExecute)).toHaveLength(
        1,
      );
    }),
  );

  it.effect("treats a cached capability incompatibility as advisory", () =>
    Effect.gen(function* () {
      const legacy = yield* makeNode({
        nodeId: NODE_DESKTOP,
        label: "Legacy",
        vocabulary: [vocabulary("legacy-project", "Legacy Project")],
        providers: [provider("codex")],
        legacyDescriptor: true,
      });
      const { mesh } = yield* makeMesh([legacy]);

      const catalog = yield* mesh.refresh;
      expect(catalog.nodes[0]).toMatchObject({ catalogErrorKind: "incompatible" });
      const result = yield* mesh.execute({
        kind: "control",
        projectRef: { nodeId: NODE_DESKTOP, projectId: ProjectId.make("legacy-project") },
        requestMetadata: { requestId: "legacy-request" },
        utterance: "Run this on the incompatible node.",
      });

      expect(result).toMatchObject({ status: "started" });
      expect(legacy.calls.filter(({ method }) => method === WS_METHODS.jarvisExecute)).toHaveLength(
        1,
      );
    }),
  );

  it.effect("surfaces a disconnected target instead of routing to another node", () =>
    Effect.gen(function* () {
      const offline = yield* makeNode({
        nodeId: NODE_DESKTOP,
        label: "Desktop",
        vocabulary: [],
        providers: [],
        phase: "offline",
      });
      const laptop = yield* makeNode({
        nodeId: NODE_LAPTOP,
        label: "Laptop",
        vocabulary: [vocabulary("jarvis-laptop", "Jarvis")],
        providers: [provider("codex")],
      });
      const { mesh } = yield* makeMesh([offline, laptop]);

      const error = yield* mesh
        .execute({
          kind: "control",
          projectRef: { nodeId: NODE_DESKTOP, projectId: ProjectId.make("rivvl-desktop") },
          requestMetadata: { requestId: "request-offline" },
          utterance: "Fix the tests.",
        })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(JarvisMeshNodeUnavailableError);
      expect(error).toMatchObject({ nodeId: NODE_DESKTOP, label: "Desktop" });
      expect(offline.calls).toEqual([]);
      expect(laptop.calls).toEqual([]);
    }),
  );

  it.effect("keeps voice compute on its explicit node when execution targets another node", () =>
    Effect.gen(function* () {
      const voiceNode = yield* makeNode({
        nodeId: NODE_LAPTOP,
        label: "Laptop voice",
        vocabulary: [],
        providers: [],
      });
      const executionNode = yield* makeNode({
        nodeId: NODE_DESKTOP,
        label: "Desktop executor",
        vocabulary: [vocabulary("jarvis", "Jarvis")],
        providers: [provider("codex")],
      });
      const { mesh } = yield* makeMesh([voiceNode, executionNode]);
      const transcript = yield* mesh.transcribeVoice(NODE_LAPTOP, {
        format: "pcm-s16le",
        audioBase64: "AAA=",
        sampleRate: 16_000,
        channels: 1,
      });
      yield* mesh.execute({
        kind: "control",
        projectRef: { nodeId: NODE_DESKTOP, projectId: ProjectId.make("jarvis") },
        requestMetadata: { requestId: "mobile-voice" },
        utterance: transcript.text,
      });
      yield* mesh.synthesizeVoice(NODE_LAPTOP, { text: "Done." });

      expect(
        voiceNode.calls
          .map(({ method }) => method)
          .filter(
            (method) =>
              method === WS_METHODS.jarvisVoiceTranscribe ||
              method === WS_METHODS.jarvisVoiceSynthesize,
          ),
      ).toEqual([WS_METHODS.jarvisVoiceTranscribe, WS_METHODS.jarvisVoiceSynthesize]);
      expect(executionNode.calls.map(({ method }) => method)).toEqual([WS_METHODS.jarvisExecute]);
    }),
  );

  it.effect(
    "rejects voice RPCs at the shared mesh boundary when the node lacks voice compute",
    () =>
      Effect.gen(function* () {
        const executionOnly = yield* makeNode({
          nodeId: NODE_DESKTOP,
          label: "VPS executor",
          vocabulary: [vocabulary("jarvis", "Jarvis")],
          providers: [provider("codex")],
          jarvisNodeCapabilities: jarvisNodeCapabilitiesForPreset("headless"),
        });
        const { mesh } = yield* makeMesh([executionOnly]);

        const error = yield* mesh
          .transcribeVoice(NODE_DESKTOP, {
            format: "pcm-s16le",
            audioBase64: "AAA=",
            sampleRate: 16_000,
            channels: 1,
          })
          .pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "JarvisMeshVoiceCapabilityError",
          nodeId: NODE_DESKTOP,
        });
        expect(
          executionOnly.calls.filter(({ method }) => method === WS_METHODS.jarvisVoiceTranscribe),
        ).toEqual([]);
      }),
  );
});
