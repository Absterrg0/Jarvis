import {
  isProviderAvailable,
  type EnvironmentId,
  type JarvisProjectAlias,
  JarvisTaskCreatedActivityPayload,
  type JarvisRequestMetadata,
  type JarvisTaskDeskTask,
  type JarvisTaskRef,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ProjectId,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import {
  type JarvisCommandTask,
  type JarvisTaskNavigationCandidate,
} from "@t3tools/jarvis-core/command";
import { listPendingJarvisReplies } from "@t3tools/jarvis-core/confirmation";
import { deriveJarvisTaskState } from "@t3tools/jarvis-core/deriveTaskState";
import {
  findJarvisEffortDescriptor,
  resolveJarvisEffortDefaultOption,
} from "@t3tools/jarvis-core/modelChoice";
import { resolveJarvisProjectChoice } from "@t3tools/jarvis-core/projectChoice";
import { projectSemanticNames } from "@t3tools/jarvis-core/semantic";
import { tryBoundedLocalGrammarForEvidence } from "@t3tools/jarvis-core/localGrammar";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeTaskCreatedPayload = Schema.decodeUnknownOption(JarvisTaskCreatedActivityPayload);

export function taskTitle(objective: string): string {
  const withoutTerminalPunctuation = objective.replace(/[.!?]+$/u, "");
  return withoutTerminalPunctuation.length <= 80
    ? withoutTerminalPunctuation
    : `${withoutTerminalPunctuation.slice(0, 79)}…`;
}

function modelSelectionsMatch(left: ModelSelection, right: ModelSelection): boolean {
  if (left.instanceId !== right.instanceId || left.model !== right.model) return false;
  const leftOptions = left.options ?? [];
  const rightOptions = right.options ?? [];
  if (leftOptions.length !== rightOptions.length) return false;
  return leftOptions.every((option) =>
    rightOptions.some(
      (candidate) => candidate.id === option.id && candidate.value === option.value,
    ),
  );
}

function requestMetadataMatch(
  left: JarvisRequestMetadata | undefined,
  right: JarvisRequestMetadata,
): boolean {
  if (left?.requestId !== right.requestId) return false;
  if (left.inputMode !== right.inputMode) return false;
  if (left.sourceUtterance !== right.sourceUtterance) return false;
  return (
    left.origin?.originNodeId === right.origin?.originNodeId &&
    left.origin?.originInteractionId === right.origin?.originInteractionId
  );
}

function taskCreatedPayload(thread: OrchestrationThread) {
  const marker = thread.activities.findLast((activity) => activity.kind === "jarvis.task.created");
  return marker === undefined
    ? undefined
    : Option.getOrUndefined(decodeTaskCreatedPayload(marker.payload));
}

export function routedThreadMatches(input: {
  readonly thread: OrchestrationThread;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly objective: string;
  readonly modelSelection: ModelSelection;
  readonly requestMetadata: JarvisRequestMetadata;
}): boolean {
  if (
    input.thread.projectId !== input.projectId ||
    !modelSelectionsMatch(input.thread.modelSelection, input.modelSelection)
  ) {
    return false;
  }
  const marker = input.thread.activities.findLast(
    (activity) => activity.kind === "jarvis.task.created",
  );
  if (marker === undefined) return input.thread.title === input.title;
  const payload = Option.getOrUndefined(decodeTaskCreatedPayload(marker.payload));
  return (
    payload !== undefined &&
    payload.objective === input.objective &&
    requestMetadataMatch(payload.requestMetadata, input.requestMetadata)
  );
}

export function taskRefFor(
  executionNodeId: EnvironmentId | undefined,
  threadId: ThreadId,
): JarvisTaskRef | undefined {
  return executionNodeId === undefined ? undefined : { executionNodeId, threadId };
}

export const normalizeTaskDeskAnswer = (utterance: string): string =>
  utterance
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:]+$/u, "");

export const ordinalTaskChoice = (answer: string): number | undefined => {
  const normalized = normalizeTaskDeskAnswer(answer).replace(/^the\s+/u, "");
  return new Map([
    ["first", 0],
    ["first one", 0],
    ["1", 0],
    ["one", 0],
    ["second", 1],
    ["second one", 1],
    ["2", 1],
    ["two", 1],
    ["third", 2],
    ["third one", 2],
    ["3", 2],
    ["three", 2],
    ["fourth", 3],
    ["fourth one", 3],
    ["4", 3],
    ["four", 3],
    ["fifth", 4],
    ["fifth one", 4],
    ["5", 4],
    ["five", 4],
  ]).get(normalized);
};

export function commandTaskFromThread(input: {
  readonly thread: OrchestrationThread;
  readonly projectTitle: string;
  readonly executionNodeId?: EnvironmentId;
  readonly queuedFollowUps?: number;
}): JarvisCommandTask {
  const marker = taskCreatedPayload(input.thread);
  const pendings = listPendingJarvisReplies(input.thread.activities);
  const taskRef = marker?.taskRef ?? taskRefFor(input.executionNodeId, input.thread.id);
  return {
    threadId: input.thread.id,
    projectId: input.thread.projectId,
    projectTitle: input.projectTitle,
    title: input.thread.title,
    objective:
      marker?.objective ??
      input.thread.messages.find((message) => message.role === "user")?.text.trim() ??
      input.thread.title,
    state: deriveJarvisTaskState({
      latestTurn: input.thread.latestTurn,
      session: input.thread.session,
      hasPendingApprovals: pendings.some((pending) => pending.kind === "approval"),
      hasPendingUserInput: pendings.some((pending) => pending.kind === "user-input"),
    }),
    ...(input.queuedFollowUps === undefined || input.queuedFollowUps === 0
      ? {}
      : { queuedFollowUps: input.queuedFollowUps }),
    ...(taskRef === undefined ? {} : { taskRef }),
    ...(taskRef === undefined
      ? {}
      : { projectRef: { nodeId: taskRef.executionNodeId, projectId: input.thread.projectId } }),
  };
}

function navigationCandidateFromShell(input: {
  readonly thread: {
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly title: string;
    readonly modelSelection: ModelSelection;
    readonly latestTurn: OrchestrationThread["latestTurn"];
    readonly session: OrchestrationThread["session"];
    readonly hasPendingApprovals?: boolean;
    readonly hasPendingUserInput?: boolean;
  };
  readonly executionNodeId?: EnvironmentId;
  readonly taskRef?: JarvisTaskRef;
}): JarvisTaskNavigationCandidate {
  const taskRef = input.taskRef ?? taskRefFor(input.executionNodeId, input.thread.id);
  return {
    threadId: input.thread.id,
    title: input.thread.title,
    objective: input.thread.title,
    state: deriveJarvisTaskState(input.thread),
    projectId: input.thread.projectId,
    ...(taskRef === undefined ? {} : { taskRef }),
  };
}

export function navigationCandidateFromDesk(
  task: JarvisTaskDeskTask,
  liveThread?: {
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly title: string;
    readonly modelSelection: ModelSelection;
    readonly latestTurn: OrchestrationThread["latestTurn"];
    readonly session: OrchestrationThread["session"];
    readonly hasPendingApprovals?: boolean;
    readonly hasPendingUserInput?: boolean;
  },
): JarvisTaskNavigationCandidate | null {
  if (liveThread === undefined) return null;
  return navigationCandidateFromShell({
    thread: liveThread,
    taskRef: task.taskRef,
    executionNodeId: task.taskRef.executionNodeId,
  });
}

/**
 * Command-task view from lightweight shell data. Navigation, matching, and
 * clarification labels run on this; the selected task's full detail is
 * reloaded before execution, so the objective shown for unselected tasks
 * falls back to the shell title instead of hydrating every recent thread.
 */
export function commandTaskFromShell(input: {
  readonly thread: OrchestrationThreadShell;
  readonly projectTitle: string;
  readonly executionNodeId?: EnvironmentId;
  readonly taskRef?: JarvisTaskRef;
  readonly queuedFollowUps?: number;
}): JarvisCommandTask {
  const taskRef = input.taskRef ?? taskRefFor(input.executionNodeId, input.thread.id);
  return {
    threadId: input.thread.id,
    projectId: input.thread.projectId,
    projectTitle: input.projectTitle,
    title: input.thread.title,
    objective: input.thread.title,
    state: deriveJarvisTaskState(input.thread),
    ...(input.queuedFollowUps === undefined || input.queuedFollowUps === 0
      ? {}
      : { queuedFollowUps: input.queuedFollowUps }),
    ...(taskRef === undefined ? {} : { taskRef }),
    ...(taskRef === undefined
      ? {}
      : { projectRef: { nodeId: taskRef.executionNodeId, projectId: input.thread.projectId } }),
  };
}

/**
 * Bound on semantic supervisor attempts. The configured supervisor runs
 * first; at most two fallbacks follow so latency never grows unbounded.
 */
export const JARVIS_SEMANTIC_FALLBACK_MAX_ATTEMPTS = 2;

/** Honest prompt when every semantic candidate is unavailable. */
export const JARVIS_SEMANTIC_UNAVAILABLE_PROMPT =
  "My semantic model providers are unavailable right now. Check provider limits or choose another supervisor.";

/**
 * One supervisor attempt must not hold the whole turn. After this long the
 * candidate is treated as failed and the next provider runs.
 */
export const JARVIS_SEMANTIC_ATTEMPT_TIMEOUT_MS = 4_500;

const isOpencodeDriver = (driver: string): boolean => driver === "opencode";

function isUsableSemanticProvider(provider: ServerProvider): boolean {
  return (
    provider.enabled &&
    provider.installed &&
    provider.status === "ready" &&
    provider.auth.status !== "unauthenticated" &&
    isProviderAvailable(provider) &&
    provider.supportsTextGeneration !== false
  );
}

/**
 * Cheap-and-capable supervisor models by the provider family actually in use.
 * Ordered patterns; the first model whose slug matches wins, else the
 * provider's default. The supervisor is derived per provider, never pinned
 * globally, so an OpenCode user gets an OpenCode supervisor and a Codex user
 * gets a GPT one.
 */
const SUPERVISOR_MODEL_PREFERENCES: Readonly<Record<string, ReadonlyArray<RegExp>>> = {
  codex: [/luna/i, /sol/i, /gpt/i],
  opencode: [/flash/i, /haiku/i, /deepseek/i],
  claude: [/haiku/i, /sonnet/i],
  cursor: [/.+/],
  grok: [/fast/i, /grok/i],
};

function pickCheapSupervisorModel(provider: ServerProvider): string | undefined {
  const preferences = SUPERVISOR_MODEL_PREFERENCES[String(provider.driver)] ?? [/.+/];
  for (const pattern of preferences) {
    const match = provider.models.find((model) => pattern.test(model.slug));
    if (match !== undefined) return match.slug;
  }
  return (provider.models.find((model) => model.isDefault === true) ?? provider.models[0])?.slug;
}

export type JarvisSupervisorPlan = {
  /** Present when the active family should be served by the fx harness. */
  readonly fx?: { readonly model: string };
  /** Provider fallback selection, always populated from the active provider. */
  readonly provider: ModelSelection;
};

/**
 * Resolve the semantic supervisor from the provider the user is actually
 * using: the explicit per-turn selection, the node default agent, then the
 * legacy global supervisor as a last resort. Codex/Grok plan an fx call (the
 * caller verifies fx is authenticated). When the active selection names a
 * model on the chosen provider, the supervisor uses that running model; a
 * regex-picked "cheap" model is only a fallback, because that pick can name a
 * route the account cannot bill and strand every turn. Null only when no
 * usable provider exists, in which case the caller keeps its legacy path.
 */
export function resolveJarvisSupervisorPlan(input: {
  readonly activeSelection?: ModelSelection | undefined;
  readonly providers: ReadonlyArray<ServerProvider>;
}): JarvisSupervisorPlan | null {
  const usable = input.providers.filter(isUsableSemanticProvider);
  if (usable.length === 0) return null;
  const requested = input.activeSelection;
  const provider =
    (requested === undefined
      ? undefined
      : usable.find((candidate) => candidate.instanceId === requested.instanceId)) ?? usable[0];
  if (provider === undefined) return null;
  // Prefer the model the user is actually running. A regex-picked "cheap"
  // model can name a route the account cannot bill (observed: an OpenCode
  // supervisor model returning Insufficient balance while the agent model
  // worked), which strands every turn.
  const requestedModelOnProvider =
    requested !== undefined &&
    requested.instanceId === provider.instanceId &&
    provider.models.some((candidate) => candidate.slug === requested.model)
      ? requested.model
      : undefined;
  const model =
    requestedModelOnProvider ??
    pickCheapSupervisorModel(provider) ??
    (requested?.instanceId === provider.instanceId ? requested.model : undefined);
  if (model === undefined) return null;
  const selection: ModelSelection = { instanceId: provider.instanceId, model };
  const driver = String(provider.driver);
  return {
    ...(driver === "codex" || driver === "grok" ? { fx: { model } } : {}),
    provider: selection,
  };
}

/**
 * Ordered semantic candidates for one interpretation. The configured
 * supervisor stays first and runs unchanged when it succeeds; fallbacks use
 * the model each provider actually advertises (its default, else the first
 * listed) so a hardcoded driver default can never name a model the provider
 * does not offer. Effort resolves from that model's own descriptor. Opencode
 * sorts first among fallbacks because it is the fastest local path. Pure for
 * tests.
 */
export function selectJarvisSemanticCandidates(input: {
  readonly configured: ModelSelection;
  readonly providers: ReadonlyArray<ServerProvider>;
}): ReadonlyArray<ModelSelection> {
  const fallbacks = input.providers
    .filter(
      (provider) =>
        provider.instanceId !== input.configured.instanceId && isUsableSemanticProvider(provider),
    )
    .sort((left, right) => {
      const leftFast = isOpencodeDriver(String(left.driver)) ? 0 : 1;
      const rightFast = isOpencodeDriver(String(right.driver)) ? 0 : 1;
      return leftFast - rightFast;
    })
    .flatMap((provider) => {
      const model = provider.models.find((entry) => entry.isDefault === true) ?? provider.models[0];
      if (model === undefined) return [];
      const effort = findJarvisEffortDescriptor(model.capabilities?.optionDescriptors);
      if (effort === undefined) {
        return [
          {
            instanceId: provider.instanceId,
            model: model.slug,
          } satisfies ModelSelection,
        ];
      }
      const value = resolveJarvisEffortDefaultOption(effort);
      return [
        {
          instanceId: provider.instanceId,
          model: model.slug,
          ...(value === undefined ? {} : { options: [{ id: effort.id, value }] }),
        } satisfies ModelSelection,
      ];
    })
    .slice(0, JARVIS_SEMANTIC_FALLBACK_MAX_ATTEMPTS - 1);
  return [input.configured, ...fallbacks].slice(0, JARVIS_SEMANTIC_FALLBACK_MAX_ATTEMPTS);
}

/**
 * Resolve one spoken answer against a pending project frame. The offered
 * candidates answer the question that was asked; the full catalog lets the
 * user correct to any project by name without restating the request. The
 * matched text stays with the caller so an answer that still owns a command
 * can be rejected and run fresh instead of resuming the paused objective.
 */
export function resolveJarvisProjectClarificationChoice(input: {
  readonly answer: string;
  readonly candidates: ReadonlyArray<{ readonly projectId: ProjectId; readonly label: string }>;
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly aliases: ReadonlyArray<JarvisProjectAlias>;
}): { readonly projectId: ProjectId; readonly matchedText: string } | null {
  const projectsById = new Map(input.projects.map((project) => [project.id, project] as const));
  const offered = input.candidates.flatMap((candidate) => {
    const project = projectsById.get(candidate.projectId);
    return project === undefined
      ? []
      : [
          {
            projectId: candidate.projectId,
            choice: {
              title: candidate.label,
              label: candidate.label,
              names: projectSemanticNames(project, input.aliases),
            },
          },
        ];
  });
  const offeredMatch = resolveJarvisProjectChoice({
    answer: input.answer,
    candidates: offered.map(({ choice }) => choice),
    acceptsAffirmation: offered.length === 1,
  });
  if (
    offeredMatch !== null &&
    (offeredMatch.kind === "affirmation" || offeredMatch.kind === "ordinal")
  ) {
    const chosen = offered[offeredMatch.index];
    return chosen === undefined
      ? null
      : { projectId: chosen.projectId, matchedText: offeredMatch.matchedText };
  }
  const offeredIds = new Set(offered.map(({ projectId }) => projectId));
  const merged = [
    ...offered,
    ...input.projects
      .filter((project) => !offeredIds.has(project.id))
      .map((project) => ({
        projectId: project.id,
        choice: {
          title: project.title,
          label: project.title,
          names: projectSemanticNames(project, input.aliases),
        },
      })),
  ];
  const match = resolveJarvisProjectChoice({
    answer: input.answer,
    candidates: merged.map(({ choice }) => choice),
  });
  const chosen = match === null ? undefined : merged[match.index];
  return match === null || chosen === undefined
    ? null
    : { projectId: chosen.projectId, matchedText: match.matchedText };
}

/**
 * Whether an utterance is a complete bounded command over the node catalog.
 * Used to retire a stale clarification when the user stated new work instead
 * of answering, so a project name inside the new command never resumes the
 * paused objective.
 */
export function looksLikeJarvisBoundedCommand(input: {
  readonly utterance: string;
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly aliases: ReadonlyArray<JarvisProjectAlias>;
}): boolean {
  return (
    tryBoundedLocalGrammarForEvidence({
      source: input.utterance,
      projects: input.projects.map((project) => ({
        title: project.title,
        names: projectSemanticNames(project, input.aliases),
      })),
      tasks: [],
    }).status === "proposal"
  );
}
