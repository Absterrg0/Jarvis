import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { JarvisSemanticProposal } from "@t3tools/jarvis-core/command";

/**
 * Direct supervisor over the xAI Grok CLI proxy. T3 runs Grok through the
 * official `grok` CLI harness (ACP); the supervisor only classifies, so it
 * talks to the same subscription endpoint the CLI uses, with a minimal
 * tool-free body and the lowest reasoning effort. Non-authoritative like every
 * other supervisor tier.
 */
export type JarvisGrokSupervisorDeclineReason =
  | "grok-supervisor-disabled"
  | "grok-supervisor-unavailable"
  | "grok-supervisor-unauthenticated"
  | "grok-supervisor-timeout"
  | "grok-supervisor-error"
  | "grok-supervisor-malformed";

export type JarvisGrokSupervisorOutcome =
  | { readonly status: "proposal"; readonly proposal: JarvisSemanticProposal }
  | { readonly status: "decline"; readonly reason: JarvisGrokSupervisorDeclineReason };

export interface JarvisGrokSupervisorAvailability {
  readonly available: boolean;
  readonly model?: string;
}

export class JarvisGrokSupervisor extends Context.Service<
  JarvisGrokSupervisor,
  {
    readonly availability: Effect.Effect<JarvisGrokSupervisorAvailability>;
    readonly interpret: (input: {
      readonly prompt: string;
      readonly model?: string;
    }) => Effect.Effect<JarvisGrokSupervisorOutcome>;
  }
>()("t3/jarvis/Services/JarvisGrokSupervisor") {}

export const JARVIS_GROK_RESPONSES_ENDPOINT = "https://cli-chat-proxy.grok.com/v1/responses";
export const JARVIS_GROK_TOKEN_ENDPOINT = "https://auth.x.ai/oauth2/token";
export const JARVIS_GROK_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const JARVIS_GROK_CLIENT_IDENTIFIER = "fx";
export const JARVIS_GROK_SUPERVISOR_DEFAULT_MODEL = "grok-4.6";
export const JARVIS_GROK_SUPERVISOR_REASONING_EFFORT = "low";
export const JARVIS_GROK_SUPERVISOR_MAX_PROMPT_CHARS = 32_000;
export const JARVIS_GROK_DEFAULT_CLIENT_VERSION = "1.0.25";

export type JarvisGrokCredentials = {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly accountId?: string;
  readonly expiresAtMs?: number;
};

export type JarvisGrokAuthShape = "grok-cli" | "fx";

export type ParsedJarvisGrokAuth = {
  readonly shape: JarvisGrokAuthShape;
  readonly credentials: JarvisGrokCredentials;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const nonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

const epochMsFromIso = (value: unknown): number | undefined => {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * The Grok CLI stores `{ "<issuer>::<clientId>": { key, refresh_token, user_id,
 * expires_at } }`; fx stores a flat `{ access_token, refresh_token,
 * expires_at_ms, account_id }`. Accept both.
 */
export function parseJarvisGrokAuth(value: unknown): ParsedJarvisGrokAuth | null {
  if (!isRecord(value)) return null;
  const flatToken = nonEmptyString(value["access_token"]);
  if (flatToken !== null) {
    const refreshToken = nonEmptyString(value["refresh_token"]) ?? undefined;
    const accountId = nonEmptyString(value["account_id"]) ?? undefined;
    const rawExpiry = value["expires_at_ms"];
    const expiresAtMs =
      typeof rawExpiry === "number" && Number.isFinite(rawExpiry) ? rawExpiry : undefined;
    return {
      shape: "fx",
      credentials: {
        accessToken: flatToken,
        ...(refreshToken === undefined ? {} : { refreshToken }),
        ...(accountId === undefined ? {} : { accountId }),
        ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
      },
    };
  }
  for (const entry of Object.values(value)) {
    if (!isRecord(entry)) continue;
    const key = nonEmptyString(entry["key"]);
    if (key === null) continue;
    const refreshToken = nonEmptyString(entry["refresh_token"]) ?? undefined;
    const accountId =
      nonEmptyString(entry["user_id"]) ?? nonEmptyString(entry["principal_id"]) ?? undefined;
    const expiresAtMs = epochMsFromIso(entry["expires_at"]);
    return {
      shape: "grok-cli",
      credentials: {
        accessToken: key,
        ...(refreshToken === undefined ? {} : { refreshToken }),
        ...(accountId === undefined ? {} : { accountId }),
        ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
      },
    };
  }
  return null;
}

/** A token is usable when present and not expired within the skew window. */
export function isGrokCredentialFresh(
  credentials: JarvisGrokCredentials,
  nowMs: number,
  skewMs: number,
): boolean {
  if (credentials.expiresAtMs === undefined) return true;
  return credentials.expiresAtMs - skewMs > nowMs;
}

/** Merge a refreshed token set back into the source file's shape. */
export function mergeJarvisGrokRefreshedAuth(input: {
  readonly shape: JarvisGrokAuthShape;
  readonly original: unknown;
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAtMs?: number;
  readonly expiresAtIso?: string;
}): Record<string, unknown> {
  const original = isRecord(input.original) ? input.original : {};
  if (input.shape === "fx") {
    return {
      ...original,
      access_token: input.accessToken,
      refresh_token: input.refreshToken ?? original["refresh_token"] ?? null,
      expires_at_ms: input.expiresAtMs ?? original["expires_at_ms"] ?? null,
    };
  }
  const [firstKey, firstEntry] = Object.entries(original)[0] ?? [];
  if (firstKey === undefined || !isRecord(firstEntry)) return { ...original };
  return {
    ...original,
    [firstKey]: {
      ...firstEntry,
      key: input.accessToken,
      refresh_token: input.refreshToken ?? firstEntry["refresh_token"] ?? null,
      ...(input.expiresAtIso === undefined ? {} : { expires_at: input.expiresAtIso }),
    },
  };
}

/** Minimal Responses body for Grok. It rejects tool_choice with no tools. */
export function buildJarvisGrokResponsesBody(input: {
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
    include: ["reasoning.encrypted_content"],
    text: { verbosity: "low" },
    reasoning: { effort: JARVIS_GROK_SUPERVISOR_REASONING_EFFORT, summary: "auto" },
  };
}
