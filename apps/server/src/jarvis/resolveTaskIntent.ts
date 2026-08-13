import type { ModelSelection, ServerProvider } from "@t3tools/contracts";

export type ResolvedTaskIntent = {
  readonly status: "ready";
  readonly action: "task" | "review-context";
  readonly objective: string;
  readonly modelSelection: ModelSelection;
};

export type TaskIntentNeedsInput = {
  readonly status: "needs-input";
  readonly reason:
    | "provider-unavailable"
    | "provider-not-found"
    | "model-unavailable"
    | "effort-missing"
    | "effort-unavailable"
    | "selection-unavailable"
    | "objective-missing"
    | "context-thread-required"
    | "context-project-mismatch"
    | "source-output-unavailable";
  readonly prompt: string;
  readonly choices: ReadonlyArray<string>;
  readonly pendingModelSelection?: ModelSelection;
};

export function resolveTaskIntent(input: {
  readonly utterance: string;
  readonly providers: ReadonlyArray<ServerProvider>;
  /**
   * A saved companion choice should be authoritative over speech parsing.
   * The server still validates the selection against the live provider
   * registry because models and capability options can change at runtime.
   */
  readonly modelSelection?: ModelSelection;
}): ResolvedTaskIntent | TaskIntentNeedsInput {
  if (input.modelSelection !== undefined) {
    return resolveExplicitTaskIntent({
      utterance: input.utterance,
      providers: input.providers,
      modelSelection: input.modelSelection,
    });
  }

  const normalizedUtterance = input.utterance.toLowerCase();
  const requestedProvider = requestedProviderLabel(input.utterance);
  const provider =
    (requestedProvider
      ? input.providers.find((candidate) =>
          providerNames(candidate).some((name) => name === requestedProvider.toLowerCase()),
        )
      : undefined) ??
    input.providers.find((candidate) =>
      providerNames(candidate).some((name) => normalizedUtterance.includes(name)),
    );
  if (!provider) {
    const requestedProviderName = requestedProvider ?? "That provider";
    const availableProviders = input.providers.filter(
      (candidate) =>
        candidate.enabled &&
        candidate.installed &&
        candidate.status === "ready" &&
        candidate.auth.status !== "unauthenticated",
    );
    const availableLabels = availableProviders.map(
      (candidate) => candidate.displayName ?? candidate.instanceId,
    );
    return {
      status: "needs-input",
      reason: "provider-not-found",
      prompt: `${requestedProviderName} is not configured. ${formatList(availableLabels)} ${availableLabels.length === 1 ? "is" : "are"} available.`,
      choices: availableProviders.map((candidate) => candidate.instanceId),
    };
  }
  if (
    !provider.enabled ||
    !provider.installed ||
    provider.status !== "ready" ||
    provider.auth.status === "unauthenticated"
  ) {
    return {
      status: "needs-input",
      reason: "provider-unavailable",
      prompt: `${provider.displayName ?? provider.instanceId} is not ready. Install, enable, and authenticate it before starting this task.`,
      choices: [],
    };
  }

  const explicitlyNamedModel = provider.models.find((candidate) =>
    [candidate.slug, candidate.name, candidate.shortName]
      .filter((value): value is string => typeof value === "string")
      .some((value) => normalizedUtterance.includes(value.toLowerCase())),
  );
  const requestedModel = requestedModelLabel(input.utterance, provider);
  const model =
    explicitlyNamedModel ??
    (requestedModel === null && provider.models.length === 1 ? provider.models[0] : null);
  if (!model) {
    const requestedModelName = requestedModel ?? "That model";
    const availableLabels = provider.models.map(
      (candidate) => candidate.shortName ?? candidate.name,
    );
    return {
      status: "needs-input",
      reason: "model-unavailable",
      prompt: `${requestedModelName} is not available through ${provider.displayName ?? provider.instanceId}. ${formatList(availableLabels)} ${availableLabels.length === 1 ? "is" : "are"} available.`,
      choices: provider.models.map((candidate) => candidate.slug),
    };
  }

  const requestedEffort = findRequestedEffort(input.utterance);
  const effortDescriptor = model.capabilities?.optionDescriptors?.find(
    (descriptor) =>
      descriptor.type === "select" &&
      /effort|reason|thought/iu.test(`${descriptor.id} ${descriptor.label}`),
  );
  if (requestedEffort && !effortDescriptor) {
    return {
      status: "needs-input",
      reason: "effort-unavailable",
      prompt: `${model.shortName ?? model.name} does not offer a configurable effort level. Remove ${sentenceCase(requestedEffort)} or choose another model.`,
      choices: [],
    };
  }
  if (!requestedEffort && effortDescriptor?.type === "select") {
    return {
      status: "needs-input",
      reason: "effort-missing",
      prompt: `Which effort level should ${model.shortName ?? model.name} use? ${formatList(effortDescriptor.options.map((option) => option.label))} are available.`,
      choices: effortDescriptor.options.map((option) => option.id),
    };
  }
  if (
    requestedEffort &&
    effortDescriptor?.type === "select" &&
    !effortDescriptor.options.some(
      (option) =>
        option.id.toLowerCase() === requestedEffort ||
        option.label.toLowerCase() === requestedEffort,
    )
  ) {
    const effortLabels = effortDescriptor.options.map((option) => option.label);
    return {
      status: "needs-input",
      reason: "effort-unavailable",
      prompt: `${sentenceCase(requestedEffort)} is not available for ${model.shortName ?? model.name}. ${formatList(effortLabels)} ${effortLabels.length === 1 ? "is" : "are"} available.`,
      choices: effortDescriptor.options.map((option) => option.id),
    };
  }

  const options = model.capabilities?.optionDescriptors?.flatMap((descriptor) => {
    if (descriptor.type !== "select") return [];
    const selected = descriptor.options.find((option) =>
      normalizedUtterance.includes(option.id.toLowerCase()),
    );
    return selected ? [{ id: descriptor.id, value: selected.id }] : [];
  });
  const modelSelection: ModelSelection = {
    instanceId: provider.instanceId,
    model: model.slug,
    ...(options && options.length > 0 ? { options } : {}),
  };
  const objectiveMatch = input.utterance.match(/\b(?:agent\s+)?to\s+([\s\S]+)$/i);
  if (!objectiveMatch?.[1]) {
    return {
      status: "needs-input",
      reason: "objective-missing",
      prompt: `What should the ${provider.displayName ?? provider.instanceId} ${model.shortName ?? model.name} agent work on?`,
      choices: [],
      pendingModelSelection: modelSelection,
    };
  }
  const objective = sentenceCase(objectiveMatch[1].trim());

  return {
    status: "ready",
    action: /\breview\s+(?:this|the\s+current)\b/iu.test(objective) ? "review-context" : "task",
    objective,
    modelSelection,
  };
}

function resolveExplicitTaskIntent(input: {
  readonly utterance: string;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly modelSelection: ModelSelection;
}): ResolvedTaskIntent | TaskIntentNeedsInput {
  const provider = input.providers.find(
    (candidate) => candidate.instanceId === input.modelSelection.instanceId,
  );
  if (!provider) {
    const availableProviders = input.providers.filter(
      (candidate) =>
        candidate.enabled &&
        candidate.installed &&
        candidate.status === "ready" &&
        candidate.auth.status !== "unauthenticated",
    );
    const availableLabels = availableProviders.map(
      (candidate) => candidate.displayName ?? candidate.instanceId,
    );
    return {
      status: "needs-input",
      reason: "provider-not-found",
      prompt: `The saved companion provider ${input.modelSelection.instanceId} is no longer configured. ${formatList(availableLabels)} ${availableLabels.length === 1 ? "is" : "are"} available.`,
      choices: availableProviders.map((candidate) => candidate.instanceId),
    };
  }
  if (
    !provider.enabled ||
    !provider.installed ||
    provider.status !== "ready" ||
    provider.auth.status === "unauthenticated"
  ) {
    return {
      status: "needs-input",
      reason: "provider-unavailable",
      prompt: `${provider.displayName ?? provider.instanceId} is not ready. Install, enable, and authenticate it before starting this task.`,
      choices: [],
    };
  }

  const model = provider.models.find((candidate) => candidate.slug === input.modelSelection.model);
  if (!model) {
    const availableLabels = provider.models.map(
      (candidate) => candidate.shortName ?? candidate.name,
    );
    return {
      status: "needs-input",
      reason: "model-unavailable",
      prompt: `The saved companion model ${input.modelSelection.model} is no longer available through ${provider.displayName ?? provider.instanceId}. ${formatList(availableLabels)} ${availableLabels.length === 1 ? "is" : "are"} available.`,
      choices: provider.models.map((candidate) => candidate.slug),
    };
  }

  const optionDescriptors = model.capabilities?.optionDescriptors ?? [];
  const selectedOptions = input.modelSelection.options ?? [];
  const duplicateOption = selectedOptions.find(
    (option, index) =>
      selectedOptions.findIndex((candidate) => candidate.id === option.id) !== index,
  );
  if (duplicateOption) {
    return {
      status: "needs-input",
      reason: "selection-unavailable",
      prompt: `The saved ${duplicateOption.id} setting was selected more than once. Choose it again in Jarvis Companion.`,
      choices: [],
    };
  }
  const selectedOptionById = new Map(selectedOptions.map((option) => [option.id, option]));
  const invalidOption = selectedOptions.find((option) => {
    const descriptor = optionDescriptors.find((candidate) => candidate.id === option.id);
    if (!descriptor) return true;
    if (descriptor.type === "boolean") return typeof option.value !== "boolean";
    return (
      typeof option.value !== "string" ||
      !descriptor.options.some((choice) => choice.id === option.value)
    );
  });
  if (invalidOption) {
    return {
      status: "needs-input",
      reason: "selection-unavailable",
      prompt: `The saved ${invalidOption.id} setting is no longer available for ${model.shortName ?? model.name}. Choose it again in Jarvis Companion.`,
      choices: [],
    };
  }

  const effortDescriptor = optionDescriptors.find(
    (descriptor) =>
      descriptor.type === "select" &&
      /effort|reason|thought/iu.test(`${descriptor.id} ${descriptor.label}`),
  );
  if (effortDescriptor?.type === "select" && !selectedOptionById.has(effortDescriptor.id)) {
    return {
      status: "needs-input",
      reason: "effort-missing",
      prompt: `Choose a ${effortDescriptor.label.toLowerCase()} level for ${model.shortName ?? model.name} in Jarvis Companion before starting a task.`,
      choices: effortDescriptor.options.map((option) => option.id),
      pendingModelSelection: input.modelSelection,
    };
  }

  const objective = input.utterance.replace(/^\s*jarvis[,\s]*/iu, "").trim();
  if (objective.length === 0) {
    return {
      status: "needs-input",
      reason: "objective-missing",
      prompt: `What should the ${provider.displayName ?? provider.instanceId} ${model.shortName ?? model.name} agent work on?`,
      choices: [],
      pendingModelSelection: input.modelSelection,
    };
  }

  return {
    status: "ready",
    action: /\breview\s+(?:this|the\s+current)\b/iu.test(objective) ? "review-context" : "task",
    objective: sentenceCase(objective),
    modelSelection: input.modelSelection,
  };
}

function providerNames(provider: ServerProvider): ReadonlyArray<string> {
  return [provider.instanceId, provider.driver, provider.displayName]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase());
}

function sentenceCase(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase()}${value.slice(1)}`;
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

function formatList(values: ReadonlyArray<string>): string {
  if (values.length === 0) return "No models";
  if (values.length === 1) return values[0] ?? "No models";
  return `${values.slice(0, -1).join(", ")} and ${values.at(-1)}`;
}

function findRequestedEffort(utterance: string): string | null {
  const tokens = new Set(
    utterance
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter(Boolean),
  );
  return (
    ["minimal", "low", "medium", "high", "xhigh", "max", "ultra", "ultrathink"].find((effort) =>
      tokens.has(effort),
    ) ?? null
  );
}

function requestedProviderLabel(utterance: string): string | null {
  const match = utterance.match(/\b(?:use|with|through)\s+([a-z][a-z0-9_-]*)/iu);
  return match?.[1] ? sentenceCase(match[1]) : null;
}
