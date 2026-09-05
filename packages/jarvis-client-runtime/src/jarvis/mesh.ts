import {
  EnvironmentId,
  EnvironmentAuthorizationError,
  isProviderAvailable,
  type JarvisExecuteInput,
  type JarvisExecutionResult,
  type JarvisManageProjectAliasResult,
  type JarvisNodeCapabilities,
  type JarvisProjectRef,
  type JarvisProjectVocabularyEntry,
  type JarvisRequestMetadata,
  type JarvisVoiceSynthesizeInput,
  type JarvisVoiceSynthesizeResult,
  type JarvisVoiceTranscribeInput,
  type JarvisVoiceTranscribeResult,
  type JarvisFocusTaskInput,
  type JarvisFocusTaskResult,
  type JarvisTaskDeskView,
  type ServerProvider,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  type ConnectionCatalogEntry,
  ConnectionBlockedError,
  ConnectionTransientError,
  EnvironmentNotRegisteredError,
  EnvironmentRegistry,
  type SupervisorConnectionPhase,
} from "@t3tools/client-runtime/connection";
import {
  executeJarvisInstruction,
  getJarvisProjectVocabulary,
  getJarvisTaskDesk,
  manageJarvisProjectAlias,
  focusJarvisTask,
} from "../operations/jarvis.ts";
import { synthesizeJarvisVoice, transcribeJarvisVoice } from "../operations/jarvisVoice.ts";
import {
  EnvironmentRpcUnavailableError,
  isRpcClientError,
  request,
  type EnvironmentRpcFailure,
} from "@t3tools/client-runtime/rpc";

export type JarvisMeshReachability = "online" | "offline";
export const JARVIS_MESH_REFRESH_CONCURRENCY = 4;
export type JarvisMeshCatalogErrorKind =
  | "unreachable"
  | "authentication"
  | "incompatible"
  | "service";

export interface JarvisMeshNode {
  readonly nodeId: EnvironmentId;
  readonly label: string;
  readonly reachability: JarvisMeshReachability;
  /** Canonical execution and surface capabilities advertised by the node. */
  readonly capabilities?: JarvisNodeCapabilities;
  /**
   * Whether the node's own configured semantic supervisor instance is
   * currently available for project-free conversation. Computed from the
   * node's advertised settings plus its provider snapshot: the node itself
   * is the authority for which instance it would use. False when the node
   * is unreachable, incompatible, or its supervisor instance is missing.
   */
  readonly conversationReady: boolean;
  /** A connected node can still have an unavailable Jarvis catalog. */
  readonly catalogError?: string;
  /** Stable classification for rendering a useful recovery action. */
  readonly catalogErrorKind?: JarvisMeshCatalogErrorKind;
}

export type JarvisMeshProject = JarvisProjectVocabularyEntry & {
  readonly ref: JarvisProjectRef;
  readonly nodeLabel: string;
};

export interface JarvisMeshProvider {
  readonly nodeId: EnvironmentId;
  readonly nodeLabel: string;
  readonly snapshot: ServerProvider;
  /** Informational readiness only; the target server validates execution. */
  readonly available: boolean;
}

export interface JarvisMeshCatalog {
  readonly nodes: ReadonlyArray<JarvisMeshNode>;
  readonly projects: ReadonlyArray<JarvisMeshProject>;
  readonly providers: ReadonlyArray<JarvisMeshProvider>;
}

export type JarvisMeshProjectCandidate = JarvisMeshProject & {
  readonly label: string;
};

export type JarvisMeshProjectResolution =
  | {
      readonly status: "resolved";
      readonly project: JarvisMeshProject;
    }
  | {
      readonly status: "needs-clarification";
      readonly candidates: ReadonlyArray<JarvisMeshProjectCandidate>;
    }
  | {
      readonly status: "not-found";
    };

export class JarvisMeshNodeUnavailableError extends Schema.TaggedErrorClass<JarvisMeshNodeUnavailableError>()(
  "JarvisMeshNodeUnavailableError",
  {
    nodeId: EnvironmentId,
    label: Schema.String,
    phase: Schema.Literals(["available", "offline", "connecting", "backoff", "blocked"]),
  },
) {
  override get message(): string {
    return `${this.label} is not connected (state: ${this.phase}).`;
  }
}

export class JarvisMeshVoiceCapabilityError extends Schema.TaggedErrorClass<JarvisMeshVoiceCapabilityError>()(
  "JarvisMeshVoiceCapabilityError",
  {
    nodeId: EnvironmentId,
    label: Schema.String,
  },
) {
  override get message(): string {
    return `${this.label} does not advertise Jarvis voice compute.`;
  }
}

export class JarvisMeshConversationUnavailableError extends Schema.TaggedErrorClass<JarvisMeshConversationUnavailableError>()(
  "JarvisMeshConversationUnavailableError",
  {
    nodeId: EnvironmentId,
    label: Schema.String,
  },
) {
  override get message(): string {
    return `${this.label} cannot run Jarvis conversation: its semantic supervisor is unavailable.`;
  }
}

export type JarvisMeshExecuteInput = Omit<
  Extract<JarvisExecuteInput, { kind: "control" }>,
  "projectId" | "requestMetadata"
> & {
  readonly projectRef: JarvisProjectRef;
  readonly requestMetadata: JarvisRequestMetadata;
};

export type JarvisMeshConverseInput = {
  readonly nodeId: EnvironmentId;
  readonly utterance: Extract<JarvisExecuteInput, { kind: "converse" }>["utterance"];
};

export type JarvisMeshFocusTaskInput = {
  readonly nodeId: EnvironmentId;
  readonly task: JarvisFocusTaskInput;
};

export type JarvisMeshManageProjectAliasInput =
  | {
      readonly projectRef: JarvisProjectRef;
      readonly action: "set";
      readonly alias: string;
      readonly kind: "confirmed-pronunciation" | "user-defined";
    }
  | {
      readonly projectRef: JarvisProjectRef;
      readonly action: "remove";
      readonly alias: string;
    };

type JarvisMeshOperationError<T> = T extends Effect.Effect<infer _A, infer E, infer _R> ? E : never;

type ExecuteError = JarvisMeshOperationError<ReturnType<typeof executeJarvisInstruction>>;
type TaskDeskError = JarvisMeshOperationError<ReturnType<typeof getJarvisTaskDesk>>;
type FocusTaskError = JarvisMeshOperationError<ReturnType<typeof focusJarvisTask>>;
type AliasError = JarvisMeshOperationError<ReturnType<typeof manageJarvisProjectAlias>>;
type VoiceCapabilityReadError = EnvironmentRpcFailure<typeof WS_METHODS.serverGetConfig>;
type VoiceTranscribeError =
  | JarvisMeshVoiceCapabilityError
  | VoiceCapabilityReadError
  | JarvisMeshOperationError<ReturnType<typeof transcribeJarvisVoice>>;
type VoiceSynthesizeError =
  | JarvisMeshVoiceCapabilityError
  | VoiceCapabilityReadError
  | JarvisMeshOperationError<ReturnType<typeof synthesizeJarvisVoice>>;
type NodeError = EnvironmentNotRegisteredError | JarvisMeshNodeUnavailableError;
type CatalogError =
  | NodeError
  | JarvisMeshOperationError<ReturnType<typeof getJarvisProjectVocabulary>>
  | EnvironmentRpcFailure<typeof WS_METHODS.serverGetConfig>;

export interface JarvisMeshService {
  readonly refresh: Effect.Effect<JarvisMeshCatalog, CatalogError>;
  readonly resolveProject: (query: string) => Effect.Effect<JarvisMeshProjectResolution>;
  readonly execute: (
    input: JarvisMeshExecuteInput,
  ) => Effect.Effect<JarvisExecutionResult, NodeError | ExecuteError>;
  /**
   * Project-free conversation on one online node. Answers are best-effort
   * and not receipt-backed: retries ask again.
   */
  readonly converse: (
    input: JarvisMeshConverseInput,
  ) => Effect.Effect<
    JarvisExecutionResult,
    NodeError | JarvisMeshConversationUnavailableError | ExecuteError
  >;
  readonly getTaskDesk: (
    nodeId: EnvironmentId,
  ) => Effect.Effect<JarvisTaskDeskView, NodeError | TaskDeskError>;
  readonly focusTask: (
    input: JarvisMeshFocusTaskInput,
  ) => Effect.Effect<JarvisFocusTaskResult, NodeError | FocusTaskError>;
  readonly manageProjectAlias: (
    input: JarvisMeshManageProjectAliasInput,
  ) => Effect.Effect<JarvisManageProjectAliasResult, NodeError | AliasError>;
  readonly transcribeVoice: (
    nodeId: EnvironmentId,
    input: JarvisVoiceTranscribeInput,
  ) => Effect.Effect<JarvisVoiceTranscribeResult, NodeError | VoiceTranscribeError>;
  readonly synthesizeVoice: (
    nodeId: EnvironmentId,
    input: JarvisVoiceSynthesizeInput,
  ) => Effect.Effect<JarvisVoiceSynthesizeResult, NodeError | VoiceSynthesizeError>;
}

export class JarvisMesh extends Context.Service<JarvisMesh, JarvisMeshService>()(
  "@t3tools/jarvis-client-runtime/jarvis/mesh/JarvisMesh",
) {}

const EMPTY_CATALOG: JarvisMeshCatalog = {
  nodes: [],
  projects: [],
  providers: [],
};

const normalize = (value: string): string => value.trim().toLowerCase();

const projectKey = (project: JarvisMeshProject): string =>
  `${project.ref.nodeId}:${project.ref.projectId}`;

const projectLabel = (project: JarvisMeshProject): string =>
  `${project.title} — ${project.nodeLabel}`;

const uniqueProjects = (
  projects: ReadonlyArray<JarvisMeshProject>,
): ReadonlyArray<JarvisMeshProject> => {
  const seen = new Set<string>();
  return projects.filter((project) => {
    const key = projectKey(project);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const projectExactVocabulary = (project: JarvisMeshProject): ReadonlyArray<string> => {
  const workspaceName = project.workspaceRoot.split(/[\\/]/u).at(-1);
  return [
    project.title,
    project.workspaceRoot,
    ...(workspaceName === undefined ? [] : [workspaceName]),
    ...project.repositoryNames,
  ];
};

const projectInstructionVocabulary = (project: JarvisMeshProject): ReadonlyArray<string> => [
  ...projectExactVocabulary(project),
  ...project.aliases,
];

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const explicitProjectPhrase = (instruction: string, vocabulary: string): boolean => {
  const normalizedVocabulary = vocabulary.trim();
  if (normalizedVocabulary.length === 0) return false;
  return new RegExp(
    `\\bin\\s+(?:["'“”])?${escapeRegExp(normalizedVocabulary)}(?:["'“”])?(?=$|[\\s,.;:!?])`,
    "iu",
  ).test(instruction);
};

/** Resolve only canonical names and saved aliases; phonetic matching belongs to the voice adapter. */
export function resolveJarvisMeshProject(
  catalog: JarvisMeshCatalog,
  query: string,
): JarvisMeshProjectResolution {
  const normalizedQuery = normalize(query);
  if (normalizedQuery.length === 0) return { status: "not-found" };

  const exact = uniqueProjects(
    catalog.projects.filter((project) =>
      projectExactVocabulary(project).some((value) => normalize(value) === normalizedQuery),
    ),
  );
  if (exact.length === 1) {
    return { status: "resolved", project: exact[0]! };
  }
  if (exact.length > 1) {
    return {
      status: "needs-clarification",
      candidates: exact.map((project) => ({ ...project, label: projectLabel(project) })),
    };
  }

  const aliases = uniqueProjects(
    catalog.projects.filter((project) =>
      project.aliases.some((alias) => normalize(alias) === normalizedQuery),
    ),
  );
  if (aliases.length === 1) {
    return { status: "resolved", project: aliases[0]! };
  }
  if (aliases.length > 1) {
    return {
      status: "needs-clarification",
      candidates: aliases.map((project) => ({ ...project, label: projectLabel(project) })),
    };
  }
  return { status: "not-found" };
}

export interface JarvisMeshInstructionProjectResolution {
  /** The matched phrase, when the instruction explicitly names a project. */
  readonly projectQuery: string | null;
  readonly resolution: JarvisMeshProjectResolution;
}

/**
 * Resolve an explicit `In <project>` phrase without rewriting the instruction.
 * The server still receives the original utterance, while the client supplies
 * the node-qualified project reference selected from the shared catalog.
 */
export function resolveJarvisMeshInstructionProject(
  catalog: JarvisMeshCatalog,
  instruction: string,
): JarvisMeshInstructionProjectResolution {
  const matchedVocabulary = new Map<string, string>();
  const matches = uniqueProjects(
    catalog.projects.filter((project) =>
      projectInstructionVocabulary(project).some((value) => {
        const matched = explicitProjectPhrase(instruction, value);
        if (matched) matchedVocabulary.set(projectKey(project), value.trim());
        return matched;
      }),
    ),
  );
  if (matches.length === 0) {
    return { projectQuery: null, resolution: { status: "not-found" } };
  }
  if (matches.length === 1) {
    return {
      projectQuery: matchedVocabulary.get(projectKey(matches[0]!)) ?? matches[0]!.title,
      resolution: { status: "resolved", project: matches[0]! },
    };
  }
  return {
    projectQuery: matchedVocabulary.get(projectKey(matches[0]!)) ?? matches[0]!.title,
    resolution: {
      status: "needs-clarification",
      candidates: matches.map((project) => ({ ...project, label: projectLabel(project) })),
    },
  };
}

const reachability = (phase: SupervisorConnectionPhase): JarvisMeshReachability =>
  phase === "connected" ? "online" : "offline";

const isEnvironmentRpcUnavailableError = Schema.is(EnvironmentRpcUnavailableError);
const isConnectionTransientError = Schema.is(ConnectionTransientError);
const isConnectionBlockedError = Schema.is(ConnectionBlockedError);
const isEnvironmentAuthorizationError = Schema.is(EnvironmentAuthorizationError);

const catalogErrorKind = (error: unknown): JarvisMeshCatalogErrorKind => {
  if (isEnvironmentRpcUnavailableError(error) || isConnectionTransientError(error)) {
    return "unreachable";
  }
  if (isConnectionBlockedError(error)) {
    return error.reason === "authentication" || error.reason === "permission"
      ? "authentication"
      : error.reason === "unsupported"
        ? "incompatible"
        : "service";
  }
  if (isEnvironmentAuthorizationError(error)) {
    return "authentication";
  }
  if (isRpcClientError(error)) {
    switch (error.reason._tag) {
      case "SocketOpenError":
      case "SocketReadError":
      case "SocketWriteError":
      case "SocketCloseError":
        return "unreachable";
      case "RpcClientDefect":
        return "incompatible";
      default:
        return "service";
    }
  }
  return "service";
};

const catalogErrorMessage = (kind: JarvisMeshCatalogErrorKind, error: unknown): string => {
  switch (kind) {
    case "unreachable":
      return "Node is unreachable; reconnect it and retry catalog refresh.";
    case "authentication":
      return "Node authentication failed; reconnect with a valid pairing link.";
    case "incompatible":
      return "Node returned an incompatible Jarvis catalog; update both devices and retry.";
    case "service":
      return error instanceof Error && error.message.trim().length > 0
        ? error.message
        : "Jarvis catalog unavailable.";
  }
};

const availableProvider = (provider: ServerProvider): boolean =>
  isProviderAvailable(provider) &&
  provider.enabled &&
  provider.installed &&
  provider.status === "ready" &&
  provider.auth.status !== "unauthenticated";

interface NodeRead {
  readonly node: JarvisMeshNode;
  readonly projects: ReadonlyArray<JarvisMeshProject>;
  readonly providers: ReadonlyArray<JarvisMeshProvider>;
}

export const make = Effect.gen(function* () {
  const registry = yield* EnvironmentRegistry;
  const catalogRef = yield* Ref.make<JarvisMeshCatalog>(EMPTY_CATALOG);

  const nodeRead = Effect.fn("JarvisMesh.readNode")(function* (
    entry: ConnectionCatalogEntry,
  ): Effect.fn.Return<NodeRead, CatalogError> {
    const target = entry.target;
    const state = yield* registry.state(target.environmentId);
    const currentNode: JarvisMeshNode = {
      nodeId: target.environmentId,
      label: target.label,
      reachability: reachability(state.phase),
      conversationReady: false,
    };
    if (state.phase !== "connected") {
      return {
        node: currentNode,
        projects: [],
        providers: [],
      };
    }

    const live = yield* registry.run(
      target.environmentId,
      Effect.all({
        vocabulary: getJarvisProjectVocabulary(),
        config: request(WS_METHODS.serverGetConfig, {}),
      }),
    );
    const capabilities = live.config.environment?.capabilities?.jarvisNode;
    if (capabilities === undefined) {
      return {
        node: {
          ...currentNode,
          catalogError: "This node does not advertise current Jarvis capabilities.",
          catalogErrorKind: "incompatible",
        },
        projects: [],
        providers: [],
      };
    }
    const liveLabel = live.config.environment?.label ?? target.label;
    const projects = live.vocabulary.map(
      (project): JarvisMeshProject => ({
        ...project,
        nodeId: target.environmentId,
        ref: {
          nodeId: target.environmentId,
          projectId: project.projectId,
        },
        nodeLabel: liveLabel,
      }),
    );
    const providers = live.config.providers.map(
      (snapshot): JarvisMeshProvider => ({
        nodeId: target.environmentId,
        nodeLabel: liveLabel,
        snapshot,
        available: availableProvider(snapshot),
      }),
    );
    // The node advertises both its configured supervisor instance (via
    // settings) and its provider snapshot: conversation is ready only when
    // that exact instance is currently available.
    const supervisorInstanceId = live.config.settings?.jarvisSupervisorModelSelection?.instanceId;
    const conversationReady =
      supervisorInstanceId !== undefined &&
      providers.some(
        (provider) => provider.available && provider.snapshot.instanceId === supervisorInstanceId,
      );
    return {
      node: { ...currentNode, label: liveLabel, capabilities, conversationReady },
      projects,
      providers,
    };
  });

  const refresh = Effect.gen(function* () {
    const entries = yield* SubscriptionRef.get(registry.entries);
    const reads = yield* Effect.forEach(
      [...entries.values()],
      (entry) =>
        nodeRead(entry).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const state = yield* registry
                .state(entry.target.environmentId)
                .pipe(Effect.orElseSucceed(() => ({ phase: "offline" as const })));
              const kind = catalogErrorKind(error);
              const node: JarvisMeshNode = {
                nodeId: entry.target.environmentId,
                label: entry.target.label,
                // A connected state is not enough to claim a reachable node when
                // its catalog probe failed at the transport boundary.
                reachability: kind === "unreachable" ? "offline" : reachability(state.phase),
                conversationReady: false,
                catalogErrorKind: kind,
                catalogError: catalogErrorMessage(kind, error),
              };
              return { node, projects: [], providers: [] } satisfies NodeRead;
            }),
          ),
        ),
      {
        concurrency: JARVIS_MESH_REFRESH_CONCURRENCY,
      },
    );
    const next: JarvisMeshCatalog = {
      nodes: reads.map((read) => read.node),
      projects: reads.flatMap((read) => read.projects),
      providers: reads.flatMap((read) => read.providers),
    };
    yield* Ref.set(catalogRef, next);
    return next;
  });

  const connectedNode = Effect.fn("JarvisMesh.connectedNode")(function* (nodeId: EnvironmentId) {
    const entries = yield* SubscriptionRef.get(registry.entries);
    const entry = entries.get(nodeId);
    if (entry === undefined) {
      return yield* new EnvironmentNotRegisteredError({ environmentId: nodeId });
    }
    const state = yield* registry.state(nodeId);
    if (state.phase !== "connected") {
      return yield* new JarvisMeshNodeUnavailableError({
        nodeId,
        label: entry.target.label,
        phase: state.phase,
      });
    }
    return entry;
  });

  const execute = Effect.fn("JarvisMesh.execute")(function* (input: JarvisMeshExecuteInput) {
    yield* connectedNode(input.projectRef.nodeId);
    return yield* registry.run(
      input.projectRef.nodeId,
      executeJarvisInstruction({
        ...input,
        projectId: input.projectRef.projectId,
        projectRef: input.projectRef,
        requestMetadata: input.requestMetadata,
      }),
    );
  });

  const connectedVoiceNode = Effect.fn("JarvisMesh.connectedVoiceNode")(function* (
    nodeId: EnvironmentId,
  ) {
    const entry = yield* connectedNode(nodeId);
    const catalog = yield* Ref.get(catalogRef);
    const cached = catalog.nodes.find((node) => node.nodeId === nodeId)?.capabilities;
    const capabilities =
      cached ??
      (yield* registry.run(nodeId, request(WS_METHODS.serverGetConfig, {}))).environment
        ?.capabilities?.jarvisNode;
    if (capabilities?.voiceCompute !== true) {
      return yield* new JarvisMeshVoiceCapabilityError({
        nodeId,
        label: entry.target.label,
      });
    }
  });

  const getTaskDesk = Effect.fn("JarvisMesh.getTaskDesk")(function* (nodeId: EnvironmentId) {
    yield* connectedNode(nodeId);
    return yield* registry.run(nodeId, getJarvisTaskDesk());
  });

  const focusTask = Effect.fn("JarvisMesh.focusTask")(function* (input: JarvisMeshFocusTaskInput) {
    yield* connectedNode(input.nodeId);
    return yield* registry.run(input.nodeId, focusJarvisTask(input.task));
  });

  const manageAlias = Effect.fn("JarvisMesh.manageProjectAlias")(function* (
    input: JarvisMeshManageProjectAliasInput,
  ) {
    yield* connectedNode(input.projectRef.nodeId);
    const { projectRef, ...alias } = input;
    return yield* registry.run(
      projectRef.nodeId,
      manageJarvisProjectAlias({
        ...alias,
        projectId: projectRef.projectId,
        nodeId: projectRef.nodeId,
      }),
    );
  });

  const transcribeVoice = Effect.fn("JarvisMesh.transcribeVoice")(function* (
    nodeId: EnvironmentId,
    input: JarvisVoiceTranscribeInput,
  ) {
    yield* connectedVoiceNode(nodeId);
    return yield* registry.run(nodeId, transcribeJarvisVoice(input));
  });

  const synthesizeVoice = Effect.fn("JarvisMesh.synthesizeVoice")(function* (
    nodeId: EnvironmentId,
    input: JarvisVoiceSynthesizeInput,
  ) {
    yield* connectedVoiceNode(nodeId);
    return yield* registry.run(nodeId, synthesizeJarvisVoice(input));
  });

  const converse = Effect.fn("JarvisMesh.converse")(function* (input: JarvisMeshConverseInput) {
    yield* connectedNode(input.nodeId);
    // The cached catalog is the node's own advertised capability: refuse a
    // node whose configured supervisor is known-unavailable instead of
    // sending a question it can only fail.
    const catalog = yield* Ref.get(catalogRef);
    const cached = catalog.nodes.find((node) => node.nodeId === input.nodeId);
    if (cached !== undefined && cached.conversationReady === false) {
      return yield* new JarvisMeshConversationUnavailableError({
        nodeId: input.nodeId,
        label: cached.label,
      });
    }
    return yield* registry.run(
      input.nodeId,
      executeJarvisInstruction({ kind: "converse", utterance: input.utterance }),
    );
  });

  return JarvisMesh.of({
    refresh,
    resolveProject: (query) =>
      Ref.get(catalogRef).pipe(Effect.map((catalog) => resolveJarvisMeshProject(catalog, query))),
    execute,
    converse,
    getTaskDesk,
    focusTask,
    manageProjectAlias: manageAlias,
    transcribeVoice,
    synthesizeVoice,
  });
});

export const layer = Layer.effect(JarvisMesh, make);
