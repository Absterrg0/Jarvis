// @effect-diagnostics nodeBuiltinImport:off - sealed final corpus lives outside the repo by design.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { JarvisSemanticEvalCaseV2 } from "./jarvisSemanticEvalEngine.ts";

export const FINAL_DIR_DEFAULT = "/tmp/opencode/jarvis-semantic-final";
export const FINAL_MIN_CASES = 40;
export const FINAL_REPEAT_CASES = 10;
export const FINAL_REPEAT_TIMES = 3;
export const FINAL_MAX_CALLS = 70;

export type FinalMeta = {
  readonly reviewed: "synthetic-unreviewed";
  readonly families: ReadonlyArray<string>;
  readonly createdAt: string;
  readonly note: string;
};

export type FinalLoadResult =
  | {
      readonly status: "ok";
      readonly cases: ReadonlyArray<JarvisSemanticEvalCaseV2>;
      readonly meta: FinalMeta;
    }
  | { readonly status: "missing"; readonly dir: string }
  | { readonly status: "invalid"; readonly reason: string };

const REQUIRED_FAMILIES = [
  "complete-command",
  "destination-mention",
  "negation-constraint",
  "compound-multi",
  "correction-asr-alias",
  "provider-routing",
  "ambiguity-clarification",
] as const;

/** Load sealed final corpus from outside the repo. Never bundles utterances in-repo. */
export function loadFinalCorpus(
  dir: string = FINAL_DIR_DEFAULT,
  includeRepeats: boolean = false,
): FinalLoadResult {
  if (!NodeFS.existsSync(dir)) return { status: "missing", dir };
  const casesPath = NodePath.join(dir, "cases.json");
  const repeatsPath = NodePath.join(dir, "repeats.json");
  const metaPath = NodePath.join(dir, "meta.json");
  if (!NodeFS.existsSync(casesPath) || !NodeFS.existsSync(metaPath)) {
    return { status: "missing", dir };
  }
  let casesRaw: unknown;
  let metaRaw: unknown;
  try {
    casesRaw = JSON.parse(NodeFS.readFileSync(casesPath, "utf8"));
    metaRaw = JSON.parse(NodeFS.readFileSync(metaPath, "utf8"));
  } catch (error) {
    return {
      status: "invalid",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (!Array.isArray(casesRaw)) return { status: "invalid", reason: "cases.json is not an array" };
  if (typeof metaRaw !== "object" || metaRaw === null || Array.isArray(metaRaw)) {
    return { status: "invalid", reason: "meta.json must be an object" };
  }
  const meta = metaRaw as FinalMeta;
  if (meta.reviewed !== "synthetic-unreviewed") {
    return { status: "invalid", reason: "meta.json reviewed must be synthetic-unreviewed" };
  }
  if (casesRaw.length < FINAL_MIN_CASES) {
    return {
      status: "invalid",
      reason: `final needs at least ${FINAL_MIN_CASES} cases, saw ${casesRaw.length}`,
    };
  }
  const ids = new Set<string>();
  const cases: Array<JarvisSemanticEvalCaseV2> = [];
  for (const [index, entry] of casesRaw.entries()) {
    const check = checkFinalCase(entry, index);
    if (check !== null) return { status: "invalid", reason: check };
    const typed = entry as JarvisSemanticEvalCaseV2;
    if (ids.has(typed.id)) return { status: "invalid", reason: `duplicate final id ${typed.id}` };
    ids.add(typed.id);
    if (typed.split !== "final") {
      return { status: "invalid", reason: `${typed.id} split must be final` };
    }
    if (typed.fixtureProposal !== undefined) {
      return { status: "invalid", reason: `${typed.id} sealed final must not carry fixtures` };
    }
    cases.push(typed);
  }
  const families = new Set(cases.map((entry) => entry.family));
  for (const required of REQUIRED_FAMILIES) {
    if (!families.has(required)) {
      return { status: "invalid", reason: `final missing family ${required}` };
    }
  }
  if (!includeRepeats) return { status: "ok", cases, meta };
  if (!NodeFS.existsSync(repeatsPath)) {
    return { status: "invalid", reason: "repeats.json missing for --include-repeats" };
  }
  let repeatsRaw: unknown;
  try {
    repeatsRaw = JSON.parse(NodeFS.readFileSync(repeatsPath, "utf8"));
  } catch (error) {
    return { status: "invalid", reason: error instanceof Error ? error.message : String(error) };
  }
  const repeatIds =
    typeof repeatsRaw === "object" && repeatsRaw !== null && !Array.isArray(repeatsRaw)
      ? (repeatsRaw as { repeatIds?: unknown }).repeatIds
      : undefined;
  if (!Array.isArray(repeatIds) || repeatIds.length !== FINAL_REPEAT_CASES) {
    return {
      status: "invalid",
      reason: `repeats.json must list exactly ${FINAL_REPEAT_CASES} ids`,
    };
  }
  const byId = new Map(cases.map((entry) => [entry.id, entry]));
  const expanded: Array<JarvisSemanticEvalCaseV2> = [...cases];
  for (const id of repeatIds) {
    if (typeof id !== "string" || !byId.has(id)) {
      return { status: "invalid", reason: `repeat id ${String(id)} not in final cases` };
    }
    const original = byId.get(id)!;
    for (let attempt = 1; attempt <= FINAL_REPEAT_TIMES; attempt += 1) {
      expanded.push({
        ...original,
        id: `${original.id}__r${attempt}`,
        repeatOf: original.id,
        repeatIndex: attempt,
      });
    }
  }
  if (expanded.length > FINAL_MAX_CALLS) {
    return {
      status: "invalid",
      reason: `final with repeats is ${expanded.length} calls, max ${FINAL_MAX_CALLS}`,
    };
  }
  return { status: "ok", cases: expanded, meta };
}

function checkFinalCase(entry: unknown, index: number): string | null {
  if (typeof entry !== "object" || entry === null) return `final[${index}] is not an object`;
  const typed = entry as Record<string, unknown>;
  if (typeof typed.id !== "string" || typed.id.length === 0) return `final[${index}] needs id`;
  if (typeof typed.utterance !== "string" || typed.utterance.length === 0) {
    return `${String(typed.id)} needs utterance`;
  }
  if (typeof typed.action !== "string" || typed.action.length === 0) {
    return `${String(typed.id)} needs action`;
  }
  if (typeof typed.family !== "string" || typed.family.length === 0) {
    return `${String(typed.id)} needs family`;
  }
  if (typed.expectedInstruction !== undefined && typeof typed.expectedInstruction !== "string") {
    return `${String(typed.id)} expectedInstruction must be a string`;
  }
  if (
    typed.expectedAck !== undefined &&
    typed.expectedAck !== null &&
    typeof typed.expectedAck !== "string"
  ) {
    return `${String(typed.id)} expectedAck must be string or null`;
  }
  return null;
}
