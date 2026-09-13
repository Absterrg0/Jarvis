import type { CirceCommandContext } from "./command.ts";
import type { CirceSemanticProposal, SemanticRef, SemanticRole } from "./semanticEvidence.ts";
import {
  isInCirceNegationScope,
  normalizeDestinationPhrase,
  stripDestinationQuotes,
  stripCirceInvocation,
} from "./destinationSpan.ts";
import { groupCirceAliasesByProject } from "./buildProjectVocabulary.ts";
import { semanticBasename } from "./semantic.ts";

/**
 * Bounded closed grammar for one Circe turn. Proposes only for a small
 * full-structure subset over catalog names and declines everything else to
 * the provider tier. No model, no phonetics, no IDs.
 *
 * Closed set:
 * - exact list / bare status / bare stop / focus-project / focus-task /
 *   status-of-task / stop-task over exact catalog spans;
 * - start as `<work-verb> <single object> in <name>` or
 *   `In <name>, <work-verb> <single object>`, full-turn match only.
 *   The object is one technical identifier, optionally prefixed with `the`.
 *   One token cannot carry another clause, so multiword work, conjunctions,
 *   and unknown control synonyms decline by shape alone with no verb lists.
 *
 * Outside the set the grammar declines to the provider tier. Decline is not
 * refusal: multiword work stays eligible through the ordinary provider plus
 * Director path. The parser automatic path is intentionally narrow; the
 * whole cascade still owns multiword turns. Coverage cost is honest: fewer
 * automatic proposals, zero swallowed controls.
 *
 * Only Circe (current invocation) and Circe (compatibility) open an
 * invocation wrapper. Every other name resolves through bounded catalogs.
 */

export type LocalGrammarProposal = CirceSemanticProposal;

export type LocalGrammarOutcome =
  | { readonly status: "proposal"; readonly proposal: LocalGrammarProposal }
  | { readonly status: "decline"; readonly reason: "unbounded" };

/**
 * Optional local-tier seam. No local model is connected. Both modes decline
 * today; restricted reserves a path for future bounded local inference but
 * performs none. Production default is disabled.
 */
export type CirceLocalTierMode = "disabled" | "restricted";
export interface CirceLocalTierConfig {
  readonly mode: CirceLocalTierMode;
}
export const CIRCE_LOCAL_TIER_DEFAULT: CirceLocalTierConfig = { mode: "disabled" };

export function tryCirceLocalTier(_input: {
  readonly source: string;
  readonly context: CirceCommandContext;
  readonly config?: CirceLocalTierConfig;
}): { readonly status: "decline"; readonly reason: "local-tier-disabled" } {
  return { status: "decline", reason: "local-tier-disabled" };
}

const MAX_SOURCE = 16_000;
const MAX_PROJECTS = 32;
const MAX_NAMES_PER_PROJECT = 12;
const MAX_TASKS = 16;
const MAX_DESTINATION_SPAN = 160;

const foldName = (value: string): string =>
  normalizeDestinationPhrase(stripDestinationQuotes(value));

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const toRegexName = (name: string): string => {
  const folded = foldName(name);
  if (folded.length === 0) return "";
  return folded.split(/\s+/u).map(escapeRegExp).join("\\s+");
};

// Closed work verbs that can open a bounded start turn. Small on purpose:
// anything else declines to the provider tier instead of guessing. The list
// covers the phrasings users actually speak; every entry stays a request for
// work over one bounded object, never a control synonym.
const START_WORK_VERBS = [
  "fix",
  "add",
  "build",
  "create",
  "implement",
  "update",
  "write",
  "document",
  "check",
  "investigate",
  "tighten",
  "remove",
  "run",
  "test",
  "examine",
  "compare",
  "find",
  "locate",
  "search",
  "list",
  "show",
  "get",
  "fetch",
  "grab",
  "pull",
  "open",
  "look",
] as const;

const START_VERB_ALTERNATION = START_WORK_VERBS.map(escapeRegExp).join("|");

// Start object: one technical identifier, optionally prefixed with `the`.
// Letters and digits with inner - _ . / : + form the token. One token cannot
// carry another clause, so `auth and suspend deployment` never matches by
// shape alone with no suspend list and no conjunction rules.
const TECH_TOKEN = String.raw`[\p{Letter}\p{Number}][\p{Letter}\p{Number}\-_.:/+]*`;
const START_OBJECT = `(?:the\\s+)?${TECH_TOKEN}`;

/**
 * Bounded multiword object for the start shapes. It stays a single clause:
 * no commas or semicolons, at most six words, and no control or second work
 * verb after the first word. That keeps "check pull requests" and
 * "check if the pull requests are merged" eligible while
 * "check auth, then create a deployment task" still declines by shape.
 */
const MULTIWORD_OBJECT = `(?:the\\s+)?${TECH_TOKEN}(?:\\s+${TECH_TOKEN}){0,5}`;
const OBJECT_MAX_WORDS = 6;
const OBJECT_MAX_CHARS = 80;

const OBJECT_CONTROL_WORDS: ReadonlySet<string> = new Set([
  "then",
  "also",
  "and",
  "stop",
  "cancel",
  "queue",
  "review",
  "focus",
  "switch",
  "move",
  "reroute",
  "status",
  "state",
  "approve",
  "deny",
  "allow",
  // Negation stays fail-closed: an object like "auth but not" must never
  // become a clean destination wrapper.
  "not",
  "never",
  "excluding",
  "except",
]);

const isBoundedObject = (text: string): boolean => {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > OBJECT_MAX_CHARS) return false;
  if (/[,;]/u.test(trimmed)) return false;
  const words = trimmed
    .toLocaleLowerCase("en-US")
    .split(/\s+/u)
    .filter((word) => word !== "the");
  if (words.length === 0 || words.length > OBJECT_MAX_WORDS) return false;
  // Only clause connectors and control words veto the object. A noun that
  // matches a work verb ("fix the flaky test") stays a single request.
  return !words.slice(1).some((word) => OBJECT_CONTROL_WORDS.has(word));
};

/**
 * Spoken lead-ins a user says before the actual request. They carry no
 * control meaning, so the bounded shapes may skip them. The prefix never
 * swallows letters that could be part of an instruction because each entry
 * is a fixed phrase followed by a word boundary and optional comma.
 */
const CHATTER_PREFIX = String.raw`(?:(?:all\s+right|alright|okay|ok|so|hey|hello|hi|please|can\s+you|could\s+you|would\s+you|i\s+need\s+you\s+to|i\s+want\s+you\s+to|i\s+would\s+like\s+you\s+to|i'?d\s+like\s+you\s+to)\s*,?\s+)*`;

// Leading symbols (emoji, bullets, stray punctuation) before the work verb.
// Letters and numbers never strip: "What is running" keeps its head.
const LEADING_SYMBOLS = String.raw`[^\p{Letter}\p{Number}]*?`;

interface CatalogProject {
  readonly title: string;
  readonly names: string[];
}

interface CatalogTask {
  readonly title: string;
  readonly names: string[];
}

function buildCatalogsFromContext(context: CirceCommandContext): {
  projects: CatalogProject[];
  tasks: CatalogTask[];
} {
  const grouped = groupCirceAliasesByProject(context.aliases);
  const projects = context.projects.slice(0, MAX_PROJECTS).map((project) => {
    const names = [
      project.title,
      semanticBasename(project.workspaceRoot),
      project.repositoryIdentity?.displayName,
      project.repositoryIdentity?.name,
      ...(grouped.get(project.id) ?? []).map((alias) => alias.alias),
    ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    const seen = new Set<string>();
    const bounded: string[] = [];
    for (const name of names) {
      const key = foldName(name);
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      bounded.push(name);
      if (bounded.length >= MAX_NAMES_PER_PROJECT) break;
    }
    return { title: project.title, names: bounded };
  });
  const taskSeen = new Map<string, CatalogTask>();
  const addTask = (title: string, names: string[]): void => {
    const key = `t:${foldName(title)}`;
    if (key === "t:" || taskSeen.has(key)) return;
    if (taskSeen.size >= MAX_TASKS) return;
    taskSeen.set(key, { title, names: names.filter((n) => n.trim().length > 0).slice(0, 8) });
  };
  for (const task of [
    context.contextTask,
    context.referenceTask,
    context.focusedTask,
    ...(context.recentCommandTasks ?? []),
  ]) {
    if (task !== undefined) addTask(task.title, [task.title, task.objective]);
  }
  for (const task of context.tasks.slice(0, MAX_TASKS)) {
    addTask(task.title, [task.title, task.objective, ...(task.voiceAliases ?? [])]);
  }
  return { projects, tasks: [...taskSeen.values()] };
}

function buildCatalogsFromEvidence(input: {
  readonly projects: ReadonlyArray<{
    readonly title: string;
    readonly names: ReadonlyArray<string>;
  }>;
  readonly tasks: ReadonlyArray<{ readonly title: string }>;
}): { projects: CatalogProject[]; tasks: CatalogTask[] } {
  const projects = input.projects.slice(0, MAX_PROJECTS).map((project) => {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const name of [project.title, ...project.names]) {
      const key = foldName(name);
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      names.push(name);
      if (names.length >= MAX_NAMES_PER_PROJECT) break;
    }
    return { title: project.title, names };
  });
  const tasks: CatalogTask[] = [];
  for (const task of input.tasks.slice(0, MAX_TASKS)) {
    if (task.title.trim().length === 0) continue;
    const key = foldName(task.title);
    if (key.length === 0 || tasks.some((t) => foldName(t.title) === key)) continue;
    tasks.push({ title: task.title, names: [task.title] });
  }
  return { projects, tasks };
}

const cite = (
  source: string,
  start: number,
  end: number,
): { start: number; end: number; text: string } => {
  const text = source.slice(start, end);
  return { start, end, text };
};

const ref = (
  source: string,
  start: number,
  end: number,
  role: SemanticRole,
  value: string,
): SemanticRef => ({ span: cite(source, start, end), role, value });

const listPattern = /^\s*(?:please\s+)?(?:list|show)\s+(?:my\s+|all\s+)?projects\s*[.!?]?\s*$/iu;
const statusBare = /^\s*(?:please\s+)?(?:status|state)\s*[.!?]?\s*$/iu;
const stopBare = /^\s*(?:please\s+)?stop\s*[.!?]?\s*$/iu;

const statusOfPattern = (taskText: string): RegExp =>
  new RegExp(
    `^\\s*(?:what(?:'s| is)?|check|show|tell(?: me)?)\\s+(?:the\\s+)?status\\s+(?:of\\s+)?${escapeRegExp(taskText)}\\s*[.!?]?\\s*$`,
    "iu",
  );

const stopTaskPattern = (taskText: string): RegExp =>
  new RegExp(
    `^\\s*(?:please\\s+)?stop\\s+(?:the\\s+)?${escapeRegExp(taskText)}(?:\\s+task)?\\s*[.!?]?\\s*$`,
    "iu",
  );

const focusTaskPattern = (taskText: string): RegExp =>
  new RegExp(
    `^\\s*(?:please\\s+)?focus\\s+(?:on\\s+)?${escapeRegExp(taskText)}\\s*[.!?]?\\s*$`,
    "iu",
  );

function findTaskSpan(
  rest: string,
  taskTitle: string,
): { startInRest: number; endInRest: number; text: string } | undefined {
  const tokenPattern = /[\p{Letter}\p{Number}]+/gu;
  const tokens: Array<{ word: string; start: number; end: number; folded: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = tokenPattern.exec(rest)) !== null) {
    tokens.push({ word: m[0], start: m.index, end: m.index + m[0].length, folded: foldName(m[0]) });
  }
  const wanted = foldName(taskTitle)
    .split(/\s+/u)
    .filter((w) => w.length > 0);
  if (wanted.length === 0 || tokens.length === 0) return undefined;
  for (let i = 0; i + wanted.length <= tokens.length; i += 1) {
    let ok = true;
    for (let j = 0; j < wanted.length; j += 1) {
      if (tokens[i + j]?.folded !== wanted[j]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const startInRest = tokens[i]!.start;
    const endInRest = tokens[i + wanted.length - 1]!.end;
    return { startInRest, endInRest, text: rest.slice(startInRest, endInRest) };
  }
  return undefined;
}

type DestinationFound = { readonly kind: "proposal"; readonly proposal: LocalGrammarProposal };

function findLeadingDestination(
  source: string,
  offset: number,
  rest: string,
  projects: ReadonlyArray<CatalogProject>,
): DestinationFound | undefined {
  const ordered = [...projects].sort((a, b) => b.title.length - a.title.length);
  for (const project of ordered) {
    const names = [...project.names].sort((a, b) => b.length - a.length);
    for (const name of names) {
      const nameRegex = toRegexName(name);
      if (nameRegex.length === 0) continue;
      // Full-turn leading shape only: `In <name>, <verb> <object>`.
      const full = new RegExp(
        `^\\s*(?:In|On|At)\\s+${nameRegex}\\s*,?\\s*${CHATTER_PREFIX}(?:please\\s+)?(${START_VERB_ALTERNATION})\\b\\s+(${MULTIWORD_OBJECT})\\s*[.!?]?\\s*$`,
        "iu",
      );
      const fullMatch = full.exec(rest);
      if (fullMatch === null || !isBoundedObject(fullMatch[2] ?? "")) continue;
      const head = new RegExp(`^\\s*(?:In|On|At)\\s+${nameRegex}\\s*,?`, "iu").exec(rest);
      if (head === null || head[0] === undefined) continue;
      const wrapperText = head[0].endsWith(",") ? head[0] : head[0].trimEnd();
      const leadingWhitespace = rest.match(/^\s*/u)?.[0].length ?? 0;
      const wrapperStart = offset + leadingWhitespace;
      const wrapperEnd = wrapperStart + wrapperText.trimStart().length;
      const text = source.slice(wrapperStart, wrapperEnd);
      if (text.length === 0 || text.length > MAX_DESTINATION_SPAN) continue;
      if (isInCirceNegationScope(wrapperStart - offset, rest)) {
        const nameSpan = findTaskSpan(rest, name);
        if (nameSpan === undefined) continue;
        return {
          kind: "proposal",
          proposal: {
            action: "start",
            refs: [
              ref(
                source,
                offset + nameSpan.startInRest,
                offset + nameSpan.endInRest,
                "excluded",
                name,
              ),
            ],
            model: null,
            effort: null,
            answer: null,
          },
        };
      }
      const remainder = source.slice(wrapperEnd).trim();
      if (remainder.length === 0) return undefined;
      // Unknown and duplicate names resolve in the Director via validation;
      // the parser only cites what was written.
      return {
        kind: "proposal",
        proposal: {
          action: "start",
          refs: [ref(source, wrapperStart, wrapperEnd, "destination", name)],
          model: null,
          effort: null,
          answer: null,
        },
      };
    }
  }
  return undefined;
}

function findTrailingDestination(
  source: string,
  offset: number,
  rest: string,
  projects: ReadonlyArray<CatalogProject>,
): DestinationFound | undefined {
  const ordered = [...projects].sort((a, b) => b.title.length - a.title.length);
  for (const project of ordered) {
    const names = [...project.names].sort((a, b) => b.length - a.length);
    for (const name of names) {
      const nameRegex = toRegexName(name);
      if (nameRegex.length === 0) continue;
      // Full-turn trailing shape only: `<verb> <object> in|on|at <name>`.
      const full = new RegExp(
        `^\\s*${LEADING_SYMBOLS}${CHATTER_PREFIX}(?:please\\s+)?(?:${START_VERB_ALTERNATION})\\b\\s+(${MULTIWORD_OBJECT})\\s+(?:in|on|at)\\s+${nameRegex}\\s*[.,;!?]?\\s*$`,
        "iu",
      );
      const fullMatch = full.exec(rest);
      if (fullMatch === null || !isBoundedObject(fullMatch[1] ?? "")) continue;
      const pattern = new RegExp(`\\s+(?:in|on|at)\\s+${nameRegex}(?=$|[\\s.,;!?])`, "iu");
      const match = pattern.exec(rest);
      if (match === null || match[0] === undefined) continue;
      const startInRest = match.index;
      const endInRest = match.index + match[0].length;
      const start = offset + startInRest;
      const end = offset + endInRest;
      const text = source.slice(start, end);
      if (text.length === 0 || text.length > MAX_DESTINATION_SPAN) continue;
      if (isInCirceNegationScope(startInRest, rest)) {
        const nameSpan = findTaskSpan(rest.slice(startInRest, endInRest), name);
        if (nameSpan === undefined) continue;
        return {
          kind: "proposal",
          proposal: {
            action: "start",
            refs: [
              ref(
                source,
                offset + startInRest + nameSpan.startInRest,
                offset + startInRest + nameSpan.endInRest,
                "excluded",
                name,
              ),
            ],
            model: null,
            effort: null,
            answer: null,
          },
        };
      }
      const after = rest.slice(endInRest).trim();
      if (after.length > 0 && !/^[.,;!?]+$/.test(after)) continue;
      const remainder = (source.slice(0, start) + source.slice(end)).trim();
      const remainderWithoutInvocation = stripCirceInvocation(remainder).rest.trim();
      if (remainderWithoutInvocation.length === 0) return undefined;
      return {
        kind: "proposal",
        proposal: {
          action: "start",
          refs: [ref(source, start, end, "destination", name)],
          model: null,
          effort: null,
          answer: null,
        },
      };
    }
  }
  return undefined;
}

/**
 * One closed engine over caller-supplied catalogs. Both the context path and
 * the evidence path share it, so behavior cannot drift between nodes.
 */
function runClosedGrammar(input: {
  readonly source: string;
  readonly projects: CatalogProject[];
  readonly tasks: CatalogTask[];
}): LocalGrammarOutcome {
  const { source, projects, tasks } = input;
  if (source.length === 0 || source.length > MAX_SOURCE)
    return { status: "decline", reason: "unbounded" };
  if (!/[\p{Letter}\p{Number}]/u.test(source)) return { status: "decline", reason: "unbounded" };
  const { rest, offset } = stripCirceInvocation(source);
  if (rest.trim().length === 0) return { status: "decline", reason: "unbounded" };
  if (projects.length === 0) return { status: "decline", reason: "unbounded" };

  if (listPattern.test(rest)) {
    return {
      status: "proposal",
      proposal: { action: "list-projects", refs: [], model: null, effort: null, answer: null },
    };
  }
  if (statusBare.test(rest)) {
    return {
      status: "proposal",
      proposal: { action: "status", refs: [], model: null, effort: null, answer: null },
    };
  }
  if (stopBare.test(rest)) {
    return {
      status: "proposal",
      proposal: { action: "stop", refs: [], model: null, effort: null, answer: null },
    };
  }

  // Exact task controls need exact catalog spans. Unknown and duplicate
  // names propose so the Director reports unknown or ambiguous instead of
  // the parser guessing. Quoted and excluded evidence stays fail-closed in
  // the validator.
  const orderedTasks = [...tasks].sort((a, b) => b.title.length - a.title.length);
  for (const task of orderedTasks) {
    const span = findTaskSpan(rest, task.title);
    if (span === undefined) continue;
    const start = offset + span.startInRest;
    const end = offset + span.endInRest;
    if (statusOfPattern(span.text).test(rest)) {
      return {
        status: "proposal",
        proposal: {
          action: "status",
          refs: [ref(source, start, end, "task", task.title)],
          model: null,
          effort: null,
          answer: null,
        },
      };
    }
    if (stopTaskPattern(span.text).test(rest)) {
      return {
        status: "proposal",
        proposal: {
          action: "stop",
          refs: [ref(source, start, end, "task", task.title)],
          model: null,
          effort: null,
          answer: null,
        },
      };
    }
    if (focusTaskPattern(span.text).test(rest)) {
      return {
        status: "proposal",
        proposal: {
          action: "focus-task",
          refs: [ref(source, start, end, "task", task.title)],
          model: null,
          effort: null,
          answer: null,
        },
      };
    }
  }

  const orderedProjects = [...projects].sort((a, b) => b.title.length - a.title.length);
  for (const project of orderedProjects) {
    for (const name of [...project.names].sort((a, b) => b.length - a.length)) {
      const nameRegex = toRegexName(name);
      if (nameRegex.length === 0) continue;
      const pattern = new RegExp(
        `^\\s*(?:please\\s+)?(?:focus(?: on)?|switch to|go to)\\s+(?:the\\s+)?${nameRegex}(?:\\s+project)?\\s*[.!?]?\\s*$`,
        "iu",
      );
      if (!pattern.test(rest)) continue;
      const span = findTaskSpan(rest, name);
      if (span === undefined) continue;
      const start = offset + span.startInRest;
      const end = offset + span.endInRest;
      return {
        status: "proposal",
        proposal: {
          action: "focus-project",
          refs: [ref(source, start, end, "destination", name)],
          model: null,
          effort: null,
          answer: null,
        },
      };
    }
  }

  const leading = findLeadingDestination(source, offset, rest, projects);
  if (leading !== undefined) {
    return { status: "proposal", proposal: leading.proposal };
  }
  const trailing = findTrailingDestination(source, offset, rest, projects);
  if (trailing !== undefined) {
    return { status: "proposal", proposal: trailing.proposal };
  }

  return { status: "decline", reason: "unbounded" };
}

/**
 * Deterministic parse over the live command context. Positive proposals carry
 * canonical UTF-16 spans that reproduce source byte-for-byte. Anything outside
 * the closed set declines to the provider tier with no partial dispatch.
 */
export function tryBoundedLocalGrammar(input: {
  readonly source: string;
  readonly context: CirceCommandContext;
}): LocalGrammarOutcome {
  const { projects, tasks } = buildCatalogsFromContext(input.context);
  return runClosedGrammar({ source: input.source, projects, tasks });
}

/**
 * Evidence-only grammar for the mesh propose path. Same closed engine over
 * untrusted names (no IDs). Lets the semantic node skip one provider call for
 * bounded turns; the execution node still revalidates authoritatively.
 */
export function tryBoundedLocalGrammarForEvidence(input: {
  readonly source: string;
  readonly projects: ReadonlyArray<{
    readonly title: string;
    readonly names: ReadonlyArray<string>;
  }>;
  readonly tasks: ReadonlyArray<{ readonly title: string }>;
}): LocalGrammarOutcome {
  const { projects, tasks } = buildCatalogsFromEvidence(input);
  return runClosedGrammar({ source: input.source, projects, tasks });
}
