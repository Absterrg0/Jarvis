import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { CirceSemanticProposal } from "@circe/core/command";

/**
 * Direct supervisor over the xAI Grok CLI proxy. T3 runs Grok through the
 * official `grok` CLI harness (ACP); the supervisor only classifies, so it
 * talks to the same subscription endpoint the CLI uses, with a minimal
 * tool-free body and the lowest reasoning effort. Non-authoritative like every
 * other supervisor tier.
 */
export type CirceGrokSupervisorDeclineReason =
  | "grok-supervisor-disabled"
  | "grok-supervisor-unavailable"
  | "grok-supervisor-unauthenticated"
  | "grok-supervisor-timeout"
  | "grok-supervisor-error"
  | "grok-supervisor-malformed";

export type CirceGrokSupervisorOutcome =
  | { readonly status: "proposal"; readonly proposal: CirceSemanticProposal }
  | { readonly status: "decline"; readonly reason: CirceGrokSupervisorDeclineReason };

export interface CirceGrokSupervisorAvailability {
  readonly available: boolean;
  readonly model?: string;
}

export class CirceGrokSupervisor extends Context.Service<
  CirceGrokSupervisor,
  {
    readonly availability: Effect.Effect<CirceGrokSupervisorAvailability>;
    readonly interpret: (input: {
      readonly prompt: string;
      readonly model?: string;
    }) => Effect.Effect<CirceGrokSupervisorOutcome>;
  }
>()("@absterrg0/circe/circe/Services/CirceGrokSupervisor") {}

export const CIRCE_GROK_RESPONSES_ENDPOINT = "https://cli-chat-proxy.grok.com/v1/responses";
export const CIRCE_GROK_TOKEN_ENDPOINT = "https://auth.x.ai/oauth2/token";
export const CIRCE_GROK_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const CIRCE_GROK_CLIENT_IDENTIFIER = "fx";
export const CIRCE_GROK_SUPERVISOR_DEFAULT_MODEL = "grok-4.6";
export const CIRCE_GROK_SUPERVISOR_REASONING_EFFORT = "low";
export const CIRCE_GROK_SUPERVISOR_MAX_PROMPT_CHARS = 32_000;
export const CIRCE_GROK_DEFAULT_CLIENT_VERSION = "1.0.25";

export type CirceGrokCredentials = {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly accountId?: string;
  readonly expiresAtMs?: number;
};

export type CirceGrokAuthShape = "grok-cli" | "fx";

export type ParsedCirceGrokAuth =
  | {
      readonly shape: "grok-cli";
      readonly key: string;
      readonly credentials: CirceGrokCredentials;
    }
  | {
      readonly shape: "fx";
      readonly credentials: CirceGrokCredentials;
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
export function parseCirceGrokAuth(value: unknown): ParsedCirceGrokAuth | null {
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
  for (const [objectKey, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue;
    const key = nonEmptyString(entry["key"]);
    if (key === null) continue;
    const refreshToken = nonEmptyString(entry["refresh_token"]) ?? undefined;
    const accountId =
      nonEmptyString(entry["user_id"]) ?? nonEmptyString(entry["principal_id"]) ?? undefined;
    const expiresAtMs = epochMsFromIso(entry["expires_at"]);
    return {
      shape: "grok-cli",
      key: objectKey,
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
  credentials: CirceGrokCredentials,
  nowMs: number,
  skewMs: number,
): boolean {
  if (credentials.expiresAtMs === undefined) return true;
  return credentials.expiresAtMs - skewMs > nowMs;
}

/** Merge a refreshed token set back into the source file's shape. */
export function mergeCirceGrokRefreshedAuth(input: {
  readonly shape: CirceGrokAuthShape;
  readonly original: unknown;
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAtMs?: number;
  readonly expiresAtIso?: string;
  readonly key?: string;
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
  if (input.key !== undefined) {
    const selected = original[input.key];
    if (!isRecord(selected)) return { ...original };
    return {
      ...original,
      [input.key]: {
        ...selected,
        key: input.accessToken,
        refresh_token: input.refreshToken ?? selected["refresh_token"] ?? null,
        ...(input.expiresAtIso === undefined ? {} : { expires_at: input.expiresAtIso }),
      },
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
export function buildCirceGrokResponsesBody(input: {
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
    reasoning: { effort: CIRCE_GROK_SUPERVISOR_REASONING_EFFORT, summary: "auto" },
  };
}
