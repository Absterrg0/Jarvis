import {
  EnvironmentId,
  EnvironmentAuthorizationError,
  isProviderAvailable,
  jarvisNodeCapabilitiesForPreset,
  type JarvisAcknowledgeVoiceReportInput,
  type JarvisAcknowledgeVoiceReportResult,
  type JarvisExecuteInput,
  type JarvisExecutionResult,
  type JarvisManageProjectAliasResult,
  type JarvisNodeCapabilities,
  type JarvisProjectRef,
  type JarvisProjectVocabularyEntry,
  type JarvisRequestMetadata,
  type JarvisSpeakerClaimInput,
  type JarvisSpeakerClaimResult,
  type JarvisSpeechConfirmationInput,
  type JarvisSpeechConfirmationResult,
  type JarvisSpeechReleaseInput,
  type JarvisSpeechReleaseResult,
  type JarvisTaskDeskNavigation,
  type JarvisTaskDeskNavigationResult,
  type JarvisTaskDeskState,
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
  acknowledgeJarvisVoiceReport,
  claimJarvisSpeaker,
  confirmJarvisReportSpoken,
  releaseJarvisReportSpeech,
  executeJarvisInstruction,
  getJarvisProjectVocabulary,
  getJarvisTaskDesk,
  manageJarvisProjectAlias,
  navigateJarvisTaskDesk,
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

export class JarvisMeshNodeExecutionUnavailableError extends Schema.TaggedErrorClass<JarvisMeshNodeExecutionUnavailableError>()(
  "JarvisMeshNodeExecutionUnavailableError",
  {
    nodeId: EnvironmentId,
    label: Schema.String,
    preset: Schema.Literals(["full", "controller", "headless"]),
  },
) {
  override get message(): string {
    return `${this.label} cannot execute Jarvis tasks (preset: ${this.preset}).`;
  }
}

export class JarvisMeshNodeCapabilitiesUnavailableError extends Schema.TaggedErrorClass<JarvisMeshNodeCapabilitiesUnavailableError>()(
  "JarvisMeshNodeCapabilitiesUnavailableError",
  {
    nodeId: EnvironmentId,
    label: Schema.String,
  },
) {
  override get message(): string {
    return `${this.label} capabilities could not be verified before executing a Jarvis task.`;
  }
}

export type JarvisMeshExecuteInput = Omit<
  JarvisExecuteInput,
  "projectId" | "projectRef" | "requestMetadata"
> & {
  readonly projectRef: JarvisProjectRef;
  readonly requestMetadata: JarvisRequestMetadata;
};

export type JarvisMeshNavigateTaskDeskInput = {
  readonly nodeId: EnvironmentId;
  readonly navigation: JarvisTaskDeskNavigation;
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

export type JarvisMeshAcknowledgeReportInput = {
  readonly nodeId: EnvironmentId;
  readonly input: JarvisAcknowledgeVoiceReportInput;
};

export type JarvisMeshClaimSpeakerInput = {
  readonly nodeId: EnvironmentId;
  readonly input: JarvisSpeakerClaimInput;
};

export type JarvisMeshConfirmReportSpokenInput = {
  readonly nodeId: EnvironmentId;
  readonly input: JarvisSpeechConfirmationInput;
};

export type JarvisMeshReleaseReportSpeechInput = {
  readonly nodeId: EnvironmentId;
  readonly input: JarvisSpeechReleaseInput;
};

type JarvisMeshOperationError<T> = T extends Effect.Effect<infer _A, infer E, infer _R> ? E : never;

type ExecuteError = JarvisMeshOperationError<ReturnType<typeof executeJarvisInstruction>>;
type TaskDeskError = JarvisMeshOperationError<ReturnType<typeof getJarvisTaskDesk>>;
type NavigationError = JarvisMeshOperationError<ReturnType<typeof navigateJarvisTaskDesk>>;
type AliasError = JarvisMeshOperationError<ReturnType<typeof manageJarvisProjectAlias>>;
type AcknowledgeError = JarvisMeshOperationError<ReturnType<typeof acknowledgeJarvisVoiceReport>>;
type ClaimSpeakerError = JarvisMeshOperationError<ReturnType<typeof claimJarvisSpeaker>>;
type ConfirmSpokenError = JarvisMeshOperationError<ReturnType<typeof confirmJarvisReportSpoken>>;
type ReleaseSpeechError = JarvisMeshOperationError<ReturnType<typeof releaseJarvisReportSpeech>>;

type NodeError =
  | EnvironmentNotRegisteredError
  | JarvisMeshNodeUnavailableError
  | JarvisMeshNodeExecutionUnavailableError
  | JarvisMeshNodeCapabilitiesUnavailableError;
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
  readonly getTaskDesk: (
    nodeId: EnvironmentId,
  ) => Effect.Effect<JarvisTaskDeskState, NodeError | TaskDeskError>;
  readonly navigateTaskDesk: (
    input: JarvisMeshNavigateTaskDeskInput,
  ) => Effect.Effect<JarvisTaskDeskNavigationResult, NodeError | NavigationError>;
  readonly manageProjectAlias: (
    input: JarvisMeshManageProjectAliasInput,
  ) => Effect.Effect<JarvisManageProjectAliasResult, NodeError | AliasError>;
  readonly acknowledgeReport: (
    input: JarvisMeshAcknowledgeReportInput,
  ) => Effect.Effect<JarvisAcknowledgeVoiceReportResult, NodeError | AcknowledgeError>;
  readonly claimSpeaker: (
    input: JarvisMeshClaimSpeakerInput,
  ) => Effect.Effect<JarvisSpeakerClaimResult, NodeError | ClaimSpeakerError>;
  readonly confirmReportSpoken: (
    input: JarvisMeshConfirmReportSpokenInput,
  ) => Effect.Effect<JarvisSpeechConfirmationResult, NodeError | ConfirmSpokenError>;
  readonly releaseReportSpeech: (
    input: JarvisMeshReleaseReportSpeechInput,
  ) => Effect.Effect<JarvisSpeechReleaseResult, NodeError | ReleaseSpeechError>;
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
    // A successful response from a pre-preset server has no jarvisNode field;
    // those servers remain full nodes for compatibility. A failed response is
    // handled by refresh's catalogError path and never gets a guessed preset.
    const capabilities =
      live.config.environment?.capabilities?.jarvisNode ?? jarvisNodeCapabilitiesForPreset("full");
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
    return {
      node: { ...currentNode, label: liveLabel, capabilities },
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
    const entry = yield* connectedNode(input.projectRef.nodeId);
    return yield* registry.run(
      input.projectRef.nodeId,
      Effect.gen(function* () {
        const capabilities = yield* request(WS_METHODS.serverGetConfig, {}).pipe(
          Effect.map(
            (config) =>
              config.environment?.capabilities?.jarvisNode ??
              jarvisNodeCapabilitiesForPreset("full"),
          ),
          Effect.mapError(
            () =>
              new JarvisMeshNodeCapabilitiesUnavailableError({
                nodeId: input.projectRef.nodeId,
                label: entry.target.label,
              }),
          ),
        );
        if (!capabilities.execution) {
          return yield* new JarvisMeshNodeExecutionUnavailableError({
            nodeId: input.projectRef.nodeId,
            label: entry.target.label,
            preset: capabilities.preset,
          });
        }
        return yield* executeJarvisInstruction({
          ...input,
          projectId: input.projectRef.projectId,
          projectRef: input.projectRef,
          requestMetadata: input.requestMetadata,
        });
      }),
    );
  });

  const getTaskDesk = Effect.fn("JarvisMesh.getTaskDesk")(function* (nodeId: EnvironmentId) {
    yield* connectedNode(nodeId);
    return yield* registry.run(nodeId, getJarvisTaskDesk());
  });

  const navigateTaskDesk = Effect.fn("JarvisMesh.navigateTaskDesk")(function* (
    input: JarvisMeshNavigateTaskDeskInput,
  ) {
    yield* connectedNode(input.nodeId);
    return yield* registry.run(input.nodeId, navigateJarvisTaskDesk(input.navigation));
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

  const acknowledgeReport = Effect.fn("JarvisMesh.acknowledgeReport")(function* (
    input: JarvisMeshAcknowledgeReportInput,
  ) {
    yield* connectedNode(input.nodeId);
    return yield* registry.run(input.nodeId, acknowledgeJarvisVoiceReport(input.input));
  });

  const claimSpeaker = Effect.fn("JarvisMesh.claimSpeaker")(function* (
    input: JarvisMeshClaimSpeakerInput,
  ) {
    yield* connectedNode(input.nodeId);
    return yield* registry.run(input.nodeId, claimJarvisSpeaker(input.input));
  });

  const confirmReportSpoken = Effect.fn("JarvisMesh.confirmReportSpoken")(function* (
    input: JarvisMeshConfirmReportSpokenInput,
  ) {
    yield* connectedNode(input.nodeId);
    return yield* registry.run(input.nodeId, confirmJarvisReportSpoken(input.input));
  });

  const releaseReportSpeech = Effect.fn("JarvisMesh.releaseReportSpeech")(function* (
    input: JarvisMeshReleaseReportSpeechInput,
  ) {
    yield* connectedNode(input.nodeId);
    return yield* registry.run(input.nodeId, releaseJarvisReportSpeech(input.input));
  });

  return JarvisMesh.of({
    refresh,
    resolveProject: (query) =>
      Ref.get(catalogRef).pipe(Effect.map((catalog) => resolveJarvisMeshProject(catalog, query))),
    execute,
    getTaskDesk,
    navigateTaskDesk,
    manageProjectAlias: manageAlias,
    acknowledgeReport,
    claimSpeaker,
    confirmReportSpoken,
    releaseReportSpeech,
  });
});

export const layer = Layer.effect(JarvisMesh, make);
