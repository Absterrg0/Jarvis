export type ApprovalRisk =
  | "read"
  | "read-and-compute"
  | "workspace-write"
  | "external-effect"
  | "destructive"
  | "unknown";

export type ApprovalDescription = {
  readonly spoken: string;
  readonly risk: ApprovalRisk;
  readonly rawDetail: string;
};

const APPROVAL_RISKS: ReadonlySet<string> = new Set([
  "read",
  "read-and-compute",
  "workspace-write",
  "external-effect",
  "destructive",
  "unknown",
]);

function isApprovalRisk(value: string): value is ApprovalRisk {
  return APPROVAL_RISKS.has(value);
}

function compact(value: string): string {
  if (typeof value !== "string") return "";
  const withoutControls = [...value]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join("");
  return withoutControls.replace(/\s+/gu, " ").trim();
}

function safeLabel(value: string | undefined): string | undefined {
  const normalized = value === undefined ? "" : compact(value);
  if (normalized.length === 0) return undefined;
  return normalized.length <= 120 ? normalized : `${normalized.slice(0, 119).trim()}…`;
}

function safeDetail(value: string): string {
  const normalized = compact(value);
  return normalized.length <= 16_000 ? normalized : `${normalized.slice(0, 15_999).trim()}…`;
}

const KNOWN_REQUEST_LABELS: ReadonlySet<string> = new Set([
  "file-read",
  "file_read_approval",
  "file-change",
  "file_change_approval",
  "apply_patch_approval",
  "mcp-elicitation",
  "mcp_elicitation_approval",
]);

/** Prefer the kind when it maps; an unmapped kind falls back to the type. */
function requestLabel(requestKind?: string, requestType?: string): string | undefined {
  if (requestKind !== undefined && KNOWN_REQUEST_LABELS.has(requestKind)) return requestKind;
  return requestType;
}

function riskFromRequest(requestKind?: string, requestType?: string): ApprovalRisk {
  switch (requestLabel(requestKind, requestType)) {
    case "file-read":
    case "file_read_approval":
      return "read";
    case "file-change":
    case "file_change_approval":
    case "apply_patch_approval":
      return "workspace-write";
    case "mcp-elicitation":
    case "mcp_elicitation_approval":
      return "external-effect";
    default:
      return "unknown";
  }
}

function requestDescription(
  requestKind: string | undefined,
  requestType: string | undefined,
  toolName: string | undefined,
  command: string | undefined,
): string {
  if (toolName !== undefined) return `use ${toolName}`;
  if (command !== undefined) return "run the provided command";
  switch (requestLabel(requestKind, requestType)) {
    case "file-read":
    case "file_read_approval":
      return "read the provided files";
    case "file-change":
    case "file_change_approval":
    case "apply_patch_approval":
      return "modify the provided files";
    default:
      return "an operation requested by the provider";
  }
}

/** Describes only approval metadata. It never interprets shell syntax or provider prose. */
export function describeApproval(input: {
  readonly requestKind?: string;
  readonly requestType?: string;
  readonly toolName?: string;
  readonly command?: string;
  readonly risk?: string;
  readonly detail?: string;
  readonly projectTitle: string;
}): ApprovalDescription {
  const rawDetail = safeDetail(input.detail ?? "") || safeDetail(input.command ?? "");
  const toolName = safeLabel(input.toolName);
  const command = safeLabel(input.command);
  const risk =
    typeof input.risk === "string" && isApprovalRisk(input.risk)
      ? input.risk
      : riskFromRequest(input.requestKind, input.requestType);
  const hasStructuredRequest =
    input.requestKind !== undefined ||
    input.requestType !== undefined ||
    toolName !== undefined ||
    command !== undefined ||
    input.risk !== undefined;
  const action = hasStructuredRequest
    ? requestDescription(input.requestKind, input.requestType, toolName, command)
    : undefined;
  const riskNote = risk === "unknown" ? "" : ` Risk level: ${risk}.`;
  return {
    spoken:
      action === undefined
        ? `The provider is requesting approval in ${input.projectTitle}. Allow it?`
        : `The agent is requesting permission to ${action} in ${input.projectTitle}.${riskNote} Allow it?`,
    risk,
    rawDetail,
  };
}
