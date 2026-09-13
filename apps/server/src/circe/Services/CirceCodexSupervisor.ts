import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { CirceSemanticProposal } from "@circe/core/command";

/**
 * Direct supervisor over the ChatGPT Codex Responses backend.
 *
 * Task providers stay exactly as T3 Code ships them. This tier exists only for
 * the one-shot semantic supervisor call: it reuses the user's own Codex/ChatGPT
 * subscription credentials and posts a minimal, tool-free request with
 * `reasoning.effort: "none"`, which the fx harness cannot express. The outcome
 * is a nonauthoritative proposal, validated by the host like any other, so this
 * tier can only remove latency, never authority.
 */
export type CirceCodexSupervisorDeclineReason =
  | "codex-supervisor-disabled"
  | "codex-supervisor-unavailable"
  | "codex-supervisor-unauthenticated"
  | "codex-supervisor-refresh-failed"
  | "codex-supervisor-timeout"
  | "codex-supervisor-error"
  | "codex-supervisor-malformed";

export type CirceCodexSupervisorOutcome =
  | { readonly status: "proposal"; readonly proposal: CirceSemanticProposal }
  | { readonly status: "decline"; readonly reason: CirceCodexSupervisorDeclineReason };

export interface CirceCodexSupervisorAvailability {
  readonly available: boolean;
  /** Active model the request will use. */
  readonly model?: string;
}

export class CirceCodexSupervisor extends Context.Service<
  CirceCodexSupervisor,
  {
    readonly availability: Effect.Effect<CirceCodexSupervisorAvailability>;
    readonly interpret: (input: {
      readonly prompt: string;
      /** Codex model slug; absent uses the resolved default. */
      readonly model?: string;
    }) => Effect.Effect<CirceCodexSupervisorOutcome>;
  }
>()("@absterrg0/circe/circe/Services/CirceCodexSupervisor") {}

export const CIRCE_CODEX_RESPONSES_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
export const CIRCE_CODEX_TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
export const CIRCE_CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CIRCE_CODEX_OAUTH_SCOPE = "openid profile email";
export const CIRCE_CODEX_ORIGINATOR = "codex_cli_rs";
export const CIRCE_CODEX_SUPERVISOR_DEFAULT_MODEL = "gpt-5.6-luna";
export const CIRCE_CODEX_SUPERVISOR_REASONING_EFFORT = "none";
/** Request bodies for one supervisor turn are bounded like the provider prompt. */
export const CIRCE_CODEX_SUPERVISOR_MAX_PROMPT_CHARS = 32_000;

/** Normalized credentials from either the Codex CLI or the fx auth file. */
export type CirceCodexCredentials = {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly accountId?: string;
  readonly expiresAtMs?: number;
};

export type CirceCodexAuthShape = "codex" | "fx";

export type ParsedCirceCodexAuth = {
  readonly shape: CirceCodexAuthShape;
  readonly credentials: CirceCodexCredentials;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const nonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

/** Decode a JWT payload without verifying it; the backend verifies the token. */
export function decodeCirceJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const payload = parts[1];
  if (payload === undefined || payload.length === 0) return null;
  try {
    const decoded = Buffer.from(payload, "base64url").toString("utf8");
    const value: unknown = JSON.parse(decoded);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** ChatGPT account id from the id_token claim the Codex CLI uses. */
export function circeCodexAccountIdFromIdToken(idToken: string | undefined): string | null {
  if (idToken === undefined) return null;
  const payload = decodeCirceJwtPayload(idToken);
  if (payload === null) return null;
  const auth = payload["https://api.openai.com/auth"];
  if (!isRecord(auth)) return null;
  return nonEmptyString(auth["chatgpt_account_id"]);
}

/** Expiry in epoch ms from the access token's `exp` claim. */
export function circeCodexExpiryFromAccessToken(accessToken: string): number | null {
  const payload = decodeCirceJwtPayload(accessToken);
  const exp = payload?.["exp"];
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
}

/**
 * Parse the Codex CLI (`{ tokens: { access_token, ... } }`) or fx
 * (`{ access_token, expires_at_ms, ... }`) auth JSON. Null when no usable
 * access token is present.
 */
export function parseCirceCodexAuth(value: unknown): ParsedCirceCodexAuth | null {
  if (!isRecord(value)) return null;
  const tokens = value["tokens"];
  if (isRecord(tokens)) {
    const accessToken = nonEmptyString(tokens["access_token"]);
    if (accessToken === null) return null;
    const refreshToken = nonEmptyString(tokens["refresh_token"]) ?? undefined;
    const accountId =
      nonEmptyString(tokens["account_id"]) ??
      circeCodexAccountIdFromIdToken(nonEmptyString(tokens["id_token"]) ?? undefined) ??
      undefined;
    const expiresAtMs = circeCodexExpiryFromAccessToken(accessToken) ?? undefined;
    return {
      shape: "codex",
      credentials: {
        accessToken,
        ...(refreshToken === undefined ? {} : { refreshToken }),
        ...(accountId === undefined ? {} : { accountId }),
        ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
      },
    };
  }
  const accessToken = nonEmptyString(value["access_token"]);
  if (accessToken === null) return null;
  const refreshToken = nonEmptyString(value["refresh_token"]) ?? undefined;
  const accountId = nonEmptyString(value["account_id"]) ?? undefined;
  const rawExpiry = value["expires_at_ms"];
  const expiresAtMs =
    typeof rawExpiry === "number" && Number.isFinite(rawExpiry)
      ? rawExpiry
      : (circeCodexExpiryFromAccessToken(accessToken) ?? undefined);
  return {
    shape: "fx",
    credentials: {
      accessToken,
      ...(refreshToken === undefined ? {} : { refreshToken }),
      ...(accountId === undefined ? {} : { accountId }),
      ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
    },
  };
}

/** A token is usable when it is present and not expired within the skew window. */
export function isCirceCodexCredentialFresh(
  credentials: CirceCodexCredentials,
  nowMs: number,
  skewMs: number,
): boolean {
  if (credentials.expiresAtMs === undefined) return true;
  return credentials.expiresAtMs - skewMs > nowMs;
}

/** Merge a refreshed token set back into the source file's shape. */
export function mergeCirceCodexRefreshedAuth(input: {
  readonly shape: CirceCodexAuthShape;
  readonly original: unknown;
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly idToken?: string;
  readonly accountId?: string;
  readonly expiresAtMs?: number;
  readonly refreshedAtIso: string;
}): Record<string, unknown> {
  const original = isRecord(input.original) ? input.original : {};
  if (input.shape === "fx") {
    return {
      ...original,
      access_token: input.accessToken,
      refresh_token: input.refreshToken ?? original["refresh_token"] ?? null,
      account_id: input.accountId ?? original["account_id"] ?? null,
      expires_at_ms:
        input.expiresAtMs ?? circeCodexExpiryFromAccessToken(input.accessToken) ?? null,
    };
  }
  const existingTokens = isRecord(original["tokens"]) ? original["tokens"] : {};
  return {
    ...original,
    tokens: {
      ...existingTokens,
      access_token: input.accessToken,
      refresh_token: input.refreshToken ?? existingTokens["refresh_token"] ?? null,
      id_token: input.idToken ?? existingTokens["id_token"] ?? null,
      account_id:
        input.accountId ??
        circeCodexAccountIdFromIdToken(input.idToken) ??
        existingTokens["account_id"] ??
        null,
    },
    last_refresh: input.refreshedAtIso,
  };
}

/** The minimal tool-free request body the supervisor needs. */
export function buildCirceCodexResponsesBody(input: {
  readonly model: string;
  readonly prompt: string;
  readonly instructions: string;
}): Record<string, unknown> {
  return {
    model: input.model,
    store: false,
    stream: true,
    instructions: input.instructions,
    input: [{ role: "user", content: input.prompt }],
    tools: [],
    tool_choice: "auto",
    parallel_tool_calls: true,
    include: ["reasoning.encrypted_content"],
    text: { verbosity: "low" },
    reasoning: { effort: CIRCE_CODEX_SUPERVISOR_REASONING_EFFORT, summary: "auto" },
  };
}

export type CirceCodexSseEvent =
  | { readonly type: "text"; readonly delta: string }
  | {
      readonly type: "completed";
      readonly text: string | null;
      readonly outputTokens: number | null;
    }
  | { readonly type: "failed"; readonly message: string | null }
  | { readonly type: "ignore" };

const textFromCompletedOutput = (value: unknown): string | null => {
  if (!isRecord(value)) return null;
  const output = value["output"];
  if (!Array.isArray(output)) return null;
  const parts: string[] = [];
  for (const item of output) {
    if (!isRecord(item)) continue;
    const content = item["content"];
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!isRecord(part)) continue;
      if (part["type"] === "output_text" && typeof part["text"] === "string") {
        parts.push(part["text"]);
      }
    }
  }
  return parts.length === 0 ? null : parts.join("");
};

/** Translate one Responses SSE event into the small set the supervisor uses. */
export function interpretCirceCodexSseEvent(value: unknown): CirceCodexSseEvent {
  if (!isRecord(value)) return { type: "ignore" };
  const type = typeof value["type"] === "string" ? value["type"] : "";
  if (type.includes("output_text") && typeof value["delta"] === "string") {
    return { type: "text", delta: value["delta"] };
  }
  if (type === "response.completed") {
    const response = value["response"];
    const usage = isRecord(response) ? response["usage"] : undefined;
    const outputTokens =
      isRecord(usage) && typeof usage["output_tokens"] === "number" ? usage["output_tokens"] : null;
    return {
      type: "completed",
      text: textFromCompletedOutput(response),
      outputTokens,
    };
  }
  if (type === "response.failed" || type === "error") {
    const error = value["error"];
    const message =
      isRecord(error) && typeof error["message"] === "string"
        ? error["message"]
        : typeof value["message"] === "string"
          ? value["message"]
          : null;
    return { type: "failed", message };
  }
  return { type: "ignore" };
}

/**
 * First balanced JSON object inside assistant text. Models sometimes wrap the
 * proposal in a sentence or a code fence; the host still validates every field
 * after decoding, so extraction only needs to be honest, not clever.
 */
export function extractCirceCodexJsonObject(text: string): unknown | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (character === undefined) break;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") {
      depth += 1;
      continue;
    }
    if (character !== "}") continue;
    depth -= 1;
    if (depth !== 0) continue;
    try {
      return JSON.parse(text.slice(start, index + 1));
    } catch {
      return null;
    }
  }
  return null;
}
