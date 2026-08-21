import {
  EnvironmentId,
  JarvisProjectRef,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
  type JarvisExecutionResult,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type NetworkStatus,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentNotRegisteredError, EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  JarvisMeshNodeUnavailableError,
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
}

const makeNode = Effect.fn("JarvisMeshTest.makeNode")(function* (input: {
  readonly nodeId: EnvironmentId;
  readonly label: string;
  readonly vocabulary: ReturnType<typeof vocabulary>[];
  readonly providers: ServerProvider[];
  readonly phase?: "connected" | "offline";
  readonly catalogFailure?: boolean;
  readonly executeResult?: JarvisExecutionResult;
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
        if (input.catalogFailure === true) {
          return yield* Effect.fail(
            new EnvironmentNotRegisteredError({ environmentId: input.nodeId }),
          );
        }
        return input.vocabulary;
      }),
    [WS_METHODS.serverGetConfig]: (requestInput: unknown) =>
      Effect.sync(() => {
        calls.push({ method: WS_METHODS.serverGetConfig, input: requestInput });
        return { providers: input.providers };
      }),
    [WS_METHODS.jarvisExecute]: (requestInput: unknown) =>
      Effect.sync(() => {
        calls.push({ method: WS_METHODS.jarvisExecute, input: requestInput });
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
          focusedThreadId: null,
          attentionThreadId: null,
          backStack: [],
          forwardStack: [],
          recentTasks: [],
          pendingFrame: null,
          pendingProjectFrame: null,
          newConversationArmed: false,
          updatedAt: null,
        };
      }),
    [WS_METHODS.jarvisNavigateTaskDesk]: (requestInput: unknown) =>
      Effect.sync(() => {
        calls.push({ method: WS_METHODS.jarvisNavigateTaskDesk, input: requestInput });
        return {
          focusedThreadId: null,
          attentionThreadId: null,
          backStack: [],
          forwardStack: [],
          recentTasks: [],
          pendingFrame: null,
          pendingProjectFrame: null,
          newConversationArmed: true,
          updatedAt: null,
        };
      }),
    [WS_METHODS.jarvisManageProjectAlias]: (requestInput: unknown) =>
      Effect.sync(() => {
        calls.push({ method: WS_METHODS.jarvisManageProjectAlias, input: requestInput });
        return { changed: true };
      }),
    [WS_METHODS.jarvisAcknowledgeReport]: (requestInput: unknown) =>
      Effect.sync(() => {
        calls.push({ method: WS_METHODS.jarvisAcknowledgeReport, input: requestInput });
        return { acknowledgedThrough: 4 };
      }),
    [WS_METHODS.jarvisClaimSpeaker]: (requestInput: unknown) =>
      Effect.sync(() => {
        calls.push({ method: WS_METHODS.jarvisClaimSpeaker, input: requestInput });
        return { granted: true, speechState: "claimed" as const };
      }),
    [WS_METHODS.jarvisConfirmReportSpoken]: (requestInput: unknown) =>
      Effect.sync(() => {
        calls.push({ method: WS_METHODS.jarvisConfirmReportSpoken, input: requestInput });
        return { confirmed: true, state: "confirmed" as const };
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
  return { target, supervisor, vocabulary: input.vocabulary, providers: input.providers, calls };
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
          projectRef: resolution.project.ref,
          requestMetadata,
          utterance: "Review Rivvl.",
        });
        expect(first).toMatchObject({ status: "started", threadId: "thread-routed" });

        if (first.status !== "started") return;
        yield* mesh.execute({
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
              projectId: "rivvl-desktop",
              projectRef: resolution.project.ref,
              requestMetadata,
              utterance: "Review Rivvl.",
            },
          },
          {
            method: WS_METHODS.jarvisExecute,
            input: {
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
        projectRef: resolution.project.ref,
        requestMetadata,
        utterance: "Fix the voice overlay.",
      });

      expect(result).toMatchObject({ status: "started", threadId: "thread-routed" });
      expect(laptop.calls.filter(({ method }) => method === WS_METHODS.jarvisExecute)).toEqual([
        {
          method: WS_METHODS.jarvisExecute,
          input: {
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
        projectRef,
        requestMetadata,
        utterance: "Fix the tests.",
      });
      yield* mesh.getTaskDesk(NODE_DESKTOP);
      yield* mesh.navigateTaskDesk({
        nodeId: NODE_DESKTOP,
        navigation: { action: "new-conversation" },
      });
      yield* mesh.manageProjectAlias({
        projectRef,
        action: "set",
        alias: "riv",
        kind: "user-defined",
      });
      yield* mesh.acknowledgeReport({ nodeId: NODE_DESKTOP, input: { throughSequence: 4 } });
      yield* mesh.claimSpeaker({
        nodeId: NODE_DESKTOP,
        input: { reportId: "report-1", deviceId: "laptop", priority: 100 },
      });
      yield* mesh.confirmReportSpoken({
        nodeId: NODE_DESKTOP,
        input: { reportId: "report-1", deviceId: "laptop" },
      });

      expect(desktop.calls).toEqual([
        { method: WS_METHODS.jarvisGetProjectVocabulary, input: {} },
        { method: WS_METHODS.serverGetConfig, input: {} },
        {
          method: WS_METHODS.jarvisExecute,
          input: {
            projectId: "rivvl-desktop",
            projectRef,
            requestMetadata,
            utterance: "Fix the tests.",
          },
        },
        { method: WS_METHODS.jarvisGetTaskDesk, input: {} },
        { method: WS_METHODS.jarvisNavigateTaskDesk, input: { action: "new-conversation" } },
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
        { method: WS_METHODS.jarvisAcknowledgeReport, input: { throughSequence: 4 } },
        {
          method: WS_METHODS.jarvisClaimSpeaker,
          input: { reportId: "report-1", deviceId: "laptop", priority: 100 },
        },
        {
          method: WS_METHODS.jarvisConfirmReportSpoken,
          input: { reportId: "report-1", deviceId: "laptop" },
        },
      ]);
      expect(laptop.calls).toEqual([
        { method: WS_METHODS.jarvisGetProjectVocabulary, input: {} },
        { method: WS_METHODS.serverGetConfig, input: {} },
      ]);
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
});
