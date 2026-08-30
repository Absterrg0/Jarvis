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

/** Lightweight candidates are enough for a focus choice; dispatchable
 * commands always carry the richer `JarvisCommandTask` above. */
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
  | {
      readonly type: "queue";
      readonly task: JarvisCommandTask;
      readonly instruction: string;
    }
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
    readonly candidates: ReadonlyArray<{
      readonly threadId: ThreadId;
      readonly label: string;
    }>;
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
  readonly focusedTask?: JarvisCommandTask;
  readonly contextTask?: JarvisCommandTask;
  readonly referenceTask?: JarvisCommandTask;
  readonly contextThread?: OrchestrationThread;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly nodeDefaultModelSelection?: ModelSelection | null;
  readonly modelSelection?: ModelSelection;
  readonly confirmedProjectId?: ProjectId;
  readonly continueContext: boolean;
  readonly inputMode?: "voice";
  readonly requestMetadata?: JarvisRequestMetadata;
};

type ParsedRequest =
  | { readonly type: "list-projects" }
  | { readonly type: "status" }
  | { readonly type: "stop" }
  | { readonly type: "focus-project" }
  | { readonly type: "focus-task"; readonly entity: string }
  | { readonly type: "reroute" }
  | { readonly type: "queue"; readonly instruction: string }
  | { readonly type: "steer"; readonly instruction: string }
  | {
      readonly type: "start";
      readonly instruction: string;
      readonly explicitWorkerRouting: boolean;
    };

const politeLead = /^(?:jarvis[,.]?\s*)?(?:(?:hey|okay|ok|please)\s+)*(?:oh\s+)?/iu;
const queuePrefix =
  /^(?:(?:after|once|when)\s+(?:(?:that|it)(?:'s|\s+is)?\s+)?(?:done|finished|complete|completed)|after\s+that|then|next)\b/iu;
const taskFollowupPrefix =
  /^(?:(?:in|on|for)\s+)?(?:that|the\s+(?:same|current|last|previous))\s+(?:(?!(?:request|task|thread|conversation|run)\b)[\p{L}\p{N}'’-]+\s+){0,4}(?:request|task|thread|conversation|run)\b/iu;
const steerPrefix =
  /^(?:(?:oh\s+)?wait[,.]?\s*)?(?:also|actually|instead|correction|change\s+that\s+to)\b/iu;
const taskFocusPattern =
  /^(?:jarvis[,.]?\s*)?(?:switch|focus|go|return|take me)(?:\s+(?:back|over))?\s+(?:to|on)\s+(.+?)\s+(?:task|conversation|thread)$/iu;

function usefulInstruction(value: string, prefix?: RegExp): string {
  return value
    .replace(politeLead, "")
    .replace(prefix ?? /^$/u, "")
    .replace(/^[,.:;\s-]+/u, "")
    .replace(/^(?:(?:can|could|would|will)\s+you\s+)?please\s+/iu, "")
    .trim();
}

/** The only natural-language grammar pass used by the command interpreter. */
function parseRequest(utterance: string): ParsedRequest {
  const text = utterance.trim();
  const normalized = text.replace(politeLead, "");
  if (
    /\b(?:what|which)\s+projects?\s+(?:are\s+)?(?:there|available)\b|\b(?:list|show)\s+(?:me\s+)?(?:the\s+)?(?:available\s+)?projects?\b|\b(?:tell\s+me|do\s+I\s+have)\b[\s\S]*\bprojects?\b/iu.test(
      normalized,
    )
  ) {
    return { type: "list-projects" };
  }
  if (
    /^(?:what(?:'s| is) (?:it|that|the (?:agent|task)) (?:doing|working on)|where (?:is|are) (?:it|we)|status(?: update)?|how(?:'s| is) (?:it|that) going)\b/iu.test(
      normalized,
    )
  ) {
    return { type: "status" };
  }
  if (
    /^(?:stop|cancel|interrupt|halt|pause)\b(?:\s+(?:it|that|the (?:task|run|agent)))?/iu.test(
      normalized,
    )
  ) {
    return { type: "stop" };
  }
  const taskFocus = taskFocusPattern.exec(text);
  if (
    taskFocus?.[1] !== undefined &&
    !/\b(?:project|workspace|repo|repository)\b/iu.test(taskFocus[1])
  ) {
    return { type: "focus-task", entity: taskFocus[1].trim() };
  }
  if (
    /^(?:open|switch|move|go|focus)(?:\s+(?:me|us))?\s+(?:to|on|into)?\s*(?:the\s+)?[\s\S]*\b(?:project|workspace|repo)\b/iu.test(
      normalized,
    )
  ) {
    return { type: "focus-project" };
  }
  if (
    /\b(?:that|the\s+(?:last|previous|same)\s+(?:task|run)|same\s+(?:task|thing))\b[\s\S]*\b(?:in|inside|within|to)\b[\s\S]*\b(?:project|workspace|repo)\b/iu.test(
      normalized,
    ) ||
    /\b(?:run|do|restart|rerun|move)\b[\s\S]*\b(?:that|same|last|previous)\b[\s\S]*\b(?:in|inside|within|to)\b/iu.test(
      normalized,
    )
  ) {
    return { type: "reroute" };
  }
  const matchedQueuePrefix = queuePrefix.test(normalized)
    ? queuePrefix
    : taskFollowupPrefix.test(normalized)
      ? taskFollowupPrefix
      : undefined;
  if (matchedQueuePrefix !== undefined) {
    const instruction = usefulInstruction(text, matchedQueuePrefix);
    return instruction.length > 0
      ? { type: "queue", instruction }
      : { type: "start", instruction: text, explicitWorkerRouting: false };
  }
  if (steerPrefix.test(normalized) || /^(?:oh\s+)?wait[,.]?\s+/iu.test(normalized)) {
    const withoutWait = normalized.replace(/^(?:oh\s+)?wait[,.]?\s*/iu, "");
    const instruction = usefulInstruction(withoutWait, /^(?:also|actually|instead|correction)\b/iu);
    return instruction.length > 0
      ? { type: "steer", instruction }
      : { type: "start", instruction: text, explicitWorkerRouting: false };
  }
  return {
    type: "start",
    instruction: text,
    explicitWorkerRouting: /\b(?:use|with|through|spin\s+up)\b/iu.test(normalized),
  };
}

function basename(path: string): string {
  return (
    path
      .replace(/[\\/]+$/u, "")
      .split(/[\\/]/u)
      .at(-1) ?? path
  );
}

function projectCandidates(
  projects: ReadonlyArray<OrchestrationProjectShell>,
  aliases: ReadonlyArray<JarvisProjectAlias>,
): ReadonlyArray<VoiceProjectCandidate<OrchestrationProjectShell>> {
  return projects.map((project) => ({
    id: project.id,
    title: project.title,
    label: `${project.title} — ${basename(project.workspaceRoot)}`,
    names: [
      project.title,
      basename(project.workspaceRoot),
      project.repositoryIdentity?.displayName,
      project.repositoryIdentity?.name,
      ...aliases.filter((alias) => alias.projectId === project.id).map((alias) => alias.alias),
    ].filter((value): value is string => typeof value === "string" && value.trim().length > 0),
    project,
  }));
}

function projectNeedsInput(
  grounded:
    | ReturnType<typeof groundVoiceTurn<OrchestrationProjectShell>>
    | { readonly status: "not-mentioned" },
): JarvisCommandNeedsInput | undefined {
  if (grounded.status === "needs-confirmation") {
    return {
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
    };
  }
  if (grounded.status === "needs-clarification") {
    return {
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
  }
  return undefined;
}

function normalizeTaskText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

function taskChoices(tasks: ReadonlyArray<JarvisTaskNavigationCandidate>): ReadonlyArray<string> {
  return tasks
    .slice(0, 5)
    .map((task, index) => `${index + 1}. ${task.title} — ${task.state}: ${task.objective}`);
}

function taskFocusCommand(
  entity: string,
  tasks: ReadonlyArray<JarvisTaskNavigationCandidate>,
): JarvisCommandInterpretation {
  const queryTokens = normalizeTaskText(entity)
    .replace(/^the\s+/u, "")
    .split(" ")
    .filter(Boolean);
  const matches = tasks.filter((task) => {
    const searchable = normalizeTaskText(
      `${task.title} ${task.objective} ${task.state} ${task.taskRef?.remoteTaskId ?? ""}`,
    );
    const searchableTokens = new Set(searchable.split(" "));
    return queryTokens.every((token) => searchableTokens.has(token));
  });
  if (matches.length === 1)
    return {
      status: "command",
      command: { type: "switch-focus", target: { type: "task", task: matches[0]! } },
    };
  const candidates = matches.length === 0 ? tasks.slice(0, 5) : matches.slice(0, 5);
  return {
    status: "needs-input",
    reason: "control-target-required",
    prompt:
      matches.length === 0
        ? `I couldn't find a recent task matching “${entity}”.`
        : `I found more than one task matching “${entity}”. Which one did you mean?`,
    choices: taskChoices(candidates),
    taskClarification: {
      candidates: candidates.map((task, index) => ({
        threadId: task.threadId,
        label: taskChoices(candidates)[index]!,
      })),
    },
  };
}

function formatList(values: ReadonlyArray<string>): string {
  if (values.length === 0) return "No models";
  if (values.length === 1) return values[0] ?? "No models";
  return `${values.slice(0, -1).join(", ")} and ${values.at(-1)}`;
}

function sentenceCase(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase()}${value.slice(1)}`;
}

function providerNames(provider: ServerProvider): ReadonlyArray<string> {
  return [provider.instanceId, provider.driver, provider.displayName]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase());
}

function requestedProviderLabel(
  utterance: string,
  providers: ReadonlyArray<ServerProvider>,
): string | null {
  const match = utterance.match(
    /^\s*(?:jarvis[,\s:]+)?(?:(?:use|with|through|ask|have)\s+(?:the\s+)?|spin\s+up\s+(?:a|an|the)\s+)([\s\S]+)$/iu,
  );
  const remainder = match?.[1]?.trim();
  if (!remainder) return null;
  const normalized = remainder.toLowerCase();
  const aliases = providers
    .flatMap(providerNames)
    .sort((left, right) => right.length - left.length);
  const matched = aliases.find(
    (alias) =>
      normalized === alias ||
      normalized.startsWith(`${alias} `) ||
      normalized.startsWith(`${alias},`),
  );
  if (matched !== undefined) return matched;
  const token = remainder.split(/\s+/u)[0]?.replace(/[^a-zA-Z0-9_.-]/gu, "") ?? "";
  return token.length > 0 ? sentenceCase(token) : null;
}

function requestedModelLabel(utterance: string, provider: ServerProvider): string | null {
  const names = [...providerNames(provider)].sort((left, right) => right.length - left.length);
  const normalized = utterance.toLowerCase();
  const providerName = names.find((name) => normalized.includes(name));
  if (!providerName) return null;
  const remainder = utterance.slice(normalized.indexOf(providerName) + providerName.length).trim();
  const token = remainder.split(/\s+/u)[0]?.replace(/[^a-zA-Z0-9_.-]/gu, "") ?? "";
  const normalizedToken = token.toLowerCase();
  return normalizedToken.length > 0 &&
    !["agent", "low", "medium", "high", "xhigh", "max", "to"].includes(normalizedToken)
    ? token
    : null;
}

function requestedEffort(utterance: string): string | null {
  const tokens = new Set(
    utterance
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter(Boolean),
  );
  return (
    ["minimal", "low", "medium", "high", "xhigh", "max", "ultra", "ultrathink"].find((value) =>
      tokens.has(value),
    ) ?? null
  );
}

function available(provider: ServerProvider): boolean {
  return (
    provider.enabled &&
    provider.installed &&
    provider.status === "ready" &&
    provider.auth.status !== "unauthenticated"
  );
}

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
  if (defaults === undefined || defaults.length === 0) return selection;
  const selected = new Set((selection.options ?? []).map((option) => option.id));
  const options = [
    ...(selection.options ?? []),
    ...defaults.filter((option) => !selected.has(option.id)),
  ];
  return { ...selection, options };
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
    const ready = providers.filter(available);
    const labels = ready.map((candidate) => candidate.displayName ?? candidate.instanceId);
    return {
      status: "needs-input",
      reason: "provider-not-found",
      prompt: `The saved provider ${selection.instanceId} is no longer configured. ${formatList(labels)} ${labels.length === 1 ? "is" : "are"} available.`,
      choices: ready.map((candidate) => candidate.instanceId),
    };
  }
  if (!available(provider))
    return {
      status: "needs-input",
      reason: "provider-unavailable",
      prompt: `${provider.displayName ?? provider.instanceId} is not ready. Install, enable, and authenticate it before starting this task.`,
      choices: [],
    };
  const model = provider.models.find((candidate) => candidate.slug === selection.model);
  if (!model)
    return {
      status: "needs-input",
      reason: "model-unavailable",
      prompt: `The saved model ${selection.model} is no longer available through ${provider.displayName ?? provider.instanceId}. ${formatList(provider.models.map((candidate) => candidate.shortName ?? candidate.name))} ${provider.models.length === 1 ? "is" : "are"} available.`,
      choices: provider.models.map((candidate) => candidate.slug),
    };
  const descriptors = model.capabilities?.optionDescriptors ?? [];
  const selected = selection.options ?? [];
  const duplicate = selected.find(
    (option, index) => selected.findIndex((candidate) => candidate.id === option.id) !== index,
  );
  if (duplicate)
    return {
      status: "needs-input",
      reason: "selection-unavailable",
      prompt: `The saved ${duplicate.id} setting was selected more than once. Choose it again in Jarvis settings.`,
      choices: [],
    };
  const invalid = selected.find((option) => {
    const descriptor = descriptors.find((candidate) => candidate.id === option.id);
    if (!descriptor) return true;
    return descriptor.type === "boolean"
      ? typeof option.value !== "boolean"
      : typeof option.value !== "string" ||
          !descriptor.options.some((choice) => choice.id === option.value);
  });
  if (invalid)
    return {
      status: "needs-input",
      reason: "selection-unavailable",
      prompt: `The saved ${invalid.id} setting is no longer available for ${model.shortName ?? model.name}. Choose it again in Jarvis settings.`,
      choices: [],
    };
  const effort = descriptors.find(
    (descriptor) =>
      descriptor.type === "select" &&
      /effort|reason|thought/iu.test(`${descriptor.id} ${descriptor.label}`),
  );
  if (effort?.type === "select" && !selected.some((option) => option.id === effort.id))
    return {
      status: "needs-input",
      reason: "effort-missing",
      prompt: `Choose a ${effort.label.toLowerCase()} level for ${model.shortName ?? model.name} in Jarvis settings before starting a task.`,
      choices: effort.options.map((option) => option.id),
      pendingModelSelection: selection,
    };
  if (objective.trim().length === 0)
    return {
      status: "needs-input",
      reason: "objective-missing",
      prompt: `What should the ${provider.displayName ?? provider.instanceId} ${model.shortName ?? model.name} agent work on?`,
      choices: [],
      pendingModelSelection: selection,
    };
  return { status: "ready", selection, objective: sentenceCase(objective.trim()) };
}

function spokenSelection(
  utterance: string,
  providers: ReadonlyArray<ServerProvider>,
):
  | JarvisCommandInterpretation
  | { readonly selection: ModelSelection; readonly objective: string } {
  const normalized = utterance.toLowerCase();
  const requestedProvider = requestedProviderLabel(utterance, providers);
  const provider = requestedProvider
    ? providers.find((candidate) =>
        providerNames(candidate).some((name) => name === requestedProvider.toLowerCase()),
      )
    : providers.find((candidate) =>
        providerNames(candidate).some((name) => normalized.includes(name)),
      );
  if (!provider) {
    const ready = providers.filter(available);
    const labels = ready.map((candidate) => candidate.displayName ?? candidate.instanceId);
    return {
      status: "needs-input",
      reason: "provider-not-found",
      prompt: `${requestedProvider ?? "That provider"} is not configured. ${formatList(labels)} ${labels.length === 1 ? "is" : "are"} available.`,
      choices: ready.map((candidate) => candidate.instanceId),
    };
  }
  if (!available(provider))
    return {
      status: "needs-input",
      reason: "provider-unavailable",
      prompt: `${provider.displayName ?? provider.instanceId} is not ready. Install, enable, and authenticate it before starting this task.`,
      choices: [],
    };
  const explicitModel = provider.models.find((candidate) =>
    [candidate.slug, candidate.name, candidate.shortName]
      .filter((value): value is string => typeof value === "string")
      .some((value) => normalized.includes(value.toLowerCase())),
  );
  const requestedModel = requestedModelLabel(utterance, provider);
  const model =
    explicitModel ??
    (requestedModel === null && provider.models.length === 1 ? provider.models[0] : null);
  if (!model)
    return {
      status: "needs-input",
      reason: "model-unavailable",
      prompt: `${requestedModel ?? "That model"} is not available through ${provider.displayName ?? provider.instanceId}. ${formatList(provider.models.map((candidate) => candidate.shortName ?? candidate.name))} ${provider.models.length === 1 ? "is" : "are"} available.`,
      choices: provider.models.map((candidate) => candidate.slug),
    };
  const effort = requestedEffort(utterance);
  const effortDescriptor = model.capabilities?.optionDescriptors?.find(
    (descriptor) =>
      descriptor.type === "select" &&
      /effort|reason|thought/iu.test(`${descriptor.id} ${descriptor.label}`),
  );
  if (effort && !effortDescriptor)
    return {
      status: "needs-input",
      reason: "effort-unavailable",
      prompt: `${model.shortName ?? model.name} does not offer a configurable effort level. Remove ${sentenceCase(effort)} or choose another model.`,
      choices: [],
    };
  if (!effort && effortDescriptor?.type === "select")
    return {
      status: "needs-input",
      reason: "effort-missing",
      prompt: `Which effort level should ${model.shortName ?? model.name} use? ${formatList(effortDescriptor.options.map((option) => option.label))} are available.`,
      choices: effortDescriptor.options.map((option) => option.id),
    };
  if (
    effort &&
    effortDescriptor?.type === "select" &&
    !effortDescriptor.options.some(
      (option) => option.id.toLowerCase() === effort || option.label.toLowerCase() === effort,
    )
  )
    return {
      status: "needs-input",
      reason: "effort-unavailable",
      prompt: `${sentenceCase(effort)} is not available for ${model.shortName ?? model.name}. ${formatList(effortDescriptor.options.map((option) => option.label))} are available.`,
      choices: effortDescriptor.options.map((option) => option.id),
    };
  const options = model.capabilities?.optionDescriptors?.flatMap((descriptor) => {
    if (descriptor.type !== "select") return [];
    const selected = descriptor.options.find((option) =>
      normalized.includes(option.id.toLowerCase()),
    );
    return selected ? [{ id: descriptor.id, value: selected.id }] : [];
  });
  const objectiveMatch = utterance.match(/\b(?:agent\s+)?to\s+([\s\S]+)$/iu);
  if (!objectiveMatch?.[1])
    return {
      status: "needs-input",
      reason: "objective-missing",
      prompt: `What should the ${provider.displayName ?? provider.instanceId} ${model.shortName ?? model.name} agent work on?`,
      choices: [],
      pendingModelSelection: {
        instanceId: provider.instanceId,
        model: model.slug,
        ...(options && options.length > 0 ? { options } : {}),
      },
    };
  return {
    selection: {
      instanceId: provider.instanceId,
      model: model.slug,
      ...(options && options.length > 0 ? { options } : {}),
    },
    objective: sentenceCase(objectiveMatch[1].trim()),
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

function needsFocus(): JarvisCommandNeedsInput {
  return {
    status: "needs-input",
    reason: "control-target-required",
    prompt: "I don't have a recent Jarvis task to apply that to.",
    choices: [],
  };
}

/** Interpret one grounded turn into one closed semantic command. */
export function interpretJarvisCommand(input: JarvisCommandContext): JarvisCommandInterpretation {
  if (!/[\p{Letter}\p{Number}]/u.test(input.utterance)) {
    return {
      status: "needs-input",
      reason: "unsupported-command",
      prompt: "I couldn't understand that command. State the task or control action you want.",
      choices: [],
    };
  }
  const parsed = parseRequest(input.utterance);
  if (parsed.type === "list-projects")
    return { status: "command", command: { type: "list-projects" } };

  const shouldGround =
    input.confirmedProjectId !== undefined ||
    parsed.type === "focus-project" ||
    parsed.type === "reroute" ||
    (parsed.type === "start" && input.inputMode === "voice" && !input.continueContext);
  let selectedProjectId = input.currentProjectId;
  let groundedUtterance = input.utterance.trim();
  if (shouldGround) {
    const grounded = groundVoiceTurn({
      utterance: groundedUtterance,
      candidates: projectCandidates(input.projects, input.aliases),
      mode:
        parsed.type === "start" && input.inputMode === "voice" && !input.continueContext
          ? "explicit-or-inferred"
          : "explicit-only",
      ...(input.confirmedProjectId === undefined
        ? {}
        : { confirmedCandidateId: input.confirmedProjectId }),
    });
    const clarification = projectNeedsInput(grounded);
    if (clarification) return clarification;
    if (grounded.status === "resolved") {
      selectedProjectId = grounded.project.id;
      groundedUtterance = grounded.utterance;
    }
  }
  const project = input.projects.find((candidate) => candidate.id === selectedProjectId);

  if (parsed.type === "focus-project") {
    return project === undefined
      ? {
          status: "needs-input",
          reason: "control-target-required",
          prompt: "Which project should receive new tasks?",
          choices: [],
        }
      : {
          status: "command",
          command: { type: "switch-focus", target: { type: "project", project } },
        };
  }
  if (parsed.type === "focus-task") return taskFocusCommand(parsed.entity, input.tasks);

  const focused = input.contextTask ?? input.referenceTask ?? input.focusedTask;
  if (parsed.type === "status")
    return focused === undefined
      ? needsFocus()
      : {
          status: "command",
          command: { type: "status", task: focused, message: statusMessage(focused) },
        };
  if (parsed.type === "stop")
    return focused === undefined
      ? needsFocus()
      : { status: "command", command: { type: "stop", task: focused } };
  if (parsed.type === "queue")
    return focused === undefined
      ? needsFocus()
      : {
          status: "command",
          command: { type: "queue", task: focused, instruction: parsed.instruction },
        };
  if (parsed.type === "steer")
    return focused === undefined
      ? needsFocus()
      : {
          status: "command",
          command: {
            type: "continue",
            task: focused,
            instruction: parsed.instruction,
            mode: "steer",
            ...(input.requestMetadata === undefined
              ? {}
              : { requestMetadata: input.requestMetadata }),
          },
        };
  if (parsed.type === "reroute") {
    if (focused === undefined || project === undefined)
      return focused === undefined
        ? needsFocus()
        : {
            status: "needs-input",
            reason: "control-target-required",
            prompt: "Which project should receive that task?",
            choices: [],
          };
    const selection = validateSelection(focused.modelSelection, input.providers, focused.objective);
    if (selection.status === "needs-input") return selection;
    return {
      status: "command",
      command: {
        type: "reroute",
        sourceTask: focused,
        targetProjectId: project.id,
        objective: focused.objective,
        modelSelection: selection.selection,
        ...(focused.state === "running"
          ? {
              interrupt: focused.activeTurnId === undefined ? {} : { turnId: focused.activeTurnId },
            }
          : {}),
      },
    };
  }

  if (project === undefined)
    return {
      status: "needs-input",
      reason: "control-target-required",
      prompt: "Which project should receive that task?",
      choices: [],
    };
  const contextThread = input.contextThread;
  const sameProjectContext =
    contextThread !== undefined && contextThread.projectId === selectedProjectId;
  if (input.continueContext && contextThread === undefined)
    return {
      status: "needs-input",
      reason: "context-thread-required",
      prompt: "That conversation is no longer available. Choose a current task to continue.",
      choices: [],
    };
  if (input.continueContext && contextThread !== undefined && !sameProjectContext)
    return {
      status: "needs-input",
      reason: "context-project-mismatch",
      prompt:
        "That conversation belongs to a different project. Choose its project before continuing it.",
      choices: [],
    };

  const pending =
    sameProjectContext && contextThread !== undefined
      ? findPendingReply(contextThread.activities)
      : null;
  const continuation =
    sameProjectContext &&
    contextThread !== undefined &&
    (input.continueContext ||
      (!parsed.explicitWorkerRouting &&
        (pending !== null ||
          /^(?:jarvis[,\s]*)?(?:yes|no|continue|go\s+ahead|reply|answer|tell\s+(?:it|them))\b/iu.test(
            groundedUtterance.trim(),
          ))));
  if (continuation) {
    const task = input.contextTask;
    if (task === undefined)
      return {
        status: "needs-input",
        reason: "context-thread-required",
        prompt: "That conversation is no longer available. Choose a current task to continue.",
        choices: [],
      };
    if (pending?.kind === "user-input") {
      if (pending.questionIds.length === 0)
        return {
          status: "needs-input",
          reason: "source-output-unavailable",
          prompt:
            "T3 could not identify the pending question. Open the task to answer it directly.",
          choices: [],
        };
      return {
        status: "command",
        command: {
          type: "answer",
          task,
          instruction: groundedUtterance.trim(),
          reply: { type: "input", requestId: pending.requestId, questionIds: pending.questionIds },
        },
      };
    }
    if (pending?.kind === "approval") {
      const decision = resolveSpokenApprovalDecision(groundedUtterance);
      if (decision === "clarify")
        return {
          status: "needs-input",
          reason: "control-target-required",
          prompt: "That approval is still waiting. Say allow or deny, or ask for task status.",
          choices: ["allow", "deny"],
        };
      return {
        status: "command",
        command: {
          type: "answer",
          task,
          instruction: groundedUtterance.trim(),
          reply: { type: "approval", requestId: pending.requestId, decision },
        },
      };
    }
    return {
      status: "command",
      command: {
        type: "continue",
        task,
        instruction: groundedUtterance.trim(),
        mode: "continuation",
        ...(input.requestMetadata === undefined ? {} : { requestMetadata: input.requestMetadata }),
      },
    };
  }

  const fallback = input.nodeDefaultModelSelection ?? project.defaultModelSelection ?? undefined;
  let selection: ModelSelection;
  let objective: string;
  if (input.modelSelection !== undefined) {
    const validated = validateSelection(
      input.modelSelection,
      input.providers,
      groundedUtterance.replace(/^\s*jarvis[,\s]*/iu, "").trim(),
    );
    if (validated.status === "needs-input") return validated;
    selection = validated.selection;
    objective = validated.objective;
  } else if (
    fallback !== undefined &&
    requestedProviderLabel(groundedUtterance, input.providers) === null
  ) {
    const validated = validateSelection(
      withModelOptionDefaults(fallback, input.providers),
      input.providers,
      groundedUtterance.replace(/^\s*jarvis[,\s]*/iu, "").trim(),
    );
    if (validated.status === "needs-input") return validated;
    selection = validated.selection;
    objective = validated.objective;
  } else {
    const spoken = spokenSelection(groundedUtterance, input.providers);
    if ("status" in spoken) return spoken;
    selection = spoken.selection;
    objective = spoken.objective;
  }
  const review = /\breview\s+(?:this|the\s+current)\b/iu.test(objective);
  if (review) {
    if (contextThread === undefined)
      return {
        status: "needs-input",
        reason: "context-thread-required",
        prompt: "Open the source task before asking T3 to review its output.",
        choices: [],
      };
    const sourceOutput = contextThread.messages
      .findLast((message) => message.role === "assistant" && !message.streaming)
      ?.text.trim();
    if (!sourceOutput || input.contextTask === undefined)
      return {
        status: "needs-input",
        reason: "source-output-unavailable",
        prompt: "The source task does not have a completed assistant output to review yet.",
        choices: [],
      };
    return {
      status: "command",
      command: {
        type: "review",
        projectId: project.id,
        sourceTask: input.contextTask,
        sourceOutput,
        objective,
        modelSelection: selection,
        runtimeMode: "full-access",
        interactionMode: "default",
        ...(input.requestMetadata === undefined ? {} : { requestMetadata: input.requestMetadata }),
      },
    };
  }
  return {
    status: "command",
    command: {
      type: "start",
      projectId: project.id,
      objective,
      modelSelection: selection,
      runtimeMode: "full-access",
      interactionMode: "default",
      ...(input.requestMetadata === undefined ? {} : { requestMetadata: input.requestMetadata }),
    },
  };
}
