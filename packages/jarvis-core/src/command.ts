import type {
  JarvisProjectAlias,
  JarvisNeedsInputReason,
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
import { findPendingReply, resolveSpokenApprovalDecision } from "./confirmation.ts";
import {
  JarvisSemanticIntent,
  normalizeSemanticName as normalize,
  projectSemanticNames as projectNames,
  semanticBasename as basename,
  type PreparedJarvisSemanticTurn,
} from "./semantic.ts";

export {
  buildJarvisSemanticPrompt,
  JarvisSemanticIntent,
  prepareJarvisSemanticTurn,
  type PreparedJarvisSemanticTurn,
} from "./semantic.ts";

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
  | { readonly type: "list-projects" };

export type JarvisCommandNeedsInput = {
  readonly status: "needs-input";
  readonly reason: JarvisNeedsInputReason;
  readonly prompt: string;
  readonly choices: ReadonlyArray<string>;
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
  | { readonly status: "command"; readonly command: JarvisCommand }
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

/** Answer a typed pending request without invoking the semantic supervisor. */
export function interpretPendingJarvisReply(
  input: JarvisCommandContext,
): JarvisCommandInterpretation | null {
  // A task clarification resumes the original control command. Selecting a
  // task that happens to be blocked must not turn "stop that task" into an
  // answer to its pending request.
  if (input.confirmedTaskId !== undefined) return null;
  if (input.contextThread === undefined || input.contextTask === undefined) return null;
  const pending = findPendingReply(input.contextThread.activities);
  if (pending === null) return null;
  const instruction = input.utterance.trim();
  if (pending.kind === "approval") {
    const decision = resolveSpokenApprovalDecision(input.utterance);
    if (decision === "clarify") {
      return {
        status: "needs-input",
        reason: "control-target-required",
        prompt: "That approval is still waiting. Say allow or deny.",
        choices: ["allow", "deny"],
      };
    }
    return {
      status: "command",
      command: {
        type: "answer",
        task: taskIdentity(input.contextTask),
        instruction,
        reply: { type: "approval", requestId: pending.requestId, decision },
      },
    };
  }
  if (pending.questionIds.length === 0) {
    return {
      status: "needs-input",
      reason: "source-output-unavailable",
      prompt: "T3 could not identify the pending question. Open the task to answer it directly.",
      choices: [],
    };
  }
  return {
    status: "command",
    command: {
      type: "answer",
      task: taskIdentity(input.contextTask),
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
  readonly currentProjectId: ProjectId;
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
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly supervisorModelSelection: ModelSelection;
  readonly nodeDefaultModelSelection?: ModelSelection | null;
  readonly modelSelection?: ModelSelection;
  readonly confirmedProjectId?: ProjectId;
  readonly continueContext: boolean;
  readonly inputMode?: "voice";
  readonly requestMetadata?: JarvisRequestMetadata;
};

function needsFocus(): JarvisCommandNeedsInput {
  return {
    status: "needs-input",
    reason: "control-target-required",
    prompt: "I don't have a recent Jarvis task to apply that to.",
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
    const option = descriptor.options.find((candidate) => candidate.isDefault === true);
    return option === undefined ? [] : [{ id: descriptor.id, value: option.id }];
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
  const effort = descriptors.find(
    (descriptor) =>
      descriptor.type === "select" &&
      /effort|reason|thought/iu.test(`${descriptor.id} ${descriptor.label}`),
  );
  if (effort?.type === "select" && !selected.some((option) => option.id === effort.id)) {
    return {
      status: "needs-input",
      reason: "effort-missing",
      prompt: `Choose a ${effort.label.toLocaleLowerCase()} level for ${model.shortName ?? model.name}.`,
      choices: effort.options.map((option) => option.id),
    };
  }
  if (objective.trim().length === 0) {
    return {
      status: "needs-input",
      reason: "objective-missing",
      prompt: `What should the ${providerLabel(provider)} agent work on?`,
      choices: [],
    };
  }
  return { status: "ready", selection, objective: objective.trim() };
}

function resolveProject(
  input: JarvisCommandContext,
  prepared: Extract<PreparedJarvisSemanticTurn, { status: "ready" }>,
  entity: string | null,
): OrchestrationProjectShell | JarvisCommandNeedsInput {
  if (prepared.projectId !== undefined) {
    const project = input.projects.find((candidate) => candidate.id === prepared.projectId);
    if (project !== undefined) return project;
  }
  if (entity === null) {
    const project = input.projects.find((candidate) => candidate.id === input.currentProjectId);
    return (
      project ?? {
        status: "needs-input",
        reason: "control-target-required",
        prompt: "Which project should receive that task?",
        choices: input.projects.map((candidate) => candidate.title),
      }
    );
  }
  const query = normalize(entity);
  const matches = input.projects.filter((project) =>
    projectNames(project, input.aliases).some((name) => normalize(name) === query),
  );
  if (matches.length === 1) return matches[0]!;
  const candidates = (matches.length === 0 ? input.projects : matches).slice(0, 5);
  return {
    status: "needs-input",
    reason: "control-target-required",
    prompt:
      matches.length === 0
        ? `I couldn't match ${entity} to a project.`
        : `More than one project is named ${entity}. Which one did you mean?`,
    choices: candidates.map((project) => `${project.title} — ${basename(project.workspaceRoot)}`),
    projectClarification: {
      candidates: candidates.map((project) => ({
        projectId: project.id,
        label: `${project.title} — ${basename(project.workspaceRoot)}`,
      })),
    },
  };
}

function resolveNavigationTask(
  entity: string | null,
  tasks: ReadonlyArray<JarvisTaskNavigationCandidate>,
): JarvisTaskNavigationCandidate | JarvisCommandNeedsInput {
  const query = normalize(entity ?? "");
  const matches = tasks.filter((task) =>
    [task.title, task.objective, ...(task.voiceAliases ?? [])].some(
      (name) => normalize(name) === query,
    ),
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
  const candidates = [
    input.contextTask,
    input.referenceTask,
    input.focusedTask,
    ...(input.recentCommandTasks ?? []),
  ].filter(
    (task, index, all): task is JarvisCommandTask =>
      task !== undefined &&
      all.findIndex((candidate) => candidate?.threadId === task.threadId) === index,
  );
  if (input.confirmedTaskId !== undefined) {
    const confirmed = candidates.find((task) => task.threadId === input.confirmedTaskId);
    if (confirmed !== undefined) return confirmed;
  }
  if (entity === null) return candidates[0] ?? needsFocus();
  const query = normalize(entity);
  const matches = candidates.filter((task) =>
    [task.title, task.objective].some((name) => normalize(name) === query),
  );
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

function selectionFromIntent(
  intent: JarvisSemanticIntent,
  input: JarvisCommandContext,
  project: OrchestrationProjectShell,
  objective: string,
): ReturnType<typeof validateJarvisModelSelection> {
  if (input.modelSelection !== undefined) {
    return validateJarvisModelSelection(input.modelSelection, input.providers, objective);
  }
  if (intent.provider === null) {
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
  const providerMatches = input.providers.filter((provider) =>
    providerNames(provider).some((name) => normalize(name) === normalize(intent.provider!)),
  );
  if (providerMatches.length !== 1) {
    return {
      status: "needs-input",
      reason: "provider-not-found",
      prompt: `${intent.provider} is not one configured provider.`,
      choices: input.providers.filter(available).map(providerLabel),
    };
  }
  const provider = providerMatches[0]!;
  const modelMatches = provider.models.filter((model) =>
    [model.slug, model.name, model.shortName]
      .filter((name): name is string => typeof name === "string")
      .some((name) => normalize(name) === normalize(intent.model ?? "")),
  );
  const model =
    modelMatches.length === 1
      ? modelMatches[0]
      : intent.model === null
        ? (provider.models.find((candidate) => candidate.isDefault === true) ??
          (provider.models.length === 1 ? provider.models[0] : undefined))
        : undefined;
  if (model === undefined) {
    return {
      status: "needs-input",
      reason: "model-unavailable",
      prompt: `Choose one ${providerLabel(provider)} model.`,
      choices: provider.models.map((candidate) => candidate.slug),
    };
  }
  const options = model.capabilities?.optionDescriptors?.flatMap((descriptor) => {
    if (descriptor.type !== "select") return [];
    if (intent.effort === null) {
      const value = descriptor.options.find((option) => option.isDefault === true);
      return value === undefined ? [] : [{ id: descriptor.id, value: value.id }];
    }
    if (!/effort|reason|thought/iu.test(`${descriptor.id} ${descriptor.label}`)) return [];
    const value = descriptor.options.find(
      (option) =>
        normalize(option.id) === normalize(intent.effort!) ||
        normalize(option.label) === normalize(intent.effort!),
    );
    return value === undefined ? [] : [{ id: descriptor.id, value: value.id }];
  });
  return validateJarvisModelSelection(
    { instanceId: provider.instanceId, model: model.slug, ...(options?.length ? { options } : {}) },
    input.providers,
    objective,
  );
}

/** Validate one model proposal against authoritative catalogs and typed state. */
export function interpretJarvisCommand(
  input: JarvisCommandContext,
  prepared: Extract<PreparedJarvisSemanticTurn, { status: "ready" }>,
  intent: JarvisSemanticIntent,
): JarvisCommandInterpretation {
  if (intent.action === "list-projects") {
    return { status: "command", command: { type: "list-projects" } };
  }
  if (intent.action === "focus-task") {
    const task = resolveNavigationTask(intent.task, input.tasks);
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
    taskActions.has(intent.action) ||
    ((intent.action === "continue" || intent.action === "review") && intent.task !== null);
  const task = shouldResolveNamedTask ? resolveCommandTask(input, intent.task) : undefined;
  if (task !== undefined && "status" in task) return task;
  if (intent.action === "status" && task !== undefined) {
    return {
      status: "command",
      command: { type: "status", task: taskIdentity(task) },
    };
  }
  if (intent.action === "stop" && task !== undefined) {
    return { status: "command", command: { type: "stop", task: taskIdentity(task) } };
  }
  const instruction = intent.instruction?.trim() ?? "";
  if (intent.action === "queue" && task !== undefined) {
    return instruction.length === 0
      ? {
          status: "needs-input",
          reason: "objective-missing",
          prompt: "What should Jarvis do after that task?",
          choices: [],
        }
      : { status: "command", command: { type: "queue", task: taskIdentity(task), instruction } };
  }
  if (intent.action === "steer" && task !== undefined) {
    return instruction.length === 0
      ? {
          status: "needs-input",
          reason: "objective-missing",
          prompt: "What should change in the running task?",
          choices: [],
        }
      : {
          status: "command",
          command: {
            type: "continue",
            task: taskIdentity(task),
            instruction,
            mode: "steer",
            taskSelection: "explicit",
            ...(input.requestMetadata === undefined
              ? {}
              : { requestMetadata: input.requestMetadata }),
          },
        };
  }
  if (intent.action === "continue" && task !== undefined) {
    return instruction.length === 0
      ? {
          status: "needs-input",
          reason: "objective-missing",
          prompt: "What should that task do next?",
          choices: [],
        }
      : {
          status: "command",
          command: {
            type: "continue",
            task: taskIdentity(task),
            instruction,
            mode: "continuation",
            taskSelection: "explicit",
            ...(input.requestMetadata === undefined
              ? {}
              : { requestMetadata: input.requestMetadata }),
          },
        };
  }

  const pendingInterpretation = interpretPendingJarvisReply(input);
  if (pendingInterpretation !== null) return pendingInterpretation;
  const shouldContinue =
    intent.action === "continue" || (input.continueContext && intent.action === "start");
  if (shouldContinue) {
    if (input.contextThread === undefined || input.contextTask === undefined) {
      return {
        status: "needs-input",
        reason: "context-thread-required",
        prompt: "That conversation is no longer available. Choose a current task to continue.",
        choices: [],
      };
    }
    if (instruction.length === 0) {
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
        task: taskIdentity(input.contextTask),
        instruction,
        mode: "continuation",
        taskSelection: "context",
        ...(input.requestMetadata === undefined ? {} : { requestMetadata: input.requestMetadata }),
      },
    };
  }

  const project = resolveProject(input, prepared, intent.project);
  if ("status" in project) return project;
  if (intent.action === "focus-project") {
    return {
      status: "command",
      command: { type: "switch-focus", target: { type: "project", projectId: project.id } },
    };
  }
  if (intent.action === "reroute" && task !== undefined) {
    return {
      status: "command",
      command: {
        type: "reroute",
        sourceTask: taskIdentity(task),
        targetProjectId: project.id,
      },
    };
  }

  const selection = selectionFromIntent(intent, input, project, instruction);
  if (selection.status === "needs-input") return selection;
  if (intent.action === "review") {
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
  if (intent.action !== "start") {
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
