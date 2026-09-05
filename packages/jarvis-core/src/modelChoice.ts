import type {
  ModelSelection,
  ProviderOptionDescriptor,
  SelectProviderOptionDescriptor,
  ServerProvider,
} from "@t3tools/contracts";

/** Clarification reasons answered with a typed model selection, never rewritten English. */
export type JarvisModelClarificationReason =
  | "provider-not-found"
  | "model-unavailable"
  | "effort-missing"
  | "effort-unavailable";

export function isJarvisModelClarificationReason(
  reason: string,
): JarvisModelClarificationReason | null {
  return reason === "provider-not-found" ||
    reason === "model-unavailable" ||
    reason === "effort-missing" ||
    reason === "effort-unavailable"
    ? reason
    : null;
}

/**
 * Complete a model selection without asking when the catalog leaves exactly
 * one option: one provider, one (or default) model, and no missing effort
 * choice. Anything ambiguous returns null so the user picks explicitly.
 */
export function uniqueJarvisModelCompletion(
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection | null {
  if (providers.length !== 1 || providers[0] === undefined) return null;
  const provider = providers[0];
  const model =
    provider.models.length === 1
      ? provider.models[0]
      : provider.models.find((candidate) => candidate.isDefault === true);
  if (model === undefined) return null;
  const effort = findJarvisEffortDescriptor(model.capabilities?.optionDescriptors);
  if (effort !== undefined) {
    const fallback = effort.options.find((option) => option.isDefault === true);
    if (fallback === undefined) return null;
    return {
      instanceId: provider.instanceId,
      model: model.slug,
      options: [{ id: effort.id, value: fallback.id }],
    };
  }
  return { instanceId: provider.instanceId, model: model.slug };
}

export interface JarvisModelDraft {
  readonly instanceId?: ServerProvider["instanceId"];
  readonly model?: string;
  readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>;
}

export type JarvisModelChoiceResult =
  | { readonly status: "complete"; readonly selection: ModelSelection }
  | {
      readonly status: "need-choice";
      readonly draft: JarvisModelDraft;
      readonly prompt: string;
      readonly choices: ReadonlyArray<string>;
    }
  | { readonly status: "no-match" };

const normalize = (value: string): string => value.trim().toLowerCase();

const providerNames = (provider: ServerProvider): ReadonlyArray<string> =>
  [provider.driver, provider.displayName].filter(
    (value): value is string => typeof value === "string",
  );

/** The single rule for which option descriptor counts as the effort level. */
export function findJarvisEffortDescriptor(
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined,
): SelectProviderOptionDescriptor | undefined {
  return descriptors?.find(
    (descriptor): descriptor is SelectProviderOptionDescriptor =>
      descriptor.type === "select" &&
      /effort|reason|thought/iu.test(`${descriptor.id} ${descriptor.label}`),
  );
}

function providerLabel(provider: ServerProvider): string {
  return provider.displayName ?? provider.driver;
}

function completeDraft(
  provider: ServerProvider,
  model: string,
  options?: JarvisModelDraft["options"],
): JarvisModelChoiceResult {
  return {
    status: "complete",
    selection: {
      instanceId: provider.instanceId,
      model,
      ...(options === undefined || options.length === 0 ? {} : { options: [...options] }),
    },
  };
}

function finishModel(
  provider: ServerProvider,
  modelSlug: string,
  draft: JarvisModelDraft,
): JarvisModelChoiceResult {
  const model = provider.models.find((candidate) => candidate.slug === modelSlug);
  const effort = findJarvisEffortDescriptor(model?.capabilities?.optionDescriptors);
  const selected = draft.options ?? [];
  if (effort !== undefined && !selected.some((option) => option.id === effort.id)) {
    const fallback = effort.options.find((option) => option.isDefault === true);
    if (fallback !== undefined) {
      return completeDraft(provider, modelSlug, [
        ...selected,
        { id: effort.id, value: fallback.id },
      ]);
    }
    return {
      status: "need-choice",
      draft: { ...draft, instanceId: provider.instanceId, model: modelSlug },
      prompt: `Choose a ${effort.label.toLocaleLowerCase()} level for ${model?.shortName ?? model?.name ?? modelSlug}.`,
      choices: effort.options.map((option) => option.id),
    };
  }
  return completeDraft(provider, modelSlug, selected);
}

/**
 * Answer one clarification choice against catalog data.
 *
 * The reason scopes what the choice may name: a provider answer resolves the
 * provider step, a model answer resolves the model step (within the drafted
 * provider, or across providers when none is drafted yet), and an effort
 * answer fills the drafted model's effort option. Matching follows the same
 * name rules the server validates so a typed answer cannot resolve
 * differently from what the controller would accept. Returns no-match when
 * the choice names nothing in scope, so the caller can fall back to sending
 * the raw answer instead of guessing.
 */
export function answerJarvisModelChoice(
  providers: ReadonlyArray<ServerProvider>,
  draft: JarvisModelDraft,
  reason: JarvisModelClarificationReason,
  choice: string,
): JarvisModelChoiceResult {
  const query = normalize(choice);
  if (query.length === 0) return { status: "no-match" };

  if (reason === "effort-missing" || reason === "effort-unavailable") {
    if (draft.instanceId === undefined || draft.model === undefined) return { status: "no-match" };
    const provider = providers.find((candidate) => candidate.instanceId === draft.instanceId);
    const model = provider?.models.find((candidate) => candidate.slug === draft.model);
    const effort = findJarvisEffortDescriptor(model?.capabilities?.optionDescriptors);
    if (provider === undefined || effort === undefined) return { status: "no-match" };
    const match = effort.options.find(
      (option) => normalize(option.id) === query || normalize(option.label) === query,
    );
    if (match === undefined) return { status: "no-match" };
    return completeDraft(provider, draft.model, [
      ...(draft.options ?? []),
      { id: effort.id, value: match.id },
    ]);
  }

  if (reason === "model-unavailable" && draft.instanceId !== undefined) {
    const provider = providers.find((candidate) => candidate.instanceId === draft.instanceId);
    if (provider === undefined) return { status: "no-match" };
    return matchModel(provider, draft, query);
  }

  if (reason === "model-unavailable") {
    const matches: Array<{ provider: ServerProvider; slug: string }> = [];
    for (const provider of providers) {
      for (const model of provider.models) {
        if (
          [model.slug, model.name, model.shortName]
            .filter((name): name is string => typeof name === "string")
            .some((name) => normalize(name) === query)
        ) {
          matches.push({ provider, slug: model.slug });
        }
      }
    }
    if (matches.length === 0) return { status: "no-match" };
    if (matches.length > 1) {
      return {
        status: "need-choice",
        draft,
        prompt: "Which provider's model should I use?",
        choices: matches.map(({ provider }) => providerLabel(provider)),
      };
    }
    const match = matches[0]!;
    return finishModel(match.provider, match.slug, {
      ...draft,
      instanceId: match.provider.instanceId,
    });
  }

  const matches = providers.filter((provider) =>
    [...providerNames(provider), provider.instanceId].some((name) => normalize(name) === query),
  );
  if (matches.length === 0) return { status: "no-match" };
  if (matches.length > 1) {
    return {
      status: "need-choice",
      draft,
      prompt: "Which provider should I use?",
      choices: matches.map(providerLabel),
    };
  }
  const provider = matches[0]!;
  const next: JarvisModelDraft = { ...draft, instanceId: provider.instanceId };
  if (provider.models.length === 1 && provider.models[0] !== undefined) {
    return finishModel(provider, provider.models[0].slug, next);
  }
  const fallback = provider.models.find((model) => model.isDefault === true);
  if (fallback !== undefined) {
    return finishModel(provider, fallback.slug, next);
  }
  return {
    status: "need-choice",
    draft: next,
    prompt: `Choose one ${providerLabel(provider)} model.`,
    choices: provider.models.map((model) => model.slug),
  };
}

function matchModel(
  provider: ServerProvider,
  draft: JarvisModelDraft,
  query: string,
): JarvisModelChoiceResult {
  const matches = provider.models.filter((model) =>
    [model.slug, model.name, model.shortName]
      .filter((name): name is string => typeof name === "string")
      .some((name) => normalize(name) === query),
  );
  if (matches.length === 0) return { status: "no-match" };
  if (matches.length > 1) {
    return {
      status: "need-choice",
      draft,
      prompt: `Choose one ${providerLabel(provider)} model.`,
      choices: matches.map((model) => model.slug),
    };
  }
  return finishModel(provider, matches[0]!.slug, draft);
}
