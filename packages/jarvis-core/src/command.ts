import type {
  JarvisProjectAlias,
  JarvisNeedsInputReason,
  JarvisProjectRef,
  JarvisRequestMetadata,
  JarvisTaskRef,
  ModelSelection,
  OrchestrationProjectShell,
  OrchestrationThread,
  ProviderInteractionMode,
  ProjectId,
  RuntimeMode,
  ServerProvider,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { findPendingReply, resolveSpokenApprovalDecision } from "./confirmation.ts";
import { groundVoiceTurn, type VoiceProjectCandidate } from "./groundVoiceTurn.ts";

export type JarvisCommandTask = {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly title: string;
  readonly objective: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly state: "running" | "ready" | "failed" | "interrupted";
  readonly activeTurnId?: TurnId;
  readonly waitingFor?: "approval" | "input";
  readonly queuedFollowUps?: number;
  readonly taskRef?: JarvisTaskRef;
  readonly projectRef?: JarvisProjectRef;
};

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
  readonly project: OrchestrationProjectShell;
};

type TaskFocusTarget = {
  readonly type: "task";
  readonly task: JarvisTaskNavigationCandidate;
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
      readonly task: JarvisCommandTask;
      readonly instruction: string;
      readonly mode: "continuation" | "steer";
      readonly requestMetadata?: JarvisRequestMetadata;
    }
  | { readonly type: "queue"; readonly task: JarvisCommandTask; readonly instruction: string }
  | { readonly type: "stop"; readonly task: JarvisCommandTask }
  | { readonly type: "status"; readonly task: JarvisCommandTask; readonly message: string }
  | {
      readonly type: "review";
      readonly projectId: ProjectId;
      readonly sourceTask: JarvisCommandTask;
      readonly sourceOutput: string;
      readonly objective: string;
      readonly modelSelection: ModelSelection;
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
      readonly requestMetadata?: JarvisRequestMetadata;
    }
  | {
      readonly type: "reroute";
      readonly sourceTask: JarvisCommandTask;
      readonly targetProjectId: ProjectId;
      readonly objective: string;
      readonly modelSelection: ModelSelection;
      readonly interrupt?: { readonly turnId?: TurnId };
    }
  | { readonly type: "switch-focus"; readonly target: ProjectFocusTarget | TaskFocusTarget }
  | {
      readonly type: "answer";
      readonly task: JarvisCommandTask;
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
  readonly pendingModelSelection?: ModelSelection;
  readonly projectClarification?: {
    readonly candidates: ReadonlyArray<{
      readonly projectId: ProjectId;
      readonly label: string;
      readonly learnedAlias?: string;
    }>;
  };
  readonly taskClarification?: {
    readonly candidates: ReadonlyArray<{ readonly threadId: ThreadId; readonly label: string }>;
  };
};

export type JarvisCommandInterpretation =
  | { readonly status: "command"; readonly command: JarvisCommand }
  | JarvisCommandNeedsInput;

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

export const JarvisSemanticIntent = Schema.Struct({
  action: Schema.Literals([
    "start",
    "continue",
    "steer",
    "queue",
    "stop",
    "status",
    "review",
    "reroute",
    "focus-project",
    "focus-task",
    "list-projects",
  ]),
  project: Schema.NullOr(Schema.String),
  task: Schema.NullOr(Schema.String),
  instruction: Schema.NullOr(Schema.String),
  provider: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  effort: Schema.NullOr(Schema.String),
});
export type JarvisSemanticIntent = typeof JarvisSemanticIntent.Type;

const normalize = (value: string): string =>
  value
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();

const basename = (path: string): string =>
  path
    .replace(/[\\/]+$/u, "")
    .split(/[\\/]/u)
    .at(-1) ?? path;

const projectNames = (
  project: OrchestrationProjectShell,
  aliases: ReadonlyArray<JarvisProjectAlias>,
): ReadonlyArray<string> =>
  [
    project.title,
    basename(project.workspaceRoot),
    project.repositoryIdentity?.displayName,
    project.repositoryIdentity?.name,
    ...aliases.filter((alias) => alias.projectId === project.id).map((alias) => alias.alias),
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

const projectCandidates = (
  projects: ReadonlyArray<OrchestrationProjectShell>,
  aliases: ReadonlyArray<JarvisProjectAlias>,
): ReadonlyArray<VoiceProjectCandidate<OrchestrationProjectShell>> =>
  projects.map((project) => ({
    id: project.id,
    title: project.title,
    label: `${project.title} — ${basename(project.workspaceRoot)}`,
    names: projectNames(project, aliases),
    project,
  }));

type GroundingClarification = Extract<
  ReturnType<typeof groundVoiceTurn<OrchestrationProjectShell>>,
  { status: "needs-confirmation" | "needs-clarification" }
>;

const projectClarification = (grounded: GroundingClarification): JarvisCommandNeedsInput =>
  grounded.status === "needs-confirmation"
    ? {
        status: "needs-input",
        reason: "control-target-required",
        prompt: grounded.prompt,
        choices: [grounded.project.title],
        projectClarification: {
          candidates: [
            {
              projectId: grounded.project.id,
              label: grounded.project.title,
              learnedAlias: grounded.heard,
            },
          ],
        },
      }
    : {
        status: "needs-input",
        reason: "control-target-required",
        prompt: grounded.prompt,
        choices: grounded.candidates.map(({ label }) => label),
        projectClarification: {
          candidates: grounded.candidates.map(({ project, label, learnedAlias }) => ({
            projectId: project.id,
            label,
            ...(learnedAlias === undefined ? {} : { learnedAlias }),
          })),
        },
      };

export type PreparedJarvisSemanticTurn =
  | { readonly status: "ready"; readonly utterance: string; readonly projectId?: ProjectId }
  | JarvisCommandNeedsInput;

/** Acoustic grounding stays deterministic and precedes semantic interpretation. */
export function prepareJarvisSemanticTurn(input: JarvisCommandContext): PreparedJarvisSemanticTurn {
  const utterance = input.utterance.trim();
  if (!/[\p{Letter}\p{Number}]/u.test(utterance)) {
    return {
      status: "needs-input",
      reason: "unsupported-command",
      prompt: "I couldn't understand that command. State the task or control action you want.",
      choices: [],
    };
  }
  if (input.inputMode !== "voice" && input.confirmedProjectId === undefined) {
    return { status: "ready", utterance };
  }
  const grounded = groundVoiceTurn({
    utterance,
    candidates: projectCandidates(input.projects, input.aliases),
    mode: input.continueContext ? "explicit-only" : "explicit-or-inferred",
    ...(input.confirmedProjectId === undefined
      ? {}
      : { confirmedCandidateId: input.confirmedProjectId }),
  });
  if (grounded.status === "needs-confirmation" || grounded.status === "needs-clarification") {
    return projectClarification(grounded);
  }
  return grounded.status === "resolved"
    ? { status: "ready", utterance: grounded.utterance, projectId: grounded.project.id }
    : { status: "ready", utterance: grounded.utterance };
}

export function buildJarvisSemanticPrompt(
  input: JarvisCommandContext,
  prepared: Extract<PreparedJarvisSemanticTurn, { status: "ready" }>,
): string {
  const projects = input.projects.map((project) => ({
    name: project.title,
    aliases: projectNames(project, input.aliases).filter((name) => name !== project.title),
  }));
  const tasks = input.tasks.slice(0, 8).map((task) => ({
    title: task.title,
    objective: task.objective,
    state: task.state,
  }));
  const providers = input.providers.map((provider) => ({
    name: provider.displayName ?? provider.driver,
    aliases: [provider.driver],
    models: provider.models.map((model) => ({
      name: model.shortName ?? model.name,
      slug: model.slug,
      options: model.capabilities?.optionDescriptors?.flatMap((descriptor) =>
        descriptor.type === "select"
          ? [{ name: descriptor.label, values: descriptor.options.map((option) => option.label) }]
          : [],
      ),
    })),
  }));
  return [
    "Translate one Jarvis request into one structured semantic proposal.",
    "Return only the schema fields. Never invent or return internal IDs.",
    "Use exact catalog names when naming a project, task, provider, model, or effort.",
    "Use null when the user did not specify a field. Put the work or reply text in instruction.",
    "Actions: start, continue, steer, queue, stop, status, review, reroute, focus-project, focus-task, list-projects.",
    "The deterministic host validates all names, authority, availability, approvals, and dispatch.",
    "",
    `Request: ${prepared.utterance.slice(0, 16_000)}`,
    `Continue selected conversation: ${input.continueContext}`,
    `Current project: ${input.projects.find((project) => project.id === input.currentProjectId)?.title ?? "unknown"}`,
    `Projects: ${JSON.stringify(projects)}`,
    `Recent tasks: ${JSON.stringify(tasks)}`,
    `Providers: ${JSON.stringify(providers)}`,
  ].join("\n");
}

function needsFocus(): JarvisCommandNeedsInput {
  return {
    status: "needs-input",
    reason: "control-target-required",
    prompt: "I don't have a recent Jarvis task to apply that to.",
    choices: [],
  };
}

function statusMessage(task: JarvisCommandTask): string {
  if (task.waitingFor === "approval")
    return `${task.title} is waiting for your approval in ${task.projectTitle}.`;
  if (task.waitingFor === "input") return `${task.title} needs your input in ${task.projectTitle}.`;
  const queueSuffix =
    task.queuedFollowUps && task.queuedFollowUps > 0
      ? ` ${task.queuedFollowUps} follow-up${task.queuedFollowUps === 1 ? " is" : "s are"} queued.`
      : "";
  switch (task.state) {
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

function validateSelection(
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
      pendingModelSelection: selection,
    };
  }
  if (objective.trim().length === 0) {
    return {
      status: "needs-input",
      reason: "objective-missing",
      prompt: `What should the ${providerLabel(provider)} agent work on?`,
      choices: [],
      pendingModelSelection: selection,
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
  if (entity === null) return candidates[0] ?? needsFocus();
  const query = normalize(entity);
  const matches = candidates.filter((task) =>
    [task.title, task.objective].some((name) => normalize(name) === query),
  );
  if (matches.length === 1) return matches[0]!;
  const choices = (matches.length === 0 ? candidates : matches)
    .slice(0, 5)
    .map((task) => `${task.title} — ${task.state}: ${task.objective}`);
  return {
    status: "needs-input",
    reason: "control-target-required",
    prompt:
      matches.length === 0
        ? `I couldn't find a recent task named ${entity}.`
        : `I found more than one task named ${entity}.`,
    choices,
  };
}

function selectionFromIntent(
  intent: JarvisSemanticIntent,
  input: JarvisCommandContext,
  project: OrchestrationProjectShell,
  objective: string,
): ReturnType<typeof validateSelection> {
  if (input.modelSelection !== undefined) {
    return validateSelection(input.modelSelection, input.providers, objective);
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
      : validateSelection(
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
      : intent.model === null && provider.models.length === 1
        ? provider.models[0]
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
  return validateSelection(
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
      : { status: "command", command: { type: "switch-focus", target: { type: "task", task } } };
  }
  const project = resolveProject(input, prepared, intent.project);
  if ("status" in project) return project;
  if (intent.action === "focus-project") {
    return {
      status: "command",
      command: { type: "switch-focus", target: { type: "project", project } },
    };
  }

  const taskActions = new Set(["steer", "queue", "stop", "status", "reroute"]);
  const task = taskActions.has(intent.action) ? resolveCommandTask(input, intent.task) : undefined;
  if (task !== undefined && "status" in task) return task;
  if (intent.action === "status" && task !== undefined) {
    return { status: "command", command: { type: "status", task, message: statusMessage(task) } };
  }
  if (intent.action === "stop" && task !== undefined) {
    return { status: "command", command: { type: "stop", task } };
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
      : { status: "command", command: { type: "queue", task, instruction } };
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
            task,
            instruction,
            mode: "steer",
            ...(input.requestMetadata === undefined
              ? {}
              : { requestMetadata: input.requestMetadata }),
          },
        };
  }

  if (intent.action === "reroute" && task !== undefined) {
    const selection = validateSelection(
      withModelOptionDefaults(task.modelSelection, input.providers),
      input.providers,
      task.objective,
    );
    if (selection.status === "needs-input") return selection;
    return {
      status: "command",
      command: {
        type: "reroute",
        sourceTask: task,
        targetProjectId: project.id,
        objective: task.objective,
        modelSelection: selection.selection,
        ...(task.state === "running"
          ? { interrupt: task.activeTurnId === undefined ? {} : { turnId: task.activeTurnId } }
          : {}),
      },
    };
  }

  const pending =
    input.contextThread === undefined ? null : findPendingReply(input.contextThread.activities);
  const shouldContinue = input.continueContext || intent.action === "continue" || pending !== null;
  if (shouldContinue) {
    if (input.contextThread === undefined || input.contextTask === undefined) {
      return {
        status: "needs-input",
        reason: "context-thread-required",
        prompt: "That conversation is no longer available. Choose a current task to continue.",
        choices: [],
      };
    }
    if (pending?.kind === "approval") {
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
          task: input.contextTask,
          instruction,
          reply: {
            type: "approval",
            requestId: pending.requestId,
            decision,
          },
        },
      };
    }
    if (pending?.kind === "user-input") {
      if (pending.questionIds.length === 0) {
        return {
          status: "needs-input",
          reason: "source-output-unavailable",
          prompt:
            "T3 could not identify the pending question. Open the task to answer it directly.",
          choices: [],
        };
      }
      return {
        status: "command",
        command: {
          type: "answer",
          task: input.contextTask,
          instruction,
          reply: { type: "input", requestId: pending.requestId, questionIds: pending.questionIds },
        },
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
        task: input.contextTask,
        instruction,
        mode: "continuation",
        ...(input.requestMetadata === undefined ? {} : { requestMetadata: input.requestMetadata }),
      },
    };
  }

  const selection = selectionFromIntent(intent, input, project, instruction);
  if (selection.status === "needs-input") return selection;
  if (intent.action === "review") {
    const sourceOutput = input.contextThread?.messages
      .findLast((message) => message.role === "assistant" && !message.streaming)
      ?.text.trim();
    if (!sourceOutput || input.contextTask === undefined) {
      return {
        status: "needs-input",
        reason: "source-output-unavailable",
        prompt: "The source task does not have a completed assistant output to review yet.",
        choices: [],
      };
    }
    return {
      status: "command",
      command: {
        type: "review",
        projectId: project.id,
        sourceTask: input.contextTask,
        sourceOutput,
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
