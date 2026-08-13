import type { CompanionModelSelection, CompanionProjectTarget } from "./host.ts";

export type CompanionConversationMode = "new-thread" | "continue-last-thread";

export type CompanionSettings = {
  readonly host: string | null;
  readonly projectTarget?: CompanionProjectTarget;
  readonly defaultModelSelection?: CompanionModelSelection;
  readonly conversationMode?: CompanionConversationMode;
  readonly attentionTarget?: {
    readonly projectId: string;
    readonly threadId: string;
    readonly reportKind?: "completed" | "waiting-for-input" | "approval-needed" | "failed";
  };
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

export function parseCompanionProjectTarget(value: unknown): CompanionProjectTarget | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const id = text(candidate.id);
  const title = text(candidate.title);
  const workspaceRoot = text(candidate.workspaceRoot);
  return id && title && workspaceRoot ? { id, title, workspaceRoot } : undefined;
}

function parseAttentionTarget(value: unknown): CompanionSettings["attentionTarget"] {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const projectId = text(candidate.projectId);
  const threadId = text(candidate.threadId);
  const reportKind = ["completed", "waiting-for-input", "approval-needed", "failed"].includes(
    String(candidate.reportKind),
  )
    ? (candidate.reportKind as NonNullable<CompanionSettings["attentionTarget"]>["reportKind"])
    : undefined;
  return projectId && threadId
    ? { projectId, threadId, ...(reportKind === undefined ? {} : { reportKind }) }
    : undefined;
}

/** Keeps the on-disk companion config backward compatible with host-only v1. */
export function parseCompanionSettings(value: unknown): CompanionSettings {
  if (typeof value !== "object" || value === null) return { host: null };
  const candidate = value as Record<string, unknown>;
  const host = text(candidate.host) ?? null;
  const projectTarget = parseCompanionProjectTarget(candidate.projectTarget);
  const defaultModelSelection = parseCompanionModelSelection(candidate.defaultModelSelection);
  const conversationMode = parseCompanionConversationMode(candidate.conversationMode);
  const attentionTarget = parseAttentionTarget(candidate.attentionTarget);
  return {
    host,
    ...(host !== null && projectTarget !== undefined ? { projectTarget } : {}),
    ...(host !== null && defaultModelSelection !== undefined ? { defaultModelSelection } : {}),
    ...(host !== null && conversationMode !== undefined ? { conversationMode } : {}),
    ...(host !== null && attentionTarget !== undefined ? { attentionTarget } : {}),
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
    ...(current.host === host && current.projectTarget !== undefined
      ? { projectTarget: current.projectTarget }
      : {}),
    ...(current.host === host && current.conversationMode !== undefined
      ? { conversationMode: current.conversationMode }
      : {}),
    ...(current.host === host && current.attentionTarget !== undefined
      ? { attentionTarget: current.attentionTarget }
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
    ...(current.projectTarget === undefined ? {} : { projectTarget: current.projectTarget }),
    defaultModelSelection,
    ...(current.conversationMode === undefined
      ? {}
      : { conversationMode: current.conversationMode }),
    ...(current.attentionTarget === undefined ? {} : { attentionTarget: current.attentionTarget }),
  };
}

/** Removes a host-specific default without disturbing the authenticated pairing. */
export function withoutCompanionDefault(current: CompanionSettings): CompanionSettings {
  return {
    host: current.host,
    ...(current.projectTarget === undefined ? {} : { projectTarget: current.projectTarget }),
    ...(current.conversationMode === undefined
      ? {}
      : { conversationMode: current.conversationMode }),
    ...(current.attentionTarget === undefined ? {} : { attentionTarget: current.attentionTarget }),
  };
}

export function withoutCompanionProject(current: CompanionSettings): CompanionSettings {
  return {
    host: current.host,
    ...(current.defaultModelSelection === undefined
      ? {}
      : { defaultModelSelection: current.defaultModelSelection }),
    ...(current.conversationMode === undefined
      ? {}
      : { conversationMode: current.conversationMode }),
    ...(current.attentionTarget === undefined ? {} : { attentionTarget: current.attentionTarget }),
  };
}

export function withCompanionConversationMode(
  current: CompanionSettings,
  conversationMode: CompanionConversationMode,
): CompanionSettings {
  if (current.host === null) return current;
  return {
    host: current.host,
    ...(current.projectTarget === undefined ? {} : { projectTarget: current.projectTarget }),
    ...(current.defaultModelSelection === undefined
      ? {}
      : { defaultModelSelection: current.defaultModelSelection }),
    conversationMode,
    ...(current.attentionTarget === undefined ? {} : { attentionTarget: current.attentionTarget }),
  };
}

export function withCompanionProject(
  current: CompanionSettings,
  projectTarget: CompanionProjectTarget,
): CompanionSettings {
  if (current.host === null) return current;
  return {
    ...current,
    projectTarget,
  };
}

export function withCompanionAttentionTarget(
  current: CompanionSettings,
  attentionTarget: NonNullable<CompanionSettings["attentionTarget"]>,
): CompanionSettings {
  return current.host === null ? current : { ...current, attentionTarget };
}
