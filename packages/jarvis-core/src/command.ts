import type {
  JarvisProjectAlias,
  JarvisModelDraft,
  JarvisNeedsInputReason,
  JarvisExpectedReply,
  JarvisProjectRef,
  JarvisRequestMetadata,
  JarvisTaskRef,
  JarvisTaskState,
  ModelSelection,
  OrchestrationProjectShell,
  OrchestrationThread,
  ProviderInteractionMode,
  ProjectId,
  RuntimeMode,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import {
  getPendingJarvisReplyState,
  isExpectedPendingReply,
  isExplicitSpokenApprovalAnswer,
  resolveSpokenApprovalDecision,
} from "./confirmation.ts";
import { groupJarvisAliasesByProject } from "./buildProjectVocabulary.ts";
import { findJarvisEffortDescriptor, resolveJarvisEffortDefaultOption } from "./modelChoice.ts";
import {
  normalizeSemanticName as normalize,
  projectSemanticNames as projectNames,
  semanticBasename as basename,
  resolveJarvisInstruction,
  type PreparedJarvisSemanticTurn,
} from "./semantic.ts";
import {
  validateSemanticProposal,
  type JarvisSemanticProposal,
  type JarvisSemanticProposalAction,
  type SemanticEvidenceCatalogs,
  type SemanticValidation,
} from "./semanticEvidence.ts";

export {
  buildJarvisFastSemanticPrompt,
  buildJarvisSemanticPrompt,
  prepareJarvisSemanticTurn,
  resolveJarvisInstruction,
  type JarvisHeardMention,
  type PreparedJarvisSemanticTurn,
} from "./semantic.ts";

export {
  decodeJarvisSemanticProposal,
  JarvisSemanticProposal,
  JarvisSemanticProposalAction,
  validateSemanticProposal,
  type SemanticEvidenceCatalogs,
  type SemanticEvidenceProject,
  type SemanticEvidenceProvider,
  type SemanticEvidenceTask,
  type SemanticRef,
  type SemanticRole,
  type SemanticSourceSpan,
  type SemanticValidatedProvider,
  type SemanticValidatedTarget,
  type SemanticValidatedTask,
  type SemanticValidation,
} from "./semanticEvidence.ts";

export type JarvisCommandTask = {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly title: string;
  readonly objective: string;
  readonly state: JarvisTaskState;
  readonly queuedFollowUps?: number;
  readonly taskRef?: JarvisTaskRef;
  readonly projectRef?: JarvisProjectRef;
};

/** Stable task identity carried by a closed command. Live task data is reloaded before execution. */
export type JarvisCommandTaskIdentity = Pick<
  JarvisCommandTask,
  "threadId" | "taskRef" | "projectRef"
>;

export type JarvisTaskNavigationCandidate = {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly objective: string;
  readonly state: string;
  readonly projectId?: ProjectId;
  readonly taskRef?: JarvisTaskRef;
  readonly voiceAliases?: ReadonlyArray<string>;
};

type ProjectFocusTarget = {
  readonly type: "project";
  readonly projectId: ProjectId;
};

type TaskFocusTarget = {
  readonly type: "task";
  readonly task: JarvisCommandTaskIdentity;
};

export type JarvisCommand =
  | {
      readonly type: "start";
      readonly projectId: ProjectId;
      readonly objective: string;
      readonly modelSelection: ModelSelection;
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
      readonly requestMetadata?: JarvisRequestMetadata;
      /** Questions run as conversation threads; absent means ordinary work. */
      readonly flow?: "conversation";
    }
  | {
      readonly type: "continue";
      readonly task: JarvisCommandTaskIdentity;
      readonly instruction: string;
      readonly mode: "continuation" | "steer";
      readonly taskSelection: "explicit" | "context";
      readonly requestMetadata?: JarvisRequestMetadata;
    }
  | {
      readonly type: "queue";
      readonly task: JarvisCommandTaskIdentity;
      readonly instruction: string;
    }
  | { readonly type: "stop"; readonly task: JarvisCommandTaskIdentity }
  | { readonly type: "status"; readonly task: JarvisCommandTaskIdentity }
  | {
      readonly type: "review";
      readonly projectId: ProjectId;
      readonly sourceTask: JarvisCommandTaskIdentity;
      readonly objective: string;
      readonly modelSelection: ModelSelection;
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
      readonly requestMetadata?: JarvisRequestMetadata;
    }
  | {
      readonly type: "reroute";
      readonly sourceTask: JarvisCommandTaskIdentity;
      readonly targetProjectId: ProjectId;
    }
  | { readonly type: "switch-focus"; readonly target: ProjectFocusTarget | TaskFocusTarget }
  | {
      readonly type: "answer";
      readonly task: JarvisCommandTaskIdentity;
      readonly instruction: string;
      readonly reply:
        | {
            readonly type: "approval";
            readonly requestId: string;
            readonly decision: "accept" | "decline";
          }
        | {
            readonly type: "input";
            readonly requestId: string;
            readonly questionIds: ReadonlyArray<string>;
          };
    }
  | { readonly type: "list-projects" }
  | {
      /** A general question answered directly: no project, task, or provider work. */
      readonly type: "converse";
      readonly instruction: string;
      readonly answer: string;
    };

export type JarvisCommandNeedsInput = {
  readonly status: "needs-input";
  readonly reason: JarvisNeedsInputReason;
  readonly prompt: string;
  readonly choices: ReadonlyArray<string>;
  readonly expectedReply?: JarvisExpectedReply;
  /** Partial typed provider/model selection for the next clarification step. */
  readonly modelDraft?: JarvisModelDraft;
  /** Binds the next answer to the saved frame this question belongs to. */
  readonly clarificationFrameId?: string;
  readonly projectClarification?: {
    readonly candidates: ReadonlyArray<{
      readonly projectId: ProjectId;
      readonly label: string;
      readonly learnedAlias?: string;
    }>;
  };
  readonly taskClarification?: {
    readonly candidates: ReadonlyArray<{
      readonly threadId: ThreadId;
      readonly taskRef?: JarvisTaskRef;
      readonly label: string;
    }>;
  };
};

export type JarvisCommandInterpretation =
  | {
      readonly status: "command";
      readonly command: JarvisCommand;
      /** Host-composed acceptance copy for speech only; never part of command authority. */
      readonly acknowledgement?: string;
    }
  | JarvisCommandNeedsInput;

function taskIdentity(task: JarvisCommandTask): JarvisCommandTaskIdentity {
  return {
    threadId: task.threadId,
    ...(task.taskRef === undefined ? {} : { taskRef: task.taskRef }),
    ...(task.projectRef === undefined ? {} : { projectRef: task.projectRef }),
  };
}

function navigationTaskIdentity(task: JarvisTaskNavigationCandidate): JarvisCommandTaskIdentity {
  return {
    threadId: task.threadId,
    ...(task.taskRef === undefined ? {} : { taskRef: task.taskRef }),
  };
}

/**
 * Answer a typed pending request without invoking the semantic supervisor.
 * Without a classified action this is the narrow deterministic prepass: only
 * a closed-grammar explicit approval verdict may answer, and only a single
 * approval pending. Everything else (controls, worker questions, anything
 * beyond a bare verdict) returns null so classification decides. With an
 * action, only reply-capable continuations may answer: the action comes from
 * the same parse interpretJarvisCommand consumes, so explicit controls keep
 * their ordinary policy and never become answers. Pin verification runs
 * before any none-handling in both modes, so a stale pin never degrades
 * into an unguarded semantic turn.
 */
export function interpretPendingJarvisReply(
  input: JarvisCommandContext,
  intentAction?: JarvisSemanticProposalAction,
): JarvisCommandInterpretation | null {
  // A task clarification resumes the original control command. Selecting a
  // task that happens to be blocked must not turn "stop that task" into an
  // answer to its pending request.
  if (input.confirmedTaskId !== undefined) return null;
  // Explicit new-direction and control intents are never replies: stop,
  // status, queue, review, reroute, focus, conversation, and new tasks keep
  // their early branches in the proposal below.
  if (intentAction !== undefined && intentAction !== "continue" && intentAction !== "steer") {
    return null;
  }
  let replyThread = input.contextThread;
  let replyTask = input.contextTask;
  let pendingState =
    replyThread === undefined ? null : getPendingJarvisReplyState(replyThread.activities);
  // The focused thread has nothing waiting but exactly one other task in the
  // session does: the reply belongs there. The client pin can only describe
  // the focused thread, so it never vetoes this fallback; a non-null pin on
  // the focused thread keeps its own authority.
  let fallbackReply = false;
  if (
    (pendingState === null || pendingState.status === "none") &&
    input.pendingReplyThread !== undefined &&
    input.pendingReplyTask !== undefined &&
    (input.expectedReply === undefined || input.expectedReply === null)
  ) {
    replyThread = input.pendingReplyThread;
    replyTask = input.pendingReplyTask;
    pendingState = getPendingJarvisReplyState(replyThread.activities);
    fallbackReply = true;
  }
  if (replyThread === undefined || replyTask === undefined || pendingState === null) return null;
  const expected = fallbackReply ? undefined : input.expectedReply;
  if (expected !== undefined) {
    if (expected === null) {
      // An explicit snapshot of "nothing waiting" rejects a newly opened
      // pending before it can be answered stale. Without a classified action
      // only an explicit approval verdict can be rejected deterministically;
      // anything else defers so controls keep their ordinary policy.
      if (pendingState.status !== "none") {
        if (
          intentAction === undefined &&
          isExplicitSpokenApprovalAnswer(input.utterance) === undefined
        ) {
          return null;
        }
        return {
          status: "needs-input",
          reason: "source-output-unavailable",
          prompt:
            "A new request is waiting on that task. Open the task to answer the current request.",
          choices: [],
        };
      }
    } else if (!isExpectedPendingReply(pendingState, expected)) {
      // A pinned answer is verified against the live unique pending: a
      // closed request answered late, or an answer landing after a new
      // request opened, is rejected instead of applied to the wrong request.
      // Unclassified non-verdicts defer to classification; classified
      // controls never reach this path.
      if (
        intentAction === undefined &&
        isExplicitSpokenApprovalAnswer(input.utterance) === undefined
      ) {
        return null;
      }
      return {
        status: "needs-input",
        reason: "source-output-unavailable",
        prompt:
          "That request is no longer waiting. Check the task and respond to the current request.",
        choices: [],
      };
    }
  }
  if (pendingState.status === "none") return null;
  if (pendingState.status === "ambiguous") {
    if (
      intentAction === undefined &&
      isExplicitSpokenApprovalAnswer(input.utterance) === undefined
    ) {
      return null;
    }
    return {
      status: "needs-input",
      reason: "source-output-unavailable",
      prompt:
        "More than one request is waiting on that task. Open the task to answer the current request.",
      choices: [],
    };
  }
  const pending = pendingState.pending;
  if (intentAction === undefined) {
    // Deterministic prepass: worker questions need classification to tell an
    // answer from a new direction, so only a bare approval verdict answers.
    if (pending.kind !== "approval") return null;
    const verdict = isExplicitSpokenApprovalAnswer(input.utterance);
    if (verdict === undefined) return null;
    const instruction = input.utterance.trim();
    return {
      status: "command",
      command: {
        type: "answer",
        task: taskIdentity(replyTask),
        instruction,
        reply: { type: "approval", requestId: pending.requestId, decision: verdict },
      },
    };
  }
  const instruction = input.utterance.trim();
  if (pending.kind === "approval") {
    const decision = resolveSpokenApprovalDecision(input.utterance);
    if (decision === "clarify") {
      return {
        status: "needs-input",
        reason: "control-target-required",
        prompt: "That approval is still waiting. Say allow or deny.",
        choices: ["allow", "deny"],
        expectedReply: { kind: "approval", requestId: pending.requestId },
      };
    }
    return {
      status: "command",
      command: {
        type: "answer",
        task: taskIdentity(replyTask),
        instruction,
        reply: { type: "approval", requestId: pending.requestId, decision },
      },
    };
  }
  if (pending.questionIds.length === 0) {
    return {
      status: "needs-input",
      reason: "source-output-unavailable",
      prompt: "ARIS could not identify the pending question. Open the task to answer it directly.",
      choices: [],
    };
  }
  return {
    status: "command",
    command: {
      type: "answer",
      task: taskIdentity(replyTask),
      instruction,
      reply: {
        type: "input",
        requestId: pending.requestId,
        questionIds: pending.questionIds,
      },
    },
  };
}

export type JarvisCommandContext = {
  readonly utterance: string;
  /** Ambient project. Absent for project-free conversation. */
  readonly currentProjectId?: ProjectId;
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly aliases: ReadonlyArray<JarvisProjectAlias>;
  readonly tasks: ReadonlyArray<JarvisTaskNavigationCandidate>;
  readonly recentCommandTasks?: ReadonlyArray<JarvisCommandTask>;
  readonly focusedTask?: JarvisCommandTask;
  readonly contextTask?: JarvisCommandTask;
  readonly referenceTask?: JarvisCommandTask;
  /** Exact task chosen from a prior deterministic clarification. */
  readonly confirmedTaskId?: ThreadId;
  readonly contextThread?: OrchestrationThread;
  /**
   * The unique session-wide thread with a waiting request, when the focused
   * thread has none. Lets a spoken answer reach the task that asked, even
   * while another task is focused.
   */
  readonly pendingReplyThread?: OrchestrationThread;
  readonly pendingReplyTask?: JarvisCommandTask;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly supervisorModelSelection: ModelSelection;
  readonly nodeDefaultModelSelection?: ModelSelection | null;
  readonly modelSelection?: ModelSelection;
  readonly confirmedProjectId?: ProjectId;
  readonly continueContext: boolean;
  readonly inputMode?: "voice";
  readonly requestMetadata?: JarvisRequestMetadata;
  /**
   * Client-pinned answer identity. Null means the snapshot explicitly saw no
   * unique pending request; undefined skips verification for legacy callers.
   */
  readonly expectedReply?: {
    readonly kind: "approval" | "input";
    readonly requestId: string;
  } | null;
};

function needsFocus(): JarvisCommandNeedsInput {
  return {
    status: "needs-input",
    reason: "control-target-required",
    prompt: "I don't have a recent ARIS task to apply that to.",
    choices: [],
  };
}

export function describeJarvisTaskStatus(task: JarvisCommandTask): string {
  const queueSuffix =
    task.queuedFollowUps && task.queuedFollowUps > 0
      ? ` ${task.queuedFollowUps} follow-up${task.queuedFollowUps === 1 ? " is" : "s are"} queued.`
      : "";
  switch (task.state) {
    case "waiting-for-approval":
      return `${task.title} is waiting for your approval in ${task.projectTitle}.`;
    case "waiting-for-input":
      return `${task.title} needs your input in ${task.projectTitle}.`;
    case "running":
      return `${task.title} is still running in ${task.projectTitle}.${queueSuffix}`;
    case "ready":
      return `${task.title} has finished in ${task.projectTitle}.`;
    case "failed":
      return `${task.title} failed in ${task.projectTitle}.`;
    case "interrupted":
      return `${task.title} was stopped in ${task.projectTitle}.`;
  }
}

const available = (provider: ServerProvider): boolean =>
  provider.enabled &&
  provider.installed &&
  provider.status === "ready" &&
  provider.auth.status !== "unauthenticated";

const providerNames = (provider: ServerProvider): ReadonlyArray<string> =>
  [provider.driver, provider.displayName].filter(
    (value): value is string => typeof value === "string",
  );

const providerLabel = (provider: ServerProvider): string => provider.displayName ?? provider.driver;

function withModelOptionDefaults(
  selection: ModelSelection,
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection {
  const model = providers
    .find((provider) => provider.instanceId === selection.instanceId)
    ?.models.find((candidate) => candidate.slug === selection.model);
  const defaults = model?.capabilities?.optionDescriptors?.flatMap((descriptor) => {
    if (descriptor.type !== "select") return [];
    const marked = descriptor.options.find((candidate) => candidate.isDefault === true);
    if (marked !== undefined) return [{ id: descriptor.id, value: marked.id }];
    // A missing effort level never asks: fall back to low/default/first so a
    // saved default without an effort choice still dispatches. Other
    // descriptors without a marked default stay missing for the provider.
    if (findJarvisEffortDescriptor([descriptor]) !== undefined) {
      const value = resolveJarvisEffortDefaultOption(descriptor);
      return value === undefined ? [] : [{ id: descriptor.id, value }];
    }
    return [];
  });
  if (!defaults?.length) return selection;
  const selected = new Set((selection.options ?? []).map((option) => option.id));
  return {
    ...selection,
    options: [
      ...(selection.options ?? []),
      ...defaults.filter((option) => !selected.has(option.id)),
    ],
  };
}

export function validateJarvisModelSelection(
  selection: ModelSelection,
  providers: ReadonlyArray<ServerProvider>,
  objective: string,
):
  | { readonly status: "ready"; readonly selection: ModelSelection; readonly objective: string }
  | JarvisCommandNeedsInput {
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  if (!provider) {
    return {
      status: "needs-input",
      reason: "provider-not-found",
      prompt: `The provider ${selection.instanceId} is not configured.`,
      choices: providers.filter(available).map(providerLabel),
    };
  }
  if (!available(provider)) {
    return {
      status: "needs-input",
      reason: "provider-unavailable",
      prompt: `${providerLabel(provider)} is not ready. Install, enable, and authenticate it before starting this task.`,
      choices: [],
    };
  }
  const model = provider.models.find((candidate) => candidate.slug === selection.model);
  if (!model) {
    return {
      status: "needs-input",
      reason: "model-unavailable",
      prompt: `${selection.model} is not available through ${providerLabel(provider)}.`,
      choices: provider.models.map((candidate) => candidate.slug),
      modelDraft: { instanceId: provider.instanceId },
    };
  }
  const descriptors = model.capabilities?.optionDescriptors ?? [];
  const selected = selection.options ?? [];
  const duplicate = selected.find(
    (option, index) => selected.findIndex((candidate) => candidate.id === option.id) !== index,
  );
  if (duplicate) {
    return {
      status: "needs-input",
      reason: "selection-unavailable",
      prompt: `The ${duplicate.id} setting was selected more than once.`,
      choices: [],
    };
  }
  const invalid = selected.find((option) => {
    const descriptor = descriptors.find((candidate) => candidate.id === option.id);
    return (
      descriptor === undefined ||
      (descriptor.type === "boolean"
        ? typeof option.value !== "boolean"
        : typeof option.value !== "string" ||
          !descriptor.options.some((choice) => choice.id === option.value))
    );
  });
  if (invalid) {
    return {
      status: "needs-input",
      reason: "selection-unavailable",
      prompt: `The ${invalid.id} setting is not available for ${model.shortName ?? model.name}.`,
      choices: [],
    };
  }
  const effort = findJarvisEffortDescriptor(descriptors);
  const effortSelected = effort === undefined || selected.some((option) => option.id === effort.id);
  // A missing effort level never asks: explicit valid values are preserved,
  // and a missing value resolves to the provider-supported default below.
  // effort-missing is only ever answered for older pending drafts, never
  // produced for new selections.
  const effectiveSelection =
    effortSelected || effort === undefined
      ? selection
      : (() => {
          const value = resolveJarvisEffortDefaultOption(effort);
          if (value === undefined) return selection;
          return { ...selection, options: [...selected, { id: effort.id, value }] };
        })();
  if (objective.trim().length === 0) {
    return {
      status: "needs-input",
      reason: "objective-missing",
      prompt: `What should the ${providerLabel(provider)} agent work on?`,
      choices: [],
    };
  }
  return { status: "ready", selection: effectiveSelection, objective: objective.trim() };
}

/**
 * Bounded evidence catalogs for one proposal: project names (titles,
 * basenames, repository names, established aliases matched exactly),
 * task names (titles, objectives, voice aliases), and provider names.
 * The host resolves every cited value here; the model never sees IDs.
 */
function evidenceCatalogs(input: JarvisCommandContext): SemanticEvidenceCatalogs {
  const grouped = groupJarvisAliasesByProject(input.aliases);
  const tasks = new Map<string, { title: string; names: Set<string> }>();
  const addTask = (key: string, title: string, names: ReadonlyArray<string>): void => {
    const entry = tasks.get(key);
    if (entry === undefined) {
      tasks.set(key, { title, names: new Set(names) });
    } else {
      for (const name of names) entry.names.add(name);
    }
  };
  for (const task of commandTaskCandidates(input)) {
    addTask(String(task.threadId), task.title, [task.title, task.objective]);
  }
  for (const task of input.tasks) {
    addTask(String(task.threadId), task.title, [
      task.title,
      task.objective,
      ...(task.voiceAliases ?? []),
    ]);
  }
  return {
    projects: input.projects.map((project) => ({
      id: project.id,
      title: project.title,
      names: [...projectNames(project, grouped.get(project.id) ?? [])],
    })),
    tasks: [...tasks].map(([key, entry]) => ({ key, title: entry.title, names: [...entry.names] })),
    providers: input.providers.map((provider) => ({
      key: String(provider.instanceId),
      names: [...providerNames(provider)],
    })),
  };
}

function commandTaskCandidates(input: JarvisCommandContext): ReadonlyArray<JarvisCommandTask> {
  return [
    input.contextTask,
    input.referenceTask,
    input.focusedTask,
    ...(input.recentCommandTasks ?? []),
  ].filter(
    (task, index, all): task is JarvisCommandTask =>
      task !== undefined &&
      all.findIndex((candidate) => candidate?.threadId === task.threadId) === index,
  );
}

/**
 * The host determines steer versus continuation from typed task state,
 * never from model wording: direction to running work steers it, while a
 * settled or waiting task takes a new continuation turn.
 */
function continuationModeFor(task: JarvisCommandTask): "continuation" | "steer" {
  return task.state === "running" ? "steer" : "continuation";
}

function taskChoiceLabel(task: {
  readonly title: string;
  readonly state: string;
  readonly objective: string;
}): string {
  return `${task.title} — ${task.state}: ${task.objective}`;
}

function projectChoiceLabel(project: OrchestrationProjectShell): string {
  return `${project.title} — ${basename(project.workspaceRoot)}`;
}

function unknownProjectInput(text: string, input: JarvisCommandContext): JarvisCommandNeedsInput {
  return {
    status: "needs-input",
    reason: "control-target-required",
    prompt: `I couldn't match ${text} to a project.`,
    choices: input.projects.map((candidate) => candidate.title),
  };
}

function ambiguousProjectInput(
  text: string,
  candidates: ReadonlyArray<OrchestrationProjectShell>,
): JarvisCommandNeedsInput {
  return {
    status: "needs-input",
    reason: "control-target-required",
    prompt: `More than one project is named ${text}. Which one did you mean?`,
    choices: candidates.map(projectChoiceLabel),
    projectClarification: {
      candidates: candidates.map((project) => ({
        projectId: project.id,
        label: projectChoiceLabel(project),
      })),
    },
  };
}

function unheardProjectInput(
  value: string,
  candidates: ReadonlyArray<OrchestrationProjectShell>,
  input: JarvisCommandContext,
): JarvisCommandNeedsInput {
  const resolved = candidates.length === 0 ? input.projects : candidates;
  return {
    status: "needs-input",
    reason: "control-target-required",
    prompt: `I couldn't match ${value} to a project you named. Which project should I use?`,
    choices: resolved.map(projectChoiceLabel),
    projectClarification: {
      candidates: resolved.map((project) => ({
        projectId: project.id,
        label: projectChoiceLabel(project),
      })),
    },
  };
}

function taskClarificationCandidates(
  input: JarvisCommandContext,
  keys: ReadonlyArray<string> | undefined,
): ReadonlyArray<JarvisCommandTask> {
  const candidates = commandTaskCandidates(input);
  if (keys === undefined) return candidates.slice(0, 5);
  const matched = candidates.filter((task) => keys.includes(String(task.threadId)));
  return (matched.length === 0 ? candidates : matched).slice(0, 5);
}

function unknownTaskInput(
  text: string,
  input: JarvisCommandContext,
  keys: ReadonlyArray<string> | undefined,
  ambiguous: boolean,
): JarvisCommandNeedsInput {
  const candidates = taskClarificationCandidates(input, keys);
  const choices = candidates.map(taskChoiceLabel);
  return {
    status: "needs-input",
    reason: "control-target-required",
    prompt: ambiguous
      ? `I found more than one task named ${text}.`
      : `I couldn't find a recent task named ${text}.`,
    choices,
    taskClarification: {
      candidates: candidates.map((task, index) => ({
        threadId: task.threadId,
        ...(task.taskRef === undefined ? {} : { taskRef: task.taskRef }),
        label: choices[index]!,
      })),
    },
  };
}

function unknownProviderInput(text: string, input: JarvisCommandContext): JarvisCommandNeedsInput {
  return {
    status: "needs-input",
    reason: "provider-not-found",
    prompt: `${text} is not one configured provider.`,
    choices: input.providers.filter(available).map(providerLabel),
  };
}

function projectsByKeys(
  input: JarvisCommandContext,
  keys: ReadonlyArray<string>,
): ReadonlyArray<OrchestrationProjectShell> {
  return input.projects.filter((project) => keys.includes(String(project.id)));
}

/**
 * Map one validated proposal onto host clarification. Structural faults
 * and catalog misses never dispatch: cardinality faults name the one
 * action per turn, span faults fall back safely, and unknown or ambiguous
 * names ask with the exact heard text plus bounded candidates.
 */
function validationNeedsInput(
  validation: Exclude<SemanticValidation, { status: "valid" }>,
  input: JarvisCommandContext,
): JarvisCommandNeedsInput {
  switch (validation.status) {
    case "malformed":
      return validation.kind === "cardinality"
        ? {
            status: "needs-input",
            reason: "unsupported-command",
            prompt: "ARIS does one action per turn. Say the first step on its own.",
            choices: [],
          }
        : {
            // An untrustworthy span is not a dead end: give the user something
            // to pick instead of telling them the request could not be applied.
            status: "needs-input",
            reason: "control-target-required",
            prompt:
              input.projects.length > 0
                ? "I want to be sure I heard that right. Which project should I use?"
                : "I want to be sure I heard that right. Say the target again.",
            choices: input.projects.slice(0, 5).map((candidate) => candidate.title),
          };
    case "unknown":
      return validation.kind === "project"
        ? unknownProjectInput(validation.text, input)
        : validation.kind === "task"
          ? unknownTaskInput(validation.text, input, undefined, false)
          : unknownProviderInput(validation.text, input);
    case "ambiguous":
      return validation.kind === "project"
        ? ambiguousProjectInput(validation.text, projectsByKeys(input, validation.candidateKeys))
        : validation.kind === "task"
          ? unknownTaskInput(validation.text, input, validation.candidateKeys, true)
          : unknownProviderInput(validation.text, input);
    case "unheard":
      return validation.kind === "project"
        ? unheardProjectInput(
            validation.value,
            projectsByKeys(input, validation.candidateKeys),
            input,
          )
        : validation.kind === "task"
          ? unknownTaskInput(validation.value, input, validation.candidateKeys, false)
          : unknownProviderInput(validation.value, input);
  }
}

function staleControlProjectInput(input: JarvisCommandContext): JarvisCommandNeedsInput {
  const candidates = input.projects.slice(0, 5);
  return {
    status: "needs-input",
    reason: "control-target-required",
    prompt: "That project is no longer available. Which project did you mean?",
    choices: candidates.map((candidate) => candidate.title),
    projectClarification: {
      candidates: candidates.map((candidate) => ({
        projectId: candidate.id,
        label: candidate.title,
      })),
    },
  };
}

function missingControlProjectInput(
  input: JarvisCommandContext,
  action: "focus-project" | "reroute",
): JarvisCommandNeedsInput {
  const candidates = input.projects.slice(0, 5);
  return {
    status: "needs-input",
    reason: "control-target-required",
    prompt:
      action === "focus-project"
        ? "Which project should I switch to?"
        : "Which project should receive that task?",
    choices: candidates.map((candidate) => candidate.title),
    projectClarification: {
      candidates: candidates.map((candidate) => ({
        projectId: candidate.id,
        label: candidate.title,
      })),
    },
  };
}

function hasValidConfirmedProject(input: JarvisCommandContext): boolean {
  return (
    input.confirmedProjectId !== undefined &&
    input.projects.some((candidate) => candidate.id === input.confirmedProjectId)
  );
}

function resolveProject(
  input: JarvisCommandContext,
  target: { readonly id: ProjectId } | null,
  excludedProjectIds: ReadonlyArray<ProjectId>,
): OrchestrationProjectShell | JarvisCommandNeedsInput {
  // Typed explicit confirmations outrank any validated proposal: a project
  // chosen from a prior deterministic clarification (frame answer or
  // confirmed pronunciation) routes here even when the current proposal's
  // destination citation is unknown, ambiguous, or unheard. Generic ASR
  // evidence never overrides it. A stale confirmation never falls back to
  // ambient or to a validated guess: the catalog no longer names it.
  if (input.confirmedProjectId !== undefined) {
    const confirmed = input.projects.find((candidate) => candidate.id === input.confirmedProjectId);
    if (confirmed !== undefined) return confirmed;
    return staleControlProjectInput(input);
  }
  // The host owns project identity: a validated destination or correction
  // ref overrides any incidental mention outright. Without one, the turn
  // falls back to the ambient project unless an excluded ref vetoes it,
  // so refused work never dispatches where the user just ruled out.
  // A validated id that names nothing in the current catalog never falls
  // back to ambient: phantom identity always clarifies.
  if (target !== null) {
    const project = input.projects.find((candidate) => candidate.id === target.id);
    if (project !== undefined) return project;
    return staleControlProjectInput(input);
  }
  const ambient = input.projects.find((candidate) => candidate.id === input.currentProjectId);
  if (ambient !== undefined && excludedProjectIds.some((id) => id === ambient.id)) {
    const candidates = input.projects.slice(0, 5);
    return {
      status: "needs-input",
      reason: "control-target-required",
      prompt:
        "That request doesn't settle on a project I can confirm. Which project should receive that task?",
      choices: candidates.map((candidate) => candidate.title),
      projectClarification: {
        candidates: candidates.map((candidate) => ({
          projectId: candidate.id,
          label: candidate.title,
        })),
      },
    };
  }
  return (
    ambient ?? {
      status: "needs-input",
      reason: "control-target-required",
      prompt: "Which project should receive that task?",
      choices: input.projects.map((candidate) => candidate.title),
    }
  );
}

/**
 * Exact-first, then partial and space-insensitive name matching. Spoken task
 * names rarely reproduce a title verbatim; without this every near miss falls
 * back to asking for a number.
 */
function matchItemsByNames<T>(
  items: ReadonlyArray<T>,
  namesOf: (item: T) => ReadonlyArray<string>,
  entity: string,
): ReadonlyArray<T> {
  const query = normalize(entity);
  if (query.length === 0) return [];
  const compact = query.replace(/\s+/gu, "");
  const exact: T[] = [];
  const partial: T[] = [];
  for (const item of items) {
    const folded = namesOf(item)
      .map(normalize)
      .filter((name) => name.length > 0);
    if (folded.some((name) => name === query)) {
      exact.push(item);
      continue;
    }
    const near = folded.some((name) => {
      const nameCompact = name.replace(/\s+/gu, "");
      return (
        name.includes(query) ||
        query.includes(name) ||
        nameCompact.includes(compact) ||
        compact.includes(nameCompact)
      );
    });
    if (near) partial.push(item);
  }
  return exact.length > 0 ? exact : partial;
}

function resolveNavigationTask(
  entity: string | null,
  tasks: ReadonlyArray<JarvisTaskNavigationCandidate>,
): JarvisTaskNavigationCandidate | JarvisCommandNeedsInput {
  const matches =
    entity === null
      ? []
      : matchItemsByNames(
          tasks,
          (task) => [task.title, task.objective, ...(task.voiceAliases ?? [])],
          entity,
        );
  if (matches.length === 1) return matches[0]!;
  const candidates = (matches.length === 0 ? tasks : matches).slice(0, 5);
  const choices = candidates.map(
    (task, index) => `${index + 1}. ${task.title} — ${task.state}: ${task.objective}`,
  );
  return {
    status: "needs-input",
    reason: "control-target-required",
    prompt:
      entity === null
        ? "Which recent task did you mean?"
        : matches.length === 0
          ? `I couldn't find a recent task named ${entity}.`
          : `I found more than one task named ${entity}.`,
    choices,
    taskClarification: {
      candidates: candidates.map((task, index) => ({
        threadId: task.threadId,
        ...(task.taskRef === undefined ? {} : { taskRef: task.taskRef }),
        label: choices[index]!,
      })),
    },
  };
}

function resolveCommandTask(
  input: JarvisCommandContext,
  entity: string | null,
): JarvisCommandTask | JarvisCommandNeedsInput {
  const candidates = commandTaskCandidates(input);
  if (input.confirmedTaskId !== undefined) {
    const confirmed = candidates.find((task) => task.threadId === input.confirmedTaskId);
    if (confirmed !== undefined) return confirmed;
  }
  if (entity === null) return candidates[0] ?? needsFocus();
  const matches = matchItemsByNames(candidates, (task) => [task.title, task.objective], entity);
  if (matches.length === 1) return matches[0]!;
  const choices = (matches.length === 0 ? candidates : matches)
    .slice(0, 5)
    .map((task) => `${task.title} — ${task.state}: ${task.objective}`);
  const clarificationTasks = (matches.length === 0 ? candidates : matches).slice(0, 5);
  return {
    status: "needs-input",
    reason: "control-target-required",
    prompt:
      matches.length === 0
        ? `I couldn't find a recent task named ${entity}.`
        : `I found more than one task named ${entity}.`,
    choices,
    taskClarification: {
      candidates: clarificationTasks.map((task, index) => ({
        threadId: task.threadId,
        ...(task.taskRef === undefined ? {} : { taskRef: task.taskRef }),
        label: choices[index]!,
      })),
    },
  };
}

function selectionFromProposal(
  proposal: JarvisSemanticProposal,
  providerKey: string | null,
  input: JarvisCommandContext,
  project: OrchestrationProjectShell,
  objective: string,
): ReturnType<typeof validateJarvisModelSelection> {
  if (input.modelSelection !== undefined) {
    return validateJarvisModelSelection(input.modelSelection, input.providers, objective);
  }
  if (providerKey === null) {
    const fallback = input.nodeDefaultModelSelection ?? project.defaultModelSelection;
    return fallback === null || fallback === undefined
      ? {
          status: "needs-input",
          reason: "provider-not-found",
          prompt: "Choose a provider and model for this task.",
          choices: input.providers.filter(available).map(providerLabel),
        }
      : validateJarvisModelSelection(
          withModelOptionDefaults(fallback, input.providers),
          input.providers,
          objective,
        );
  }
  const provider = input.providers.find(
    (candidate) => String(candidate.instanceId) === providerKey,
  );
  if (provider === undefined) {
    return {
      status: "needs-input",
      reason: "provider-not-found",
      prompt: "Choose a provider and model for this task.",
      choices: input.providers.filter(available).map(providerLabel),
    };
  }
  const modelMatches = provider.models.filter((model) =>
    [model.slug, model.name, model.shortName]
      .filter((name): name is string => typeof name === "string")
      .some((name) => normalize(name) === normalize(proposal.model ?? "")),
  );
  const model =
    modelMatches.length === 1
      ? modelMatches[0]
      : proposal.model === null
        ? (provider.models.find((candidate) => candidate.isDefault === true) ??
          (provider.models.length === 1 ? provider.models[0] : undefined))
        : undefined;
  if (model === undefined) {
    return {
      status: "needs-input",
      reason: "model-unavailable",
      prompt: `Choose one ${providerLabel(provider)} model.`,
      choices: provider.models.map((candidate) => candidate.slug),
      modelDraft: { instanceId: provider.instanceId },
    };
  }
  const options = model.capabilities?.optionDescriptors?.flatMap((descriptor) => {
    if (descriptor.type !== "select") return [];
    if (proposal.effort === null) {
      const marked = descriptor.options.find((option) => option.isDefault === true);
      if (marked !== undefined) return [{ id: descriptor.id, value: marked.id }];
      if (findJarvisEffortDescriptor([descriptor]) !== undefined) {
        const value = resolveJarvisEffortDefaultOption(descriptor);
        return value === undefined ? [] : [{ id: descriptor.id, value }];
      }
      return [];
    }
    if (findJarvisEffortDescriptor([descriptor]) === undefined) return [];
    const value = descriptor.options.find(
      (option) =>
        normalize(option.id) === normalize(proposal.effort!) ||
        normalize(option.label) === normalize(proposal.effort!),
    );
    return value === undefined ? [] : [{ id: descriptor.id, value: value.id }];
  });
  return validateJarvisModelSelection(
    { instanceId: provider.instanceId, model: model.slug, ...(options?.length ? { options } : {}) },
    input.providers,
    objective,
  );
}

/**
 * Resolve the dispatch instruction deterministically from the traced
 * transcript. The proposal carries no wording: what dispatches is the
 * original text minus validated destination spans, on every path.
 */
function resolveDispatchInstruction(
  prepared: Extract<PreparedJarvisSemanticTurn, { status: "ready" }>,
  validation: Extract<SemanticValidation, { status: "valid" }>,
): string {
  return resolveJarvisInstruction(prepared.sourceUtterance, validation.deletions);
}

/**
 * A transcript that rules its own control out before naming it. Only the
 * leading position counts, and only an explicit control negation: a bare
 * discourse "no" belongs to corrections and never blocks.
 */
const LEADING_CONTROL_NEGATION = /^\s*(?:please\s+)?(?:don't|do not|never)\b/iu;

/**
 * Explicit destination wrapper for new work. The cited span must read as a
 * full routing wrapper (`in|to|at <name>`, optional trailing repo/project),
 * not merely contain a preposition somewhere ("about X" fails, a bare name
 * fails). Focus-project cites bare names by design and is exempt;
 * corrections never reach this branch as destinations.
 */
function isExplicitStartWrapper(spanText: string, value: string): boolean {
  const foldedSpan = spanText
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .toLocaleLowerCase("en-US");
  const foldedValue = value
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .toLocaleLowerCase("en-US");
  if (foldedSpan.length === 0 || foldedValue.length === 0) return false;
  const bodies = [
    foldedValue,
    `${foldedValue} repo`,
    `${foldedValue} repository`,
    `${foldedValue} project`,
  ];
  return ["in", "on", "at", "to"].some((prep) =>
    bodies.some((body) => foldedSpan === `${prep} ${body}` || foldedSpan === `${prep} the ${body}`),
  );
}

/** True when the thread is one of ARIS's durable conversation threads. */
function isJarvisConversationThread(thread: OrchestrationThread | undefined): boolean {
  if (thread === undefined) return false;
  return thread.activities.some((activity) => {
    if (activity.kind !== "jarvis.task.created") return false;
    const payload = activity.payload as { readonly flow?: unknown } | undefined;
    return payload?.flow === "conversation";
  });
}

/**
 * A follow-up in an active conversation never dead-ends on "one action per
 * turn": continue that thread with the raw utterance instead. Compounds are
 * still not executed, so this stays safe.
 */
function jarvisContinueContextConversation(
  input: JarvisCommandContext,
  prepared: Extract<PreparedJarvisSemanticTurn, { status: "ready" }>,
): JarvisCommandInterpretation | null {
  if (!isJarvisConversationThread(input.contextThread)) return null;
  const task = input.contextTask ?? input.focusedTask;
  const instruction = prepared.sourceUtterance.trim();
  if (task === undefined || instruction.length === 0) return null;
  return {
    status: "command",
    command: {
      type: "continue",
      task: taskIdentity(task),
      instruction,
      mode: continuationModeFor(task),
      taskSelection: "context",
      ...(input.requestMetadata === undefined ? {} : { requestMetadata: input.requestMetadata }),
    },
  };
}

/** Validate one model proposal against authoritative catalogs and typed state. */
function interpretJarvisCommandProposal(
  input: JarvisCommandContext,
  prepared: Extract<PreparedJarvisSemanticTurn, { status: "ready" }>,
  proposal: JarvisSemanticProposal,
): JarvisCommandInterpretation {
  // An explicit refusal never dispatches: compounds, negated destructive
  // controls, and anything unshaped as one action end here.
  if (proposal.action === "unsupported") {
    const conversation = jarvisContinueContextConversation(input, prepared);
    if (conversation !== null) return conversation;
    return {
      status: "needs-input",
      reason: "unsupported-command",
      prompt: "ARIS does one action per turn. Say the first step on its own.",
      choices: [],
    };
  }
  // Destructive controls need affirmative evidence. A transcript that opens
  // by ruling the control out ("don't stop …", "never move …") refuses a
  // stop or reroute proposal outright, so a misread model can never halt or
  // relocate work the user just protected. Corrections starting with a bare
  // "no" ("No, I meant …") are not leading negations and stay eligible.
  if (
    (proposal.action === "stop" || proposal.action === "reroute") &&
    LEADING_CONTROL_NEGATION.test(prepared.sourceUtterance)
  ) {
    return {
      status: "needs-input",
      reason: "unsupported-command",
      prompt: "I couldn't safely apply that request. Restate the task or control action.",
      choices: [],
    };
  }
  // One action per turn lives in explicit proposal bounds: the validator
  // rejects two destinations, two tasks, or two providers structurally, and
  // unsupported maps to needs-input above. No language heuristic vetoes a
  // turn here; out-of-grammar text declines in the parser and resolves
  // through the model plus validation instead.
  let validation = validateSemanticProposal({
    source: prepared.sourceUtterance,
    refs: proposal.refs,
    catalogs: evidenceCatalogs(input),
  });
  // The deterministic acoustic pass already resolved the heard project. When
  // the proposal cites that same span with the misheard text, the host
  // corrects it instead of asking the user to repeat a name the route knows.
  let groundedRewrite:
    | {
        readonly span: { readonly start: number; readonly end: number };
        readonly project: OrchestrationProjectShell;
      }
    | undefined;
  if (validation.status !== "valid") {
    // Typed explicit confirmations outrank generic proposal citations. A
    // project or task chosen from a prior deterministic clarification keeps
    // its authority when the current proposal cites a misheard, unknown, or
    // ambiguous name for the same slot (for example "Ripple" for confirmed
    // Rivvl, or duplicate "Authentication"). Only catalog misses for the
    // confirmed slot are retried with those refs removed; structural faults,
    // provider misses, and other slots still ask. Task refs never produce
    // deletions, so stripping them cannot change the dispatched wording.
    const missKind =
      validation.status === "unknown" ||
      validation.status === "ambiguous" ||
      validation.status === "unheard"
        ? validation.kind
        : null;
    const canOverrideProject =
      missKind === "project" &&
      input.confirmedProjectId !== undefined &&
      input.projects.some((candidate) => candidate.id === input.confirmedProjectId);
    const canOverrideTask =
      missKind === "task" &&
      input.confirmedTaskId !== undefined &&
      (commandTaskCandidates(input).some((task) => task.threadId === input.confirmedTaskId) ||
        input.tasks.some((task) => task.threadId === input.confirmedTaskId));
    const groundedProject =
      prepared.groundedProjectId === undefined
        ? undefined
        : input.projects.find((candidate) => candidate.id === prepared.groundedProjectId);
    const evidenceStart = prepared.asrEvidence?.start;
    const evidenceEnd = prepared.asrEvidence?.end;
    const canOverrideGrounded =
      missKind === "project" &&
      groundedProject !== undefined &&
      evidenceStart !== undefined &&
      evidenceEnd !== undefined &&
      proposal.refs.some(
        (ref) =>
          (ref.role === "destination" || ref.role === "correction") &&
          ref.span.start <= evidenceStart &&
          ref.span.end >= evidenceEnd,
      );
    if (canOverrideGrounded) {
      groundedRewrite = {
        span: { start: evidenceStart, end: evidenceEnd },
        project: groundedProject,
      };
    }
    if (canOverrideProject || canOverrideTask || groundedRewrite !== undefined) {
      const dropDestination = canOverrideProject || groundedRewrite !== undefined;
      const filteredRefs = proposal.refs.filter((ref) => {
        if ((ref.role === "destination" || ref.role === "correction") && dropDestination) {
          return false;
        }
        if (ref.role === "task" && canOverrideTask) return false;
        return true;
      });
      const retry = validateSemanticProposal({
        source: prepared.sourceUtterance,
        refs: filteredRefs,
        catalogs: evidenceCatalogs(input),
      });
      if (retry.status === "valid") {
        validation = retry;
      } else {
        if (retry.status === "malformed" && retry.kind === "cardinality") {
          const conversation = jarvisContinueContextConversation(input, prepared);
          if (conversation !== null) return conversation;
        }
        return validationNeedsInput(retry, input);
      }
    } else {
      if (validation.status === "malformed" && validation.kind === "cardinality") {
        const conversation = jarvisContinueContextConversation(input, prepared);
        if (conversation !== null) return conversation;
      }
      return validationNeedsInput(validation, input);
    }
  }
  // A new-work destination must read as an explicit routing wrapper, not an
  // incidental mention: only start and review derive a dispatch objective
  // from the surviving text, so only they are gated here. Focus-project
  // cites bare names by design, reroute carries no objective, and corrections
  // never reach this branch as destinations.
  if (validation.target !== null && (proposal.action === "start" || proposal.action === "review")) {
    const destination = proposal.refs.find((ref) => ref.role === "destination");
    if (
      destination !== undefined &&
      !isExplicitStartWrapper(destination.span.text, destination.value)
    ) {
      return {
        status: "needs-input",
        reason: "unsupported-command",
        prompt: "I couldn't safely apply that request. Restate the task or control action.",
        choices: [],
      };
    }
  }
  if (proposal.action === "list-projects") {
    return { status: "command", command: { type: "list-projects" } };
  }
  if (proposal.action === "converse") {
    const instruction = prepared.sourceUtterance.trim();
    const answer = proposal.answer?.trim() ?? "";
    if (instruction.length === 0 || answer.length === 0) {
      return {
        status: "needs-input",
        reason: "unsupported-command",
        prompt: "I couldn't answer that just now.",
        choices: [],
      };
    }
    // A follow-up while a conversation thread is in context continues that
    // thread instead of starting a new one, so the exchange keeps its history.
    const conversationFollowUp = isJarvisConversationThread(input.contextThread)
      ? (input.contextTask ?? input.focusedTask)
      : undefined;
    if (conversationFollowUp !== undefined) {
      return {
        status: "command",
        command: {
          type: "continue",
          task: taskIdentity(conversationFollowUp),
          instruction,
          mode: continuationModeFor(conversationFollowUp),
          taskSelection: "context",
          ...(input.requestMetadata === undefined
            ? {}
            : { requestMetadata: input.requestMetadata }),
        },
      };
    }
    const ambient = input.projects.find((candidate) => candidate.id === input.currentProjectId);
    if (ambient === undefined) {
      // No project in scope: the answer speaks inline with no durable thread.
      return {
        status: "command",
        command: { type: "converse", instruction, answer },
      };
    }
    // A question asked while a project is in scope runs as a durable provider
    // thread: the provider has tools, and the exchange stays visible and
    // reportable. The supervisor's inline answer is dropped; speaking it
    // would duplicate the provider's real answer.
    const { focusedTask: _focused, contextTask: _context, ...conversationContext } = input;
    const asConversation = interpretJarvisCommandProposal(
      { ...conversationContext, continueContext: false },
      prepared,
      {
        action: "start",
        refs: [],
        model: null,
        effort: null,
        answer: null,
      },
    );
    if (asConversation.status !== "command" || asConversation.command.type !== "start") {
      return asConversation;
    }
    return {
      ...asConversation,
      command: { ...asConversation.command, flow: "conversation" },
    };
  }
  if (proposal.action === "focus-task") {
    // A task chosen from a prior deterministic clarification keeps its
    // authority over the proposal's generic citation.
    if (input.confirmedTaskId !== undefined) {
      const confirmedNav = input.tasks.find((task) => task.threadId === input.confirmedTaskId);
      if (confirmedNav !== undefined) {
        return {
          status: "command",
          command: {
            type: "switch-focus",
            target: { type: "task", task: navigationTaskIdentity(confirmedNav) },
          },
        };
      }
      const confirmedCommand = commandTaskCandidates(input).find(
        (task) => task.threadId === input.confirmedTaskId,
      );
      if (confirmedCommand !== undefined) {
        return {
          status: "command",
          command: {
            type: "switch-focus",
            target: {
              type: "task",
              task: {
                threadId: confirmedCommand.threadId,
                ...(confirmedCommand.taskRef === undefined
                  ? {}
                  : { taskRef: confirmedCommand.taskRef }),
              },
            },
          },
        };
      }
    }
    const task = resolveNavigationTask(validation.task?.value ?? null, input.tasks);
    return "status" in task
      ? task
      : {
          status: "command",
          command: {
            type: "switch-focus",
            target: { type: "task", task: navigationTaskIdentity(task) },
          },
        };
  }
  const taskActions = new Set(["steer", "queue", "stop", "status", "reroute"]);
  const shouldResolveNamedTask =
    taskActions.has(proposal.action) ||
    ((proposal.action === "continue" || proposal.action === "review") && validation.task !== null);
  const task = shouldResolveNamedTask
    ? resolveCommandTask(input, validation.task?.value ?? null)
    : undefined;
  if (task !== undefined && "status" in task) return task;
  if (proposal.action === "status" && task !== undefined) {
    return {
      status: "command",
      command: { type: "status", task: taskIdentity(task) },
    };
  }
  if (proposal.action === "stop" && task !== undefined) {
    return { status: "command", command: { type: "stop", task: taskIdentity(task) } };
  }
  // The proposal carries no wording. What dispatches is always the
  // deterministic transcript resolution, never model text.
  let dispatchInstruction = resolveDispatchInstruction(prepared, validation);
  if (groundedRewrite !== undefined) {
    const { span, project: groundedProject } = groundedRewrite;
    dispatchInstruction =
      `${prepared.sourceUtterance.slice(0, span.start)}${groundedProject.title}${prepared.sourceUtterance.slice(span.end)}`.trim();
  }
  if (proposal.action === "queue" && task !== undefined) {
    if (dispatchInstruction.trim().length === 0) {
      return {
        status: "needs-input",
        reason: "objective-missing",
        prompt: "What should ARIS do after that task?",
        choices: [],
      };
    }
    // An ordinary follow-up keeps its queue intent on every task state: the
    // host dispatcher owns idle scheduling, so settled or waiting work still
    // queues instead of becoming an immediate continuation. Task state only
    // controls continue versus steer, never queue.
    return {
      status: "command",
      command: { type: "queue", task: taskIdentity(task), instruction: dispatchInstruction },
    };
  }
  if (proposal.action === "steer" && task !== undefined) {
    if (dispatchInstruction.trim().length === 0) {
      return {
        status: "needs-input",
        reason: "objective-missing",
        prompt: "What should change in the running task?",
        choices: [],
      };
    }
    return {
      status: "command",
      command: {
        type: "continue",
        task: taskIdentity(task),
        instruction: dispatchInstruction,
        mode: continuationModeFor(task),
        taskSelection: "explicit",
        ...(input.requestMetadata === undefined ? {} : { requestMetadata: input.requestMetadata }),
      },
    };
  }
  if (proposal.action === "continue" && task !== undefined) {
    if (dispatchInstruction.trim().length === 0) {
      return {
        status: "needs-input",
        reason: "objective-missing",
        prompt: "What should that task do next?",
        choices: [],
      };
    }
    return {
      status: "command",
      command: {
        type: "continue",
        task: taskIdentity(task),
        instruction: dispatchInstruction,
        mode: continuationModeFor(task),
        taskSelection: "explicit",
        ...(input.requestMetadata === undefined ? {} : { requestMetadata: input.requestMetadata }),
      },
    };
  }

  // A pending approval or question captures only reply-capable continuations
  // of its own task: continue and steer add content that can answer it. Task
  // actions (stop, status, queue, steer-with-task) return through their early
  // branches first, and new-direction commands must never be swallowed as
  // answers; eligibility lives in interpretPendingJarvisReply itself.
  const pendingInterpretation = interpretPendingJarvisReply(input, proposal.action);
  if (pendingInterpretation !== null) return pendingInterpretation;
  const followUpTask = input.contextTask ?? input.focusedTask;
  // A task that already has focus owns follow-up instructions: a start
  // proposal that names no destination continues it instead of opening a
  // second thread. Naming another project, or asking for a new task in
  // words, is the way out.
  const explicitNewTask = /\b(?:new|another|separate)\s+(?:task|thread|conversation)\b/iu.test(
    input.utterance,
  );
  // A provider request or a ruled-out project belongs to the ordinary start
  // path: continuing would drop the provider and could run where the user
  // just said not to.
  const namesDestination = proposal.refs.some(
    (ref) =>
      ref.role === "destination" ||
      ref.role === "correction" ||
      ref.role === "provider" ||
      ref.role === "excluded",
  );
  const implicitFollowUp =
    proposal.action === "start" &&
    !explicitNewTask &&
    !namesDestination &&
    (input.continueContext || followUpTask !== undefined);
  const shouldContinue = proposal.action === "continue" || implicitFollowUp;
  if (shouldContinue) {
    if (followUpTask === undefined) {
      return {
        status: "needs-input",
        reason: "context-thread-required",
        prompt: "That conversation is no longer available. Choose a current task to continue.",
        choices: [],
      };
    }
    if (dispatchInstruction.trim().length === 0) {
      return {
        status: "needs-input",
        reason: "objective-missing",
        prompt: "What should the current task do next?",
        choices: [],
      };
    }
    return {
      status: "command",
      command: {
        type: "continue",
        task: taskIdentity(followUpTask),
        instruction: dispatchInstruction,
        mode: continuationModeFor(followUpTask),
        taskSelection: "context",
        ...(input.requestMetadata === undefined ? {} : { requestMetadata: input.requestMetadata }),
      },
    };
  }

  // Control moves never choose ambient when target evidence is absent.
  // focus-project and reroute require an explicit validated destination or a
  // typed pending confirmed identity. An omitted ref, a subject-only mention,
  // an excluded-only mention, or an unknown typo carries no positive target
  // evidence, so the host clarifies instead of focusing or recreating work
  // where it already runs. Source wording is preserved verbatim for the next
  // turn; no phrase-specific patch authorizes a route.
  if (
    proposal.action === "focus-project" ||
    (proposal.action === "reroute" && task !== undefined)
  ) {
    if (validation.target === null && !hasValidConfirmedProject(input)) {
      return missingControlProjectInput(
        input,
        proposal.action === "focus-project" ? "focus-project" : "reroute",
      );
    }
  }
  // The grounded rewrite already owns the project; route it through the same
  // typed-confirmation path instead of falling back to the ambient project.
  const projectResolutionInput =
    groundedRewrite === undefined
      ? input
      : { ...input, confirmedProjectId: groundedRewrite.project.id };
  const project = resolveProject(
    projectResolutionInput,
    validation.target,
    validation.excludedProjectIds,
  );
  if ("status" in project) return project;
  if (proposal.action === "focus-project") {
    return {
      status: "command",
      command: { type: "switch-focus", target: { type: "project", projectId: project.id } },
    };
  }
  if (proposal.action === "reroute" && task !== undefined) {
    // A reroute without an explicit destination must ask: falling back to the
    // ambient project would silently recreate the task where it already runs.
    // A typed pending confirmation authorizes the move; ambient never does.
    if (validation.target === null && !hasValidConfirmedProject(input)) {
      return missingControlProjectInput(input, "reroute");
    }
    return {
      status: "command",
      command: {
        type: "reroute",
        sourceTask: taskIdentity(task),
        targetProjectId: project.id,
      },
    };
  }

  // New work dispatches the deterministic transcript resolution, validated
  // here for provider readiness. An empty resolution still asks what the
  // work is; stale catalog defaults can never invent wording.
  if (
    dispatchInstruction.trim().length === 0 &&
    (proposal.action === "start" || proposal.action === "review")
  ) {
    return {
      status: "needs-input",
      reason: "objective-missing",
      prompt: "What should that task work on?",
      choices: [],
    };
  }
  const selection = selectionFromProposal(
    proposal,
    validation.provider === null ? null : validation.provider.key,
    input,
    project,
    dispatchInstruction,
  );
  if (selection.status === "needs-input") return selection;
  if (proposal.action === "review") {
    const sourceTask = task ?? input.contextTask;
    if (sourceTask === undefined) {
      return {
        status: "needs-input",
        reason: "source-output-unavailable",
        prompt: "The source task is no longer available to review.",
        choices: [],
      };
    }
    return {
      status: "command",
      command: {
        type: "review",
        projectId: project.id,
        sourceTask: taskIdentity(sourceTask),
        objective: selection.objective,
        modelSelection: selection.selection,
        runtimeMode: "full-access",
        interactionMode: "default",
        ...(input.requestMetadata === undefined ? {} : { requestMetadata: input.requestMetadata }),
      },
    };
  }
  if (proposal.action !== "start") {
    return {
      status: "needs-input",
      reason: "unsupported-command",
      prompt: "I couldn't safely apply that request. Restate the task or control action.",
      choices: [],
    };
  }
  return {
    status: "command",
    command: {
      type: "start",
      projectId: project.id,
      objective: selection.objective,
      modelSelection: selection.selection,
      runtimeMode: "full-access",
      interactionMode: "default",
      ...(input.requestMetadata === undefined ? {} : { requestMetadata: input.requestMetadata }),
    },
  };
}

/** Attach host-composed presentation copy after deterministic validation succeeds. */
export function interpretJarvisCommand(
  input: JarvisCommandContext,
  prepared: Extract<PreparedJarvisSemanticTurn, { status: "ready" }>,
  proposal: JarvisSemanticProposal,
): JarvisCommandInterpretation {
  const interpretation = interpretJarvisCommandProposal(input, prepared, proposal);
  if (interpretation.status !== "command") {
    return interpretation;
  }
  const startsProviderWork =
    interpretation.command.type === "start" ||
    interpretation.command.type === "review" ||
    interpretation.command.type === "reroute" ||
    (interpretation.command.type === "continue" && interpretation.command.mode === "continuation");
  if (!startsProviderWork) return interpretation;
  return {
    ...interpretation,
    acknowledgement: composeJarvisAcknowledgement(interpretation.command, input),
  };
}

/**
 * Compose spoken acceptance from the accepted route: names the project or
 * task the command actually owns. Truthful by construction, since the route
 * was just validated against span evidence and bounded catalogs. No model
 * text ever reaches speech, so no generated-text validation is needed.
 * Falls back to fixed speech only when the catalog no longer names the target.
 */
function composeJarvisAcknowledgement(command: JarvisCommand, input: JarvisCommandContext): string {
  const projectTitle = (projectId: ProjectId): string | undefined =>
    input.projects.find((project) => project.id === projectId)?.title;
  if (command.type === "start" && command.flow === "conversation") {
    const accepted = projectTitle(command.projectId);
    return accepted === undefined ? "Looking into that." : `Looking into that in ${accepted}.`;
  }
  const accepted =
    command.type === "start" || command.type === "review"
      ? projectTitle(command.projectId)
      : command.type === "reroute"
        ? projectTitle(command.targetProjectId)
        : command.type === "continue"
          ? (taskTitleByThreadId(input, command.task.threadId) ?? "that task")
          : undefined;
  return accepted === undefined ? "Working on it." : `Request accepted for ${accepted}.`;
}

function taskTitleByThreadId(input: JarvisCommandContext, threadId: ThreadId): string | undefined {
  const tasks = [
    input.focusedTask,
    input.contextTask,
    input.referenceTask,
    ...(input.recentCommandTasks ?? []),
  ];
  return tasks.find((task) => task?.threadId === threadId)?.title;
}
