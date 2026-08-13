import type { CompanionModelSelection } from "./host.ts";

export type CompanionConversationMode = "new-thread" | "continue-last-thread";

export type CompanionSettings = {
  readonly host: string | null;
  readonly defaultModelSelection?: CompanionModelSelection;
  readonly conversationMode?: CompanionConversationMode;
};

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function parseCompanionConversationMode(
  value: unknown,
): CompanionConversationMode | undefined {
  return value === "new-thread" || value === "continue-last-thread" ? value : undefined;
}

export function parseCompanionModelSelection(value: unknown): CompanionModelSelection | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const instanceId = text(candidate.instanceId);
  const model = text(candidate.model);
  if (instanceId === undefined || model === undefined) return undefined;
  if (candidate.options !== undefined && !Array.isArray(candidate.options)) return undefined;
  const rawOptions = Array.isArray(candidate.options) ? candidate.options : [];
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
  if (options.length !== rawOptions.length) return undefined;
  return { instanceId, model, ...(options.length === 0 ? {} : { options }) };
}

/** Keeps the on-disk companion config backward compatible with host-only v1. */
export function parseCompanionSettings(value: unknown): CompanionSettings {
  if (typeof value !== "object" || value === null) return { host: null };
  const candidate = value as Record<string, unknown>;
  const host = text(candidate.host) ?? null;
  const defaultModelSelection = parseCompanionModelSelection(candidate.defaultModelSelection);
  const conversationMode = parseCompanionConversationMode(candidate.conversationMode);
  return {
    host,
    ...(host !== null && defaultModelSelection !== undefined ? { defaultModelSelection } : {}),
    ...(host !== null && conversationMode !== undefined ? { conversationMode } : {}),
  };
}

/** A default only survives when the companion remains paired to the same host. */
export function withCompanionHost(
  current: CompanionSettings,
  host: string | null,
): CompanionSettings {
  if (host === null) return { host: null };
  return {
    host,
    ...(current.host === host && current.defaultModelSelection !== undefined
      ? { defaultModelSelection: current.defaultModelSelection }
      : {}),
    ...(current.host === host && current.conversationMode !== undefined
      ? { conversationMode: current.conversationMode }
      : {}),
  };
}

export function withCompanionDefault(
  current: CompanionSettings,
  defaultModelSelection: CompanionModelSelection,
): CompanionSettings {
  if (current.host === null) return current;
  return {
    host: current.host,
    defaultModelSelection,
    ...(current.conversationMode === undefined
      ? {}
      : { conversationMode: current.conversationMode }),
  };
}

/** Removes a host-specific default without disturbing the authenticated pairing. */
export function withoutCompanionDefault(current: CompanionSettings): CompanionSettings {
  return {
    host: current.host,
    ...(current.conversationMode === undefined
      ? {}
      : { conversationMode: current.conversationMode }),
  };
}

export function withCompanionConversationMode(
  current: CompanionSettings,
  conversationMode: CompanionConversationMode,
): CompanionSettings {
  if (current.host === null) return current;
  return {
    host: current.host,
    ...(current.defaultModelSelection === undefined
      ? {}
      : { defaultModelSelection: current.defaultModelSelection }),
    conversationMode,
  };
}
