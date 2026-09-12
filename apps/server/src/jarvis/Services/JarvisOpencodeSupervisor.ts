import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { JarvisSemanticProposal } from "@t3tools/jarvis-core/command";

/**
 * Direct supervisor over the OpenCode gateway. Like the Codex and Grok tiers,
 * it exists only for the one-shot semantic supervisor call and is derived from
 * the provider the user is actually running: an OpenCode user supervises on
 * their own OpenCode subscription, never on another provider's quota. The
 * outcome is a nonauthoritative proposal, validated by the host like any other.
 */
export type JarvisOpencodeSupervisorDeclineReason =
  | "opencode-supervisor-disabled"
  | "opencode-supervisor-unavailable"
  | "opencode-supervisor-unauthenticated"
  | "opencode-supervisor-timeout"
  | "opencode-supervisor-error"
  | "opencode-supervisor-malformed";

export type JarvisOpencodeSupervisorOutcome =
  | { readonly status: "proposal"; readonly proposal: JarvisSemanticProposal }
  | { readonly status: "decline"; readonly reason: JarvisOpencodeSupervisorDeclineReason };

export interface JarvisOpencodeSupervisorAvailability {
  readonly available: boolean;
  /** Gateway the active model resolves to. */
  readonly route?: "go" | "zen";
  /** Cheap supervisor model used on that gateway. */
  readonly model?: string;
}

export class JarvisOpencodeSupervisor extends Context.Service<
  JarvisOpencodeSupervisor,
  {
    readonly availability: Effect.Effect<JarvisOpencodeSupervisorAvailability>;
    readonly interpret: (input: {
      readonly prompt: string;
      /** Active opencode model slug (`opencode-go/...` or `opencode/...`). */
      readonly model?: string;
    }) => Effect.Effect<JarvisOpencodeSupervisorOutcome>;
  }
>()("t3/jarvis/Services/JarvisOpencodeSupervisor") {}

export const JARVIS_OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";
export const JARVIS_OPENCODE_ZEN_BASE_URL = "https://opencode.ai/zen/v1";
export const JARVIS_OPENCODE_SESSION_HEADER = "x-opencode-session";
/** Cheapest/fastest model each gateway exposes, measured for the router task. */
export const JARVIS_OPENCODE_GO_SUPERVISOR_MODEL = "deepseek-flash";
export const JARVIS_OPENCODE_ZEN_SUPERVISOR_MODEL = "gpt-5.4-nano";
export const JARVIS_OPENCODE_SUPERVISOR_MAX_PROMPT_CHARS = 32_000;

export type JarvisOpencodeAuth = {
  readonly go?: string;
  readonly zen?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const apiKeyOf = (value: unknown): string | undefined => {
  if (!isRecord(value)) return undefined;
  const key = value["key"];
  return typeof key === "string" && key.trim().length > 0 ? key : undefined;
};

/** Read the two OpenCode gateway keys from `auth.json`. */
export function parseJarvisOpencodeAuth(value: unknown): JarvisOpencodeAuth {
  if (!isRecord(value)) return {};
  const go = apiKeyOf(value["opencode-go"]);
  const zen = apiKeyOf(value["opencode"]);
  return { ...(go === undefined ? {} : { go }), ...(zen === undefined ? {} : { zen }) };
}

export type JarvisOpencodeRoute = {
  readonly route: "go" | "zen";
  readonly baseUrl: string;
  readonly key: string;
  readonly model: string;
};

/** Resolve the gateway from the active model slug; unknown slugs use Go. */
export function resolveJarvisOpencodeRoute(input: {
  readonly auth: JarvisOpencodeAuth;
  readonly model?: string;
  readonly goModel?: string;
  readonly zenModel?: string;
}): JarvisOpencodeRoute | null {
  const slug = input.model?.trim() ?? "";
  const zenPreferred = slug.startsWith("opencode/");
  const go = input.auth.go;
  const zen = input.auth.zen;
  if (zenPreferred) {
    if (zen === undefined) return null;
    return {
      route: "zen",
      baseUrl: JARVIS_OPENCODE_ZEN_BASE_URL,
      key: zen,
      model: input.zenModel?.trim() || JARVIS_OPENCODE_ZEN_SUPERVISOR_MODEL,
    };
  }
  if (go !== undefined) {
    return {
      route: "go",
      baseUrl: JARVIS_OPENCODE_GO_BASE_URL,
      key: go,
      model: input.goModel?.trim() || JARVIS_OPENCODE_GO_SUPERVISOR_MODEL,
    };
  }
  if (zen !== undefined) {
    return {
      route: "zen",
      baseUrl: JARVIS_OPENCODE_ZEN_BASE_URL,
      key: zen,
      model: input.zenModel?.trim() || JARVIS_OPENCODE_ZEN_SUPERVISOR_MODEL,
    };
  }
  return null;
}

/**
 * Minimal OpenAI-compatible chat body for the supervisor call. `json_object`
 * keeps reasoning models from streaming prose or partial objects, which is
 * what made the direct tier flaky and slow.
 */
export function buildJarvisOpencodeChatBody(input: {
  readonly model: string;
  readonly prompt: string;
  readonly instructions: string;
}): Record<string, unknown> {
  return {
    model: input.model,
    stream: true,
    response_format: { type: "json_object" },
    // These flash models reason by default; the supervisor only classifies,
    // so turn reasoning off. Measured ~4.4s -> ~2.5s on a realistic prompt.
    reasoning_effort: "none",
    messages: [
      { role: "system", content: input.instructions },
      { role: "user", content: input.prompt },
    ],
  };
}

export type JarvisOpencodeSseEvent =
  | { readonly type: "text"; readonly delta: string }
  | { readonly type: "done" }
  | { readonly type: "ignore" };

/** Extract assistant content from an OpenAI-compatible chat stream chunk. */
export function interpretJarvisOpencodeSseEvent(value: unknown): JarvisOpencodeSseEvent {
  if (!isRecord(value)) return { type: "ignore" };
  const choices = value["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return { type: "ignore" };
  const first = choices[0];
  if (!isRecord(first)) return { type: "ignore" };
  const delta = first["delta"];
  const content = isRecord(delta) ? delta["content"] : undefined;
  if (typeof content === "string" && content.length > 0) {
    return { type: "text", delta: content };
  }
  return { type: "ignore" };
}
