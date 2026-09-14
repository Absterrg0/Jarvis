import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { CirceSemanticProposal } from "@circe/core/command";

/**
 * Fast supervisor inference through the user's existing fx login.
 *
 * Task providers stay exactly as T3 Code ships them. This tier exists only
 * for the semantic supervisor call: spawning the Codex/Claude harness for a
 * one-shot JSON classification costs seconds of startup, while `fx` is a
 * small native binary that answers in the same time the model takes. The
 * outcome is a nonauthoritative proposal; the host still validates it like
 * any other, so this tier can only remove latency, never authority.
 */
export type CirceFastSupervisorDeclineReason =
  | "fast-supervisor-disabled"
  | "fast-supervisor-unavailable"
  | "fast-supervisor-unauthenticated"
  | "fast-supervisor-model-mismatch"
  | "fast-supervisor-timeout"
  | "fast-supervisor-error"
  | "fast-supervisor-malformed";

export type CirceFastSupervisorOutcome =
  | { readonly status: "proposal"; readonly proposal: CirceSemanticProposal }
  | { readonly status: "decline"; readonly reason: CirceFastSupervisorDeclineReason };

export interface CirceFastSupervisorAvailability {
  readonly available: boolean;
  /** Active fx model, for family matching against the configured supervisor. */
  readonly model?: string;
}

export class CirceFastSupervisor extends Context.Service<
  CirceFastSupervisor,
  {
    readonly availability: Effect.Effect<CirceFastSupervisorAvailability>;
    readonly interpret: (input: {
      readonly prompt: string;
      /** fx model id (`FX_MODEL`); absent uses the user's active fx model. */
      readonly model?: string;
    }) => Effect.Effect<CirceFastSupervisorOutcome>;
  }
>()("@absterrg0/circe/circe/Services/CirceFastSupervisor") {}

/** Request bodies for one supervisor turn are bounded like the provider prompt. */
export const CIRCE_FAST_SUPERVISOR_MAX_PROMPT_CHARS = 32_000;

/**
 * Replaces fx's coding-agent base prompt: strict JSON router, no tools. fx
 * cannot enforce an output schema the way the provider path can, so the exact
 * proposal shape is stated here as well as in the compact prompt.
 */
export const CIRCE_FAST_SUPERVISOR_SYSTEM_PROMPT = [
  "You are a strict semantic router for Circe. Reply with exactly one JSON object and nothing else: no prose, no markdown, no code fences, no tools.",
  'Shape: {"action":"start|continue|steer|queue|stop|status|review|reroute|focus-project|focus-task|list-projects|converse|lookup|open-website|unsupported","refs":[{"span":{"start":number,"end":number,"text":string},"role":"destination|task|subject|excluded|correction|provider","value":string}],"model":string|null,"effort":string|null,"answer":string|null,"lookup":{"kind":"weather|time","location":string,"day":"now|today|tomorrow"}|null,"website":string|null}',
  "span.start and span.end are UTF-16 offsets into the Original transcript and span.text is exactly that slice. Use [] for refs, and null for unspecified model, effort, answer, lookup, and website.",
  "A weather or local-time question is lookup with lookup.location copied verbatim and day now|today|tomorrow; a request to open a named site or web URL is open-website with website set to it. Neither takes refs.",
].join("\n");

export interface FxStatusSummary {
  readonly auth: string | null;
  readonly model: string | null;
}

/** Parse the `[status] key=value` lines fx prints for `fx status`. */
export function parseFxStatusOutput(stdout: string): FxStatusSummary {
  const field = (key: string): string | null => {
    const match = new RegExp(`^\\[status\\]\\s+${key}=(.*)$`, "mu").exec(stdout);
    const value = match?.[1]?.trim() ?? "";
    return value.length === 0 ? null : value;
  };
  return { auth: field("auth"), model: field("model") };
}

/** An fx session is usable for supervision only when authenticated with a model. */
export function isFxStatusAuthenticated(summary: FxStatusSummary): boolean {
  return summary.auth !== null && summary.auth !== "missing" && summary.model !== null;
}

/**
 * `fx ask --json` wraps the assistant text in an envelope. `final_output` is
 * the completed response; `output` is the accumulated markdown fallback.
 */
export function fxAssistantTextFromEnvelope(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as { readonly final_output?: unknown; readonly output?: unknown };
  if (typeof record.final_output === "string" && record.final_output.trim().length > 0) {
    return record.final_output;
  }
  if (typeof record.output === "string" && record.output.trim().length > 0) {
    return record.output;
  }
  return null;
}

/**
 * First balanced JSON object inside assistant text. Models sometimes wrap the
 * proposal in a sentence or a code fence; the host still validates every field
 * after decoding, so extraction only needs to be honest, not clever.
 */
export function extractJsonObjectFromText(text: string): unknown | null {
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
