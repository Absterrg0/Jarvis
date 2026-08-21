import type { CompanionModelSelection, CompanionProjectTarget } from "./host.ts";

export type CompanionConversationMode = "new-thread" | "continue-last-thread";

/** A request still awaiting a definitive transport response. */
export type CompanionPendingSubmission = {
  readonly requestId: string;
  readonly originInteractionId: string;
  readonly nodeId?: string;
  readonly projectId: string;
  readonly utterance: string;
  readonly contextThreadId?: string;
  readonly referenceThreadId?: string;
  readonly continueContext?: boolean;
  readonly modelSelection?: CompanionModelSelection;
};

/** Durable identity and connection details for one paired Jarvis node. */
export type CompanionNode = {
  readonly nodeId: string;
  readonly displayName: string;
  readonly host: string;
};

type CompanionNodeDirectory = {
  readonly nodes: ReadonlyArray<CompanionNode>;
  readonly selectedNodeId: string | null;
};

export type CompanionSettings = {
  readonly host: string | null;
  /** Stable identity for this Companion installation's routed interactions. */
  readonly originInteractionId?: string;
  /** The persisted multi-node directory; absent only in pre-directory settings. */
  readonly nodes?: ReadonlyArray<CompanionNode>;
  /** The node used by legacy host consumers until they become node-aware. */
  readonly selectedNodeId?: string | null;
  readonly projectTarget?: CompanionProjectTarget;
  readonly defaultModelSelection?: CompanionModelSelection;
  /** The node whose provider catalog validated the saved default. */
  readonly defaultModelNodeId?: string;
  readonly conversationMode?: CompanionConversationMode;
  readonly attentionTarget?: {
    readonly nodeId?: string;
    readonly projectId: string;
    readonly threadId: string;
    readonly reportKind?: "completed" | "waiting-for-input" | "approval-needed" | "failed";
  };
  /** Persisted before dispatch so a recreated Companion can retry safely. */
  readonly pendingSubmission?: CompanionPendingSubmission;
  readonly pendingProjectTask?: {
    readonly nodeId?: string;
    /** Stable client identity reused when a clarification is retried. */
    readonly requestId?: string;
    /** Keeps a clarification retry attached to the same Companion installation. */
    readonly originInteractionId?: string;
    readonly transcript: string;
    readonly projects: ReadonlyArray<CompanionProjectTarget>;
    readonly heardAlias?: string;
  };
};

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

const legacyCompanionNodeId = (host: string): string => `legacy-host:${host}`;

function legacyCompanionNode(host: string): CompanionNode {
  return {
    nodeId: legacyCompanionNodeId(host),
    displayName: "Jarvis Host",
    host,
  };
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
  const nodeId = text(candidate.nodeId);
  const nodeLabel = text(candidate.nodeLabel);
  return id && title && workspaceRoot
    ? {
        id,
        title,
        workspaceRoot,
        ...(nodeId === undefined ? {} : { nodeId }),
        ...(nodeLabel === undefined ? {} : { nodeLabel }),
      }
    : undefined;
}

/** Parses one persisted directory entry. Unknown fields are deliberately ignored. */
function parseCompanionNode(value: unknown): CompanionNode | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const nodeId = text(candidate.nodeId);
  const displayName = text(candidate.displayName);
  const host = text(candidate.host);
  return nodeId === undefined || displayName === undefined || host === undefined
    ? undefined
    : { nodeId, displayName, host };
}

function parsePendingProjectTask(value: unknown): CompanionSettings["pendingProjectTask"] {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const transcript = text(candidate.transcript);
  if (transcript === undefined || !Array.isArray(candidate.projects)) return undefined;
  const nodeId = text(candidate.nodeId);
  const requestId = text(candidate.requestId);
  const originInteractionId = text(candidate.originInteractionId);
  const projects = candidate.projects.flatMap((project) => {
    const parsed = parseCompanionProjectTarget(project);
    return parsed === undefined ? [] : [parsed];
  });
  if (projects.length === 0 || projects.length !== candidate.projects.length) return undefined;
  const heardAlias = text(candidate.heardAlias);
  return {
    transcript,
    projects,
    ...(nodeId === undefined ? {} : { nodeId }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(originInteractionId === undefined ? {} : { originInteractionId }),
    ...(heardAlias === undefined ? {} : { heardAlias }),
  };
}

function parsePendingSubmission(value: unknown): CompanionPendingSubmission | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const requestId = text(candidate.requestId);
  const originInteractionId = text(candidate.originInteractionId);
  const projectId = text(candidate.projectId);
  const utterance = text(candidate.utterance);
  if (requestId === undefined || originInteractionId === undefined) return undefined;
  if (projectId === undefined || utterance === undefined) return undefined;
  const nodeId = text(candidate.nodeId);
  const contextThreadId = text(candidate.contextThreadId);
  const referenceThreadId = text(candidate.referenceThreadId);
  const continueContext =
    typeof candidate.continueContext === "boolean" ? candidate.continueContext : undefined;
  const modelSelection = parseCompanionModelSelection(candidate.modelSelection);
  return {
    requestId,
    originInteractionId,
    projectId,
    utterance,
    ...(nodeId === undefined ? {} : { nodeId }),
    ...(contextThreadId === undefined ? {} : { contextThreadId }),
    ...(referenceThreadId === undefined ? {} : { referenceThreadId }),
    ...(continueContext === undefined ? {} : { continueContext }),
    ...(modelSelection === undefined ? {} : { modelSelection }),
  };
}

function parseAttentionTarget(value: unknown): CompanionSettings["attentionTarget"] {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const projectId = text(candidate.projectId);
  const threadId = text(candidate.threadId);
  const nodeId = text(candidate.nodeId);
  const reportKind = ["completed", "waiting-for-input", "approval-needed", "failed"].includes(
    String(candidate.reportKind),
  )
    ? (candidate.reportKind as NonNullable<CompanionSettings["attentionTarget"]>["reportKind"])
    : undefined;
  return projectId && threadId
    ? {
        ...(nodeId === undefined ? {} : { nodeId }),
        projectId,
        threadId,
        ...(reportKind === undefined ? {} : { reportKind }),
      }
    : undefined;
}

function parseCompanionNodes(value: unknown): ReadonlyArray<CompanionNode> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const node = parseCompanionNode(entry);
    return node === undefined ? [] : [node];
  });
}

function nodeForId(
  nodes: ReadonlyArray<CompanionNode>,
  nodeId: string | undefined,
): CompanionNode | undefined {
  if (nodeId === undefined) return undefined;
  return nodes.find((node) => node.nodeId === nodeId);
}

function selectedDirectoryNode(
  nodes: ReadonlyArray<CompanionNode>,
  selectedNodeId: string | undefined,
  host: string | null,
): CompanionNode | undefined {
  return (
    nodeForId(nodes, selectedNodeId) ??
    (host === null ? undefined : nodes.find((node) => node.host === host)) ??
    nodes[0]
  );
}

/** Keeps the on-disk companion config backward compatible with host-only v1. */
export function parseCompanionSettings(value: unknown): CompanionSettings {
  if (typeof value !== "object" || value === null) return { host: null };
  const candidate = value as Record<string, unknown>;
  const persistedHost = text(candidate.host) ?? null;
  const hasPersistedDirectory = Array.isArray(candidate.nodes);
  const persistedNodes = parseCompanionNodes(candidate.nodes);
  const nodes =
    persistedNodes.length > 0
      ? persistedNodes
      : persistedHost === null
        ? []
        : [legacyCompanionNode(persistedHost)];
  const persistedSelectedNodeId = text(candidate.selectedNodeId);
  const selectedNode = selectedDirectoryNode(nodes, persistedSelectedNodeId, persistedHost);
  const host = selectedNode?.host ?? persistedHost ?? null;
  const projectTarget = parseCompanionProjectTarget(candidate.projectTarget);
  const defaultModelSelection = parseCompanionModelSelection(candidate.defaultModelSelection);
  const defaultModelNodeId = text(candidate.defaultModelNodeId);
  const originInteractionId = text(candidate.originInteractionId);
  const conversationMode = parseCompanionConversationMode(candidate.conversationMode);
  const attentionTarget = parseAttentionTarget(candidate.attentionTarget);
  const pendingSubmission = parsePendingSubmission(candidate.pendingSubmission);
  const pendingProjectTask = parsePendingProjectTask(candidate.pendingProjectTask);
  return {
    host,
    ...(originInteractionId === undefined ? {} : { originInteractionId }),
    ...(hasPersistedDirectory || nodes.length > 0
      ? {
          nodes,
          selectedNodeId: selectedNode?.nodeId ?? null,
        }
      : {}),
    ...(host !== null && projectTarget !== undefined ? { projectTarget } : {}),
    ...(host !== null && defaultModelSelection !== undefined ? { defaultModelSelection } : {}),
    ...(host !== null && defaultModelSelection !== undefined && defaultModelNodeId !== undefined
      ? { defaultModelNodeId }
      : {}),
    ...(host !== null && conversationMode !== undefined ? { conversationMode } : {}),
    ...(host !== null && attentionTarget !== undefined ? { attentionTarget } : {}),
    ...(host !== null && pendingSubmission !== undefined ? { pendingSubmission } : {}),
    ...(host !== null && pendingProjectTask !== undefined ? { pendingProjectTask } : {}),
  };
}

/** Stores the installation identity without disturbing any legacy settings. */
export function withCompanionOriginInteractionId(
  current: CompanionSettings,
  originInteractionId: string,
): CompanionSettings {
  const value = text(originInteractionId);
  return value === undefined ? current : { ...current, originInteractionId: value };
}

function directoryForSettings(current: CompanionSettings): CompanionNodeDirectory {
  const nodes =
    current.nodes === undefined
      ? current.host === null
        ? []
        : [legacyCompanionNode(current.host)]
      : [...current.nodes];
  const selectedNode = selectedDirectoryNode(nodes, text(current.selectedNodeId), current.host);
  return { nodes, selectedNodeId: selectedNode?.nodeId ?? null };
}

/** Returns every paired node, including the synthetic entry for legacy settings. */
export function companionNodes(current: CompanionSettings): ReadonlyArray<CompanionNode> {
  return directoryForSettings(current).nodes;
}

/** Returns the selected node while retaining the host-only settings fallback. */
export function selectedCompanionNode(current: CompanionSettings): CompanionNode | undefined {
  const directory = directoryForSettings(current);
  return nodeForId(directory.nodes, directory.selectedNodeId ?? undefined);
}

function settingsWithDirectory(
  current: CompanionSettings,
  nodes: ReadonlyArray<CompanionNode>,
  selectedNodeId: string | null,
): CompanionSettings {
  const { nodes: _nodes, selectedNodeId: _selectedNodeId, ...withoutDirectory } = current;
  const selectedNode = selectedDirectoryNode(nodes, selectedNodeId ?? undefined, null);
  return {
    ...withoutDirectory,
    host: selectedNode?.host ?? null,
    nodes: [...nodes],
    selectedNodeId: selectedNode?.nodeId ?? null,
  };
}

/** Pairs a node or updates its durable directory entry without creating duplicates. */
export function upsertCompanionNode(
  current: CompanionSettings,
  node: CompanionNode,
): CompanionSettings {
  const directory = directoryForSettings(current);
  const matchingIndex = directory.nodes.findIndex(
    (existing) =>
      existing.nodeId === node.nodeId ||
      (existing.nodeId.startsWith("legacy-host:") && existing.host === node.host),
  );
  const nodes = [...directory.nodes];
  if (matchingIndex >= 0) {
    nodes[matchingIndex] = node;
  } else {
    nodes.push(node);
  }
  const selectedNodeId = nodes[matchingIndex >= 0 ? matchingIndex : nodes.length - 1]!.nodeId;
  return settingsWithDirectory(current, nodes, selectedNodeId);
}

/** Refreshes a descriptor without changing which node the companion selected. */
export function refreshCompanionNode(
  current: CompanionSettings,
  node: CompanionNode,
): CompanionSettings {
  const directory = directoryForSettings(current);
  const matchingIndex = directory.nodes.findIndex(
    (existing) =>
      existing.nodeId === node.nodeId ||
      (existing.nodeId.startsWith("legacy-host:") && existing.host === node.host),
  );
  const nodes = [...directory.nodes];
  if (matchingIndex >= 0) nodes[matchingIndex] = node;
  else nodes.push(node);
  const selectedNodeId =
    directory.selectedNodeId ?? (matchingIndex >= 0 ? nodes[matchingIndex]!.nodeId : null);
  return settingsWithDirectory(current, nodes, selectedNodeId);
}

/** Pairing is an upsert so reconnecting an existing node never duplicates it. */
export function pairCompanionNode(
  current: CompanionSettings,
  node: CompanionNode,
): CompanionSettings {
  return upsertCompanionNode(current, node);
}

/** Renames a known node while retaining its stable identity and connection. */
export function renameCompanionNode(
  current: CompanionSettings,
  nodeId: string,
  displayName: string,
): CompanionSettings {
  const name = text(displayName);
  if (name === undefined) return current;
  const directory = directoryForSettings(current);
  const index = directory.nodes.findIndex((node) => node.nodeId === nodeId);
  if (index < 0) return current;
  const nodes = [...directory.nodes];
  nodes[index] = { ...nodes[index]!, displayName: name };
  return settingsWithDirectory(current, nodes, directory.selectedNodeId);
}

/** Removes one node; removing the selected node selects the first remaining node. */
export function removeCompanionNode(current: CompanionSettings, nodeId: string): CompanionSettings {
  const directory = directoryForSettings(current);
  const index = directory.nodes.findIndex((node) => node.nodeId === nodeId);
  if (index < 0) return current;
  const removed = directory.nodes[index]!;
  const nodes = directory.nodes.filter((_, entryIndex) => entryIndex !== index);
  const selectedNodeId =
    removed.nodeId === directory.selectedNodeId
      ? (nodes[0]?.nodeId ?? null)
      : directory.selectedNodeId;
  return settingsWithDirectory(current, nodes, selectedNodeId);
}

/** Selects an existing node by node ID. Unknown IDs are ignored. */
export function selectCompanionNode(current: CompanionSettings, nodeId: string): CompanionSettings {
  const directory = directoryForSettings(current);
  const index = directory.nodes.findIndex((node) => node.nodeId === nodeId);
  if (index < 0) return current;
  return settingsWithDirectory(current, directory.nodes, directory.nodes[index]!.nodeId);
}

function directoryFields(
  current: CompanionSettings,
): Pick<CompanionSettings, "nodes" | "selectedNodeId"> {
  return {
    ...(current.nodes === undefined ? {} : { nodes: current.nodes }),
    ...(current.selectedNodeId === undefined ? {} : { selectedNodeId: current.selectedNodeId }),
  };
}

function originInteractionField(
  current: CompanionSettings,
): Pick<CompanionSettings, "originInteractionId"> {
  return current.originInteractionId === undefined
    ? {}
    : { originInteractionId: current.originInteractionId };
}

function pendingSubmissionField(
  current: CompanionSettings,
): Pick<CompanionSettings, "pendingSubmission"> {
  return current.pendingSubmission === undefined
    ? {}
    : { pendingSubmission: current.pendingSubmission };
}

/** A default only survives when the companion remains paired to the same host. */
export function withCompanionHost(
  current: CompanionSettings,
  host: string | null,
): CompanionSettings {
  if (host === null) return { host: null, ...originInteractionField(current) };
  return {
    host,
    ...originInteractionField(current),
    ...(current.host === host ? directoryFields(current) : {}),
    ...(current.host === host && current.defaultModelSelection !== undefined
      ? { defaultModelSelection: current.defaultModelSelection }
      : {}),
    ...(current.host === host && current.defaultModelNodeId !== undefined
      ? { defaultModelNodeId: current.defaultModelNodeId }
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
    ...(current.host === host ? pendingSubmissionField(current) : {}),
    ...(current.host === host && current.pendingProjectTask !== undefined
      ? { pendingProjectTask: current.pendingProjectTask }
      : {}),
  };
}

export function withCompanionDefault(
  current: CompanionSettings,
  defaultModelSelection: CompanionModelSelection,
  nodeId?: string,
): CompanionSettings {
  if (current.host === null) return current;
  return {
    host: current.host,
    ...originInteractionField(current),
    ...directoryFields(current),
    ...(current.projectTarget === undefined ? {} : { projectTarget: current.projectTarget }),
    defaultModelSelection,
    ...(nodeId === undefined
      ? current.defaultModelNodeId === undefined
        ? {}
        : { defaultModelNodeId: current.defaultModelNodeId }
      : { defaultModelNodeId: nodeId }),
    ...(current.conversationMode === undefined
      ? {}
      : { conversationMode: current.conversationMode }),
    ...(current.attentionTarget === undefined ? {} : { attentionTarget: current.attentionTarget }),
    ...pendingSubmissionField(current),
  };
}

/** Removes a host-specific default without disturbing the authenticated pairing. */
export function withoutCompanionDefault(current: CompanionSettings): CompanionSettings {
  return {
    host: current.host,
    ...originInteractionField(current),
    ...directoryFields(current),
    ...(current.projectTarget === undefined ? {} : { projectTarget: current.projectTarget }),
    ...(current.conversationMode === undefined
      ? {}
      : { conversationMode: current.conversationMode }),
    ...(current.attentionTarget === undefined ? {} : { attentionTarget: current.attentionTarget }),
    ...pendingSubmissionField(current),
  };
}

export function withoutCompanionProject(current: CompanionSettings): CompanionSettings {
  return {
    host: current.host,
    ...originInteractionField(current),
    ...directoryFields(current),
    ...(current.defaultModelSelection === undefined
      ? {}
      : { defaultModelSelection: current.defaultModelSelection }),
    ...(current.defaultModelNodeId === undefined
      ? {}
      : { defaultModelNodeId: current.defaultModelNodeId }),
    ...(current.conversationMode === undefined
      ? {}
      : { conversationMode: current.conversationMode }),
    ...(current.attentionTarget === undefined ? {} : { attentionTarget: current.attentionTarget }),
    ...pendingSubmissionField(current),
  };
}

export function withCompanionConversationMode(
  current: CompanionSettings,
  conversationMode: CompanionConversationMode,
): CompanionSettings {
  if (current.host === null) return current;
  return {
    host: current.host,
    ...originInteractionField(current),
    ...directoryFields(current),
    ...(current.projectTarget === undefined ? {} : { projectTarget: current.projectTarget }),
    ...(current.defaultModelSelection === undefined
      ? {}
      : { defaultModelSelection: current.defaultModelSelection }),
    ...(current.defaultModelNodeId === undefined
      ? {}
      : { defaultModelNodeId: current.defaultModelNodeId }),
    conversationMode,
    ...(current.attentionTarget === undefined ? {} : { attentionTarget: current.attentionTarget }),
    ...pendingSubmissionField(current),
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

export function withCompanionPendingSubmission(
  current: CompanionSettings,
  pendingSubmission: CompanionPendingSubmission,
): CompanionSettings {
  return { ...current, pendingSubmission };
}

export function withoutCompanionPendingSubmission(current: CompanionSettings): CompanionSettings {
  const { pendingSubmission: _pendingSubmission, ...rest } = current;
  return rest;
}
