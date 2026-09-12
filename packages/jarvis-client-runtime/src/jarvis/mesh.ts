import {
  normalizeDestinationPhrase,
  stripDestinationQuotes,
} from "@t3tools/jarvis-core/destinationSpan";
import {
  EnvironmentId,
  EnvironmentAuthorizationError,
  isProviderAvailable,
  type JarvisCancelRequestInput,
  type JarvisCancelRequestResult,
  type JarvisExecuteInput,
  type JarvisExecutionResult,
  type JarvisInterpretInput,
  type JarvisInterpretResult,
  type JarvisManageProjectAliasResult,
  type JarvisNodeCapabilities,
  type JarvisProjectRef,
  type JarvisProjectVocabularyEntry,
  type JarvisRequestMetadata,
  type JarvisFocusTaskInput,
  type JarvisFocusTaskResult,
  type JarvisTaskDeskView,
  type ServerProvider,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
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
  interpretJarvisInstruction,
  cancelJarvisRequest,
  getJarvisProjectVocabulary,
  getJarvisTaskDesk,
  manageJarvisProjectAlias,
  focusJarvisTask,
} from "../operations/jarvis.ts";
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
   * is the authority for which instance it would use. False only when a
   * successful configuration read confirms the configured supervisor is
   * unavailable. Absent when readiness is unknown — no connection, failed
   * probe, incompatible descriptor, or settings without a supervisor
   * selection — so callers fall back instead of refusing.
   */
  readonly conversationReady?: boolean | undefined;
  /** A connected node can still have an unavailable Jarvis catalog. */
  readonly catalogError?: string;
  /** A registered node has not finished its current catalog read. */
  readonly catalogPending?: boolean;
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

export class JarvisMeshNodeUnavailableError extends Schema.TaggedError<JarvisMeshNodeUnavailableError>()(
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

export class JarvisMeshConversationUnavailableError extends Schema.TaggedError<JarvisMeshConversationUnavailableError>()(
  "JarvisMeshConversationUnavailableError",
  {
    nodeId: EnvironmentId,
    label: Schema.String,
  },
) {
  override get message(): string {
    return `${this.label} cannot run ARIS conversation: its semantic supervisor is unavailable.`;
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
  readonly requestMetadata?: Extract<JarvisExecuteInput, { kind: "converse" }>["requestMetadata"];
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

export type JarvisMeshInterpretInput = {
  readonly nodeId: EnvironmentId;
  readonly interpret: JarvisInterpretInput;
};

type ExecuteError = JarvisMeshOperationError<ReturnType<typeof executeJarvisInstruction>>;
type InterpretError = JarvisMeshOperationError<
  ReturnType<typeof import("../operations/jarvis.ts").interpretJarvisInstruction>
>;
type TaskDeskError = JarvisMeshOperationError<ReturnType<typeof getJarvisTaskDesk>>;
type FocusTaskError = JarvisMeshOperationError<ReturnType<typeof focusJarvisTask>>;
type AliasError = JarvisMeshOperationError<ReturnType<typeof manageJarvisProjectAlias>>;
type NodeError = EnvironmentNotRegisteredError | JarvisMeshNodeUnavailableError;
type CatalogError =
  | NodeError
  | JarvisMeshOperationError<ReturnType<typeof getJarvisProjectVocabulary>>
  | EnvironmentRpcFailure<typeof WS_METHODS.serverGetConfig>;

export interface JarvisMeshService {
  readonly catalogChanges: Stream.Stream<JarvisMeshCatalog>;
  readonly refresh: Effect.Effect<JarvisMeshCatalog, CatalogError>;
  /**
   * Refresh one node and merge it into the shared catalog without waiting
   * for unrelated nodes. Use this to validate an already-selected execution
   * node instead of stalling a submission on a slow peer.
   */
  readonly refreshNode: (nodeId: EnvironmentId) => Effect.Effect<JarvisMeshCatalog, CatalogError>;
  readonly resolveProject: (query: string) => Effect.Effect<JarvisMeshProjectResolution>;
  /**
   * One configured-supervisor inference before irreversible routing. Runs on
   * the selected semantic node (ambient online preferred, else first online)
   * over verbatim source plus untrusted mesh evidence. Returns a typed
   * proposal with no dispatch; the client grounds it and the execution node
   * revalidates. Uses ordinary authenticated clients and the node's ordinary
   * provider registry, never a direct provider.
   */
  readonly interpret: (
    input: JarvisMeshInterpretInput,
  ) => Effect.Effect<JarvisInterpretResult, NodeError | InterpretError>;
  readonly execute: (
    input: JarvisMeshExecuteInput,
  ) => Effect.Effect<JarvisExecutionResult, NodeError | ExecuteError>;
  /**
   * Cancel one pre-accept request on its explicit node. The result is
   * cancelled, already-accepted with the running identity, or unknown when
   * nothing cancellable is known; callers keep waiting on unknown.
   */
  readonly cancelRequest: (
    nodeId: EnvironmentId,
    input: JarvisCancelRequestInput,
  ) => Effect.Effect<JarvisCancelRequestResult, NodeError | ExecuteError>;
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

/**
 * Every matchable name for proposal grounding: title, workspace basename,
 * repository names, and exact aliases. Phonetic matching never applies;
 * the proposal must cite the heard text exactly.
 */
export function meshProjectMatchNames(project: JarvisMeshProject): ReadonlyArray<string> {
  return [...projectInstructionVocabulary(project)];
}

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

/**
 * Semantic-node selection without reading the utterance. The interpret call
 * must happen before irreversible routing, so the node pick cannot depend on
 * prepositions, regex, or inferred destinations. Prefer the ambient project
 * node when it is online; otherwise use the first online node. Returns
 * undefined when no node is online, so callers report availability instead
 * of guessing.
 */
export function selectJarvisSemanticNode(
  catalog: JarvisMeshCatalog,
  ambientNodeId?: EnvironmentId,
): JarvisMeshNode | undefined {
  const online = catalog.nodes.filter((node) => node.reachability === "online");
  if (online.length === 0) return undefined;
  if (ambientNodeId !== undefined) {
    const ambient = online.find((node) => node.nodeId === ambientNodeId);
    if (ambient !== undefined) return ambient;
  }
  return online[0];
}

export interface JarvisMeshInterpretEvidenceOptions {
  readonly currentProjectTitle?: string;
  readonly focusedTask?: { readonly title: string; readonly project?: string };
  readonly continueContext?: boolean;
  readonly pendingHint?: JarvisInterpretInput["pendingHint"];
  readonly inputMode?: "voice" | "text";
  readonly tasks?: ReadonlyArray<{
    readonly title: string;
    readonly project?: string;
    readonly objective?: string;
    readonly state?: string;
  }>;
  readonly requestMetadata?: JarvisInterpretInput["requestMetadata"];
}

/**
 * Build the bounded untrusted evidence for one interpret call from the live
 * mesh catalog. Names only, never IDs; the semantic node proposes and both
 * hosts validate. Caps keep the prompt bounded on large meshes. Tasks come
 * from the fresh desk read (same 8-task window the direct wire prompts), so
 * a per-source proposal sees the same names as a direct local inference.
 */
export function buildJarvisInterpretInput(
  catalog: JarvisMeshCatalog,
  source: string,
  options: JarvisMeshInterpretEvidenceOptions = {},
): JarvisInterpretInput {
  const projects = catalog.projects.slice(0, 32).map((project) => ({
    title: project.title.slice(0, 240),
    names: meshProjectMatchNames(project)
      .slice(0, 12)
      .map((name) => name.slice(0, 240)),
  }));
  const providerNames = new Map<string, string>();
  for (const provider of catalog.providers) {
    const name = provider.snapshot.displayName ?? provider.snapshot.driver ?? "provider";
    const key = name.toLocaleLowerCase("en-US");
    if (!providerNames.has(key)) providerNames.set(key, name.slice(0, 120));
    if (providerNames.size >= 16) break;
  }
  const tasks = (options.tasks ?? []).slice(0, 8).map((task) => ({
    title: task.title.slice(0, 240),
    ...(task.project === undefined ? {} : { project: task.project.slice(0, 240) }),
    ...(task.objective === undefined ? {} : { objective: task.objective.slice(0, 480) }),
    ...(task.state === undefined ? {} : { state: task.state.slice(0, 64) }),
  }));
  return {
    utterance: source.slice(0, 16_000),
    projects,
    tasks,
    providers: [...providerNames.values()].map((name) => ({ name })),
    ...(options.currentProjectTitle === undefined
      ? {}
      : { currentProjectTitle: options.currentProjectTitle.slice(0, 240) }),
    ...(options.focusedTask === undefined ? {} : { focusedTask: options.focusedTask }),
    ...(options.continueContext === undefined ? {} : { continueContext: options.continueContext }),
    ...(options.pendingHint === undefined ? {} : { pendingHint: options.pendingHint }),
    ...(options.inputMode === undefined ? {} : { inputMode: options.inputMode }),
    ...(options.requestMetadata === undefined ? {} : { requestMetadata: options.requestMetadata }),
  };
}

/**
 * Fold one heard value exactly like the host validator, so client grounding
 * and server validation agree on what matches. Shared here so routeGrounding
 * needs no regex of its own.
 */
export function foldJarvisMeshName(value: string): string {
  return normalizeDestinationPhrase(stripDestinationQuotes(value));
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
      return "Node returned an incompatible ARIS catalog; update both devices and retry.";
    case "service":
      return error instanceof Error && error.message.trim().length > 0
        ? error.message
        : "ARIS catalog unavailable.";
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

export type JarvisMeshNodeRecoveryAction = "retry" | "reconnect" | "reauthenticate" | "update";

export type JarvisMeshNodeReadiness =
  | { readonly status: "ready" }
  | { readonly status: "loading" }
  | {
      readonly status: "unavailable";
      readonly message: string;
      readonly recovery: JarvisMeshNodeRecoveryAction;
    };

export interface JarvisMeshNodeReadinessInput {
  readonly nodeId?: unknown;
  readonly label?: string;
  readonly reachability: JarvisMeshReachability;
  readonly catalogPending?: boolean;
  readonly catalogError?: string;
  readonly catalogErrorKind?: JarvisMeshCatalogErrorKind;
}

/**
 * One shared per-node readiness policy. Loading means a catalog read is still
 * in flight. Ready means the catalog read finished, even when it legitimately
 * holds zero projects. Unavailable keeps the node's actual message and names
 * the recovery that fits its classification.
 */
export function jarvisMeshNodeReadiness(
  node: JarvisMeshNodeReadinessInput,
): JarvisMeshNodeReadiness {
  if (node.catalogPending === true) return { status: "loading" };
  if (node.reachability !== "online") {
    return {
      status: "unavailable",
      message:
        node.catalogError ??
        `${node.label ?? "Node"} is offline; reconnect it and retry catalog refresh.`,
      recovery:
        node.catalogErrorKind === "authentication"
          ? "reauthenticate"
          : node.catalogErrorKind === "incompatible"
            ? "update"
            : "reconnect",
    };
  }
  if (node.catalogError !== undefined) {
    return {
      status: "unavailable",
      message: node.catalogError,
      recovery:
        node.catalogErrorKind === "authentication"
          ? "reauthenticate"
          : node.catalogErrorKind === "incompatible"
            ? "update"
            : node.catalogErrorKind === "unreachable"
              ? "reconnect"
              : "retry",
    };
  }
  return { status: "ready" };
}

/**
 * Nodes whose catalog could not be read while they look connected. Name
 * resolution against such a catalog is partial: an unqualified name that
 * resolves here might also exist on an unread node, so callers must clarify
 * or report availability instead of guessing.
 */
export function jarvisMeshCatalogCoverage(catalog: JarvisMeshCatalog): {
  readonly complete: boolean;
  readonly unavailableNodeLabels: ReadonlyArray<string>;
} {
  const unavailableNodeLabels = catalog.nodes
    .filter((node) => jarvisMeshNodeReadiness(node).status !== "ready")
    .map((node) => node.label);
  return { complete: unavailableNodeLabels.length === 0, unavailableNodeLabels };
}

export const make = Effect.gen(function* () {
  const registry = yield* EnvironmentRegistry;
  const catalogRef = yield* SubscriptionRef.make<JarvisMeshCatalog>(EMPTY_CATALOG);

  const mergeNodeRead = (current: JarvisMeshCatalog, read: NodeRead): JarvisMeshCatalog => {
    const nodes = current.nodes.some((node) => node.nodeId === read.node.nodeId)
      ? current.nodes.map((node) => (node.nodeId === read.node.nodeId ? read.node : node))
      : [...current.nodes, read.node];
    return {
      nodes,
      projects: [
        ...current.projects.filter((project) => project.ref.nodeId !== read.node.nodeId),
        ...read.projects,
      ],
      providers: [
        ...current.providers.filter((provider) => provider.nodeId !== read.node.nodeId),
        ...read.providers,
      ],
    };
  };

  const nodeRead = Effect.fn("JarvisMesh.readNode")(function* (
    entry: ConnectionCatalogEntry,
  ): Effect.fn.Return<NodeRead, CatalogError> {
    const target = entry.target;
    const state = yield* registry.state(target.environmentId);
    const currentNode: JarvisMeshNode = {
      nodeId: target.environmentId,
      label: target.label,
      reachability: reachability(state.phase),
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
          catalogError: "This node does not advertise current ARIS capabilities.",
          catalogErrorKind: "incompatible",
        },
        projects: [],
        providers: [],
      };
    }
    const liveLabel = live.config.environment?.label ?? target.label;
    const projects = live.vocabulary.map((project): JarvisMeshProject => ({
      ...project,
      nodeId: target.environmentId,
      ref: {
        nodeId: target.environmentId,
        projectId: project.projectId,
      },
      nodeLabel: liveLabel,
    }));
    const providers = live.config.providers.map((snapshot): JarvisMeshProvider => ({
      nodeId: target.environmentId,
      nodeLabel: liveLabel,
      snapshot,
      available: availableProvider(snapshot),
    }));
    // The node advertises both its configured supervisor instance (via
    // settings) and its provider snapshot: false only when a successful
    // read confirms that exact instance is unavailable. Missing settings
    // stay unknown so the normal execute fallback remains eligible.
    const supervisorInstanceId = live.config.settings?.jarvisSupervisorModelSelection?.instanceId;
    const conversationReady =
      supervisorInstanceId === undefined
        ? undefined
        : providers.some(
            (provider) =>
              provider.available && provider.snapshot.instanceId === supervisorInstanceId,
          );
    return {
      node: { ...currentNode, label: liveLabel, capabilities, conversationReady },
      projects,
      providers,
    };
  });

  const readsInFlight = new Map<EnvironmentId, object>();

  const prepareCatalog = (entries: ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>) =>
    SubscriptionRef.update(catalogRef, (current) => ({
      nodes: [...entries.values()].map(
        (entry) =>
          current.nodes.find((node) => node.nodeId === entry.target.environmentId) ?? {
            nodeId: entry.target.environmentId,
            label: entry.target.label,
            reachability: "offline" as const,
            catalogPending: true,
          },
      ),
      projects: current.projects.filter((project) => entries.has(project.ref.nodeId)),
      providers: current.providers.filter((provider) => entries.has(provider.nodeId)),
    }));

  const refreshEntry = Effect.fn("JarvisMesh.refreshEntry")(function* (
    entry: ConnectionCatalogEntry,
  ) {
    const nodeId = entry.target.environmentId;
    const token = {};
    readsInFlight.set(nodeId, token);
    yield* SubscriptionRef.update(catalogRef, (current) => ({
      ...current,
      nodes: current.nodes.map((node) =>
        node.nodeId === nodeId ? { ...node, catalogPending: true } : node,
      ),
    }));
    const read = yield* nodeRead(entry).pipe(
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
            // its catalog probe failed at the transport boundary. Readiness
            // stays unknown: the probe never confirmed the supervisor.
            reachability: kind === "unreachable" ? "offline" : reachability(state.phase),
            catalogErrorKind: kind,
            catalogError: catalogErrorMessage(kind, error),
          };
          return { node, projects: [], providers: [] } satisfies NodeRead;
        }),
      ),
    );
    const entries = yield* SubscriptionRef.get(registry.entries);
    if (readsInFlight.get(nodeId) === token) {
      readsInFlight.delete(nodeId);
      if (entries.get(nodeId) === entry) {
        yield* SubscriptionRef.update(catalogRef, (current) => mergeNodeRead(current, read));
      }
    }
    yield* prepareCatalog(entries);
  });

  const refresh = Effect.gen(function* () {
    const entries = yield* SubscriptionRef.get(registry.entries);
    yield* prepareCatalog(entries);
    yield* Effect.forEach([...entries.values()], refreshEntry, {
      concurrency: JARVIS_MESH_REFRESH_CONCURRENCY,
      discard: true,
    });
    return yield* SubscriptionRef.get(catalogRef);
  });

  const refreshNode = Effect.fn("JarvisMesh.refreshNode")(function* (nodeId: EnvironmentId) {
    const entries = yield* SubscriptionRef.get(registry.entries);
    const entry = entries.get(nodeId);
    if (entry === undefined) {
      return yield* new EnvironmentNotRegisteredError({ environmentId: nodeId });
    }
    yield* prepareCatalog(entries);
    yield* refreshEntry(entry);
    return yield* SubscriptionRef.get(catalogRef);
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

  const interpret = Effect.fn("JarvisMesh.interpret")(function* (input: JarvisMeshInterpretInput) {
    yield* connectedNode(input.nodeId);
    return yield* registry.run(input.nodeId, interpretJarvisInstruction(input.interpret));
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

  const getTaskDesk = Effect.fn("JarvisMesh.getTaskDesk")(function* (nodeId: EnvironmentId) {
    yield* connectedNode(nodeId);
    return yield* registry.run(nodeId, getJarvisTaskDesk());
  });

  const focusTask = Effect.fn("JarvisMesh.focusTask")(function* (input: JarvisMeshFocusTaskInput) {
    yield* connectedNode(input.nodeId);
    return yield* registry.run(input.nodeId, focusJarvisTask(input.task));
  });

  const cancelRequest = Effect.fn("JarvisMesh.cancelRequest")(function* (
    nodeId: EnvironmentId,
    input: JarvisCancelRequestInput,
  ) {
    yield* connectedNode(nodeId);
    return yield* registry.run(nodeId, cancelJarvisRequest(input));
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

  const converse = Effect.fn("JarvisMesh.converse")(function* (input: JarvisMeshConverseInput) {
    yield* connectedNode(input.nodeId);
    // The cached catalog is the node's own advertised capability: refuse a
    // node whose configured supervisor is known-unavailable instead of
    // sending a question it can only fail.
    const catalog = yield* SubscriptionRef.get(catalogRef);
    const cached = catalog.nodes.find((node) => node.nodeId === input.nodeId);
    if (cached !== undefined && cached.conversationReady === false) {
      return yield* new JarvisMeshConversationUnavailableError({
        nodeId: input.nodeId,
        label: cached.label,
      });
    }
    return yield* registry.run(
      input.nodeId,
      executeJarvisInstruction({
        kind: "converse",
        utterance: input.utterance,
        ...(input.requestMetadata === undefined ? {} : { requestMetadata: input.requestMetadata }),
      }),
    );
  });

  return JarvisMesh.of({
    catalogChanges: SubscriptionRef.changes(catalogRef),
    refresh,
    refreshNode,
    resolveProject: (query) =>
      SubscriptionRef.get(catalogRef).pipe(
        Effect.map((catalog) => resolveJarvisMeshProject(catalog, query)),
      ),
    interpret,
    execute,
    converse,
    getTaskDesk,
    focusTask,
    cancelRequest,
    manageProjectAlias: manageAlias,
  });
});

export const layer = Layer.effect(JarvisMesh, make);
