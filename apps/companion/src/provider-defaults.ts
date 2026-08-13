import type { CompanionModelSelection } from "./host.ts";

export type CompanionOptionChoice = { readonly id: string; readonly label: string };

export type CompanionOptionDescriptor =
  | {
      readonly id: string;
      readonly label: string;
      readonly type: "select";
      readonly options: ReadonlyArray<CompanionOptionChoice>;
    }
  | { readonly id: string; readonly label: string; readonly type: "boolean" };

export type CompanionModel = {
  readonly slug: string;
  readonly name: string;
  readonly shortName?: string;
  readonly capabilities: { readonly optionDescriptors: ReadonlyArray<CompanionOptionDescriptor> };
};

export type CompanionProvider = {
  readonly instanceId: string;
  readonly displayName?: string;
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly status: string;
  readonly auth: { readonly status: string };
  readonly models: ReadonlyArray<CompanionModel>;
};

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionDescriptor(value: unknown): CompanionOptionDescriptor | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const id = text(candidate.id);
  const label = text(candidate.label) ?? id;
  if (id === undefined || label === undefined) return undefined;
  if (candidate.type === "boolean") return { id, label, type: "boolean" };
  if (candidate.type !== "select" || !Array.isArray(candidate.options)) return undefined;
  const options = candidate.options.flatMap((option): ReadonlyArray<CompanionOptionChoice> => {
    if (typeof option !== "object" || option === null) return [];
    const item = option as Record<string, unknown>;
    const optionId = text(item.id);
    if (optionId === undefined) return [];
    return [{ id: optionId, label: text(item.label) ?? optionId }];
  });
  return { id, label, type: "select", options };
}

function model(value: unknown): CompanionModel | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const slug = text(candidate.slug);
  const name = text(candidate.name) ?? text(candidate.shortName) ?? slug;
  if (slug === undefined || name === undefined) return undefined;
  const capabilities =
    typeof candidate.capabilities === "object" && candidate.capabilities !== null
      ? (candidate.capabilities as Record<string, unknown>)
      : {};
  const descriptors = Array.isArray(capabilities.optionDescriptors)
    ? capabilities.optionDescriptors.flatMap((value): ReadonlyArray<CompanionOptionDescriptor> => {
        const parsed = optionDescriptor(value);
        return parsed === undefined ? [] : [parsed];
      })
    : [];
  const shortName = text(candidate.shortName);
  return {
    slug,
    name,
    ...(shortName === undefined ? {} : { shortName }),
    capabilities: { optionDescriptors: descriptors },
  };
}

/** Restricts the remote snapshot to the values the companion is allowed to display or save. */
export function normalizeCompanionProviders(value: unknown): ReadonlyArray<CompanionProvider> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((value): ReadonlyArray<CompanionProvider> => {
    if (typeof value !== "object" || value === null) return [];
    const candidate = value as Record<string, unknown>;
    const instanceId = text(candidate.instanceId);
    if (instanceId === undefined) return [];
    const auth =
      typeof candidate.auth === "object" && candidate.auth !== null
        ? (candidate.auth as Record<string, unknown>)
        : {};
    const models = Array.isArray(candidate.models)
      ? candidate.models.flatMap((value): ReadonlyArray<CompanionModel> => {
          const parsed = model(value);
          return parsed === undefined ? [] : [parsed];
        })
      : [];
    const displayName = text(candidate.displayName);
    return [
      {
        instanceId,
        ...(displayName === undefined ? {} : { displayName }),
        enabled: candidate.enabled === true,
        installed: candidate.installed === true,
        status: text(candidate.status) ?? "unknown",
        auth: { status: text(auth.status) ?? "unknown" },
        models,
      },
    ];
  });
}

export function readyCompanionProviders(
  providers: ReadonlyArray<CompanionProvider>,
): ReadonlyArray<CompanionProvider> {
  return providers.filter(
    (provider) =>
      provider.enabled &&
      provider.installed &&
      provider.status === "ready" &&
      provider.auth.status !== "unauthenticated" &&
      provider.models.length > 0,
  );
}

/**
 * Revalidates renderer-provided defaults against the live host catalog before
 * persisting them. The host repeats this validation at dispatch time.
 */
export function validateCompanionDefault(input: {
  readonly providers: ReadonlyArray<CompanionProvider>;
  readonly candidate: unknown;
}):
  | { readonly ok: true; readonly selection: CompanionModelSelection }
  | { readonly ok: false; readonly message: string } {
  if (typeof input.candidate !== "object" || input.candidate === null) {
    return { ok: false, message: "Choose a provider and model before saving defaults." };
  }
  const value = input.candidate as Record<string, unknown>;
  const instanceId = text(value.instanceId);
  const modelSlug = text(value.model);
  if (instanceId === undefined || modelSlug === undefined) {
    return { ok: false, message: "Choose a provider and model before saving defaults." };
  }
  const provider = readyCompanionProviders(input.providers).find(
    (candidate) => candidate.instanceId === instanceId,
  );
  if (provider === undefined) {
    return {
      ok: false,
      message: "That provider is no longer ready on Jarvis Host. Choose another one.",
    };
  }
  const model = provider.models.find((candidate) => candidate.slug === modelSlug);
  if (model === undefined) {
    return {
      ok: false,
      message: "That model is no longer available on Jarvis Host. Choose another one.",
    };
  }
  const rawOptions = Array.isArray(value.options) ? value.options : [];
  const options = rawOptions.flatMap(
    (option): ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> => {
      if (typeof option !== "object" || option === null) return [];
      const item = option as Record<string, unknown>;
      const id = text(item.id);
      if (id === undefined || (typeof item.value !== "string" && typeof item.value !== "boolean")) {
        return [];
      }
      return [{ id, value: item.value }];
    },
  );
  if (
    options.length !== rawOptions.length ||
    new Set(options.map((option) => option.id)).size !== options.length
  ) {
    return {
      ok: false,
      message: "One of the selected model settings is invalid. Choose it again.",
    };
  }
  for (const option of options) {
    const descriptor = model.capabilities.optionDescriptors.find(
      (candidate) => candidate.id === option.id,
    );
    if (descriptor === undefined) {
      return {
        ok: false,
        message: `The ${option.id} setting is no longer available for that model.`,
      };
    }
    if (descriptor.type === "boolean" && typeof option.value !== "boolean") {
      return { ok: false, message: `Choose a valid ${descriptor.label} setting.` };
    }
    if (
      descriptor.type === "select" &&
      (typeof option.value !== "string" ||
        !descriptor.options.some((choice) => choice.id === option.value))
    ) {
      return { ok: false, message: `Choose a valid ${descriptor.label} setting.` };
    }
  }
  const requiredSelect = model.capabilities.optionDescriptors.find(
    (descriptor) =>
      descriptor.type === "select" &&
      /effort|reason|thought/iu.test(`${descriptor.id} ${descriptor.label}`),
  );
  if (requiredSelect && !options.some((option) => option.id === requiredSelect.id)) {
    return { ok: false, message: `Choose ${requiredSelect.label} before saving defaults.` };
  }
  return {
    ok: true,
    selection: { instanceId, model: model.slug, ...(options.length ? { options } : {}) },
  };
}
