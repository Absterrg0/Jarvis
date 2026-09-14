import type {
  CirceProjectAlias,
  OrchestrationProjectShell,
  OrchestrationThreadActivity,
  ProjectId,
} from "@t3tools/contracts";

import type { CirceCommandContext, CirceCommandNeedsInput } from "./command.ts";
import { groupCirceAliasesByProject } from "./buildProjectVocabulary.ts";
import { getPendingCirceReplyState } from "./confirmation.ts";
import { deleteSourceSpans, type SourceSpan } from "./destinationSpan.ts";
import { groundVoiceTurn, type VoiceProjectCandidate } from "./groundVoiceTurn.ts";

export const normalizeSemanticName = (value: string): string =>
  value
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();

export const semanticBasename = (path: string): string =>
  path
    .replace(/[\\/]+$/u, "")
    .split(/[\\/]/u)
    .at(-1) ?? path;

export const projectSemanticNames = (
  project: OrchestrationProjectShell,
  aliases: ReadonlyArray<CirceProjectAlias>,
): ReadonlyArray<string> =>
  projectSemanticNamesForAliases(
    project,
    aliases.filter((alias) => alias.projectId === project.id),
  );

const projectSemanticNamesForAliases = (
  project: OrchestrationProjectShell,
  aliases: ReadonlyArray<CirceProjectAlias>,
): ReadonlyArray<string> =>
  [
    project.title,
    semanticBasename(project.workspaceRoot),
    project.repositoryIdentity?.displayName,
    project.repositoryIdentity?.name,
    ...aliases.map((alias) => alias.alias),
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

const projectCandidates = (
  projects: ReadonlyArray<OrchestrationProjectShell>,
  aliases: ReadonlyArray<CirceProjectAlias>,
): ReadonlyArray<VoiceProjectCandidate<OrchestrationProjectShell>> => {
  const grouped = groupCirceAliasesByProject(aliases);
  return projects.map((project) => ({
    id: project.id,
    title: project.title,
    label: `${project.title} — ${semanticBasename(project.workspaceRoot)}`,
    names: projectSemanticNamesForAliases(project, grouped.get(project.id) ?? []),
    project,
  }));
};

type GroundingClarification = Extract<
  ReturnType<typeof groundVoiceTurn<OrchestrationProjectShell>>,
  { status: "needs-confirmation" | "needs-clarification" }
>;

const projectClarification = (grounded: GroundingClarification): CirceCommandNeedsInput =>
  grounded.status === "needs-confirmation"
    ? {
        status: "needs-input",
        reason: "control-target-required",
        prompt: grounded.prompt,
        choices: [grounded.project.title],
        projectClarification: {
          candidates: [
            {
              projectId: grounded.project.id,
              label: grounded.project.title,
              learnedAlias: grounded.heard,
            },
          ],
        },
      }
    : {
        status: "needs-input",
        reason: "control-target-required",
        prompt: grounded.prompt,
        choices: grounded.candidates.map(({ label }) => label),
        projectClarification: {
          candidates: grounded.candidates.map(({ project, label, learnedAlias }) => ({
            projectId: project.id,
            label,
            ...(learnedAlias === undefined ? {} : { learnedAlias }),
          })),
        },
      };

/**
 * Advisory acoustic evidence for one voice turn. Heard, never authoritative:
 * the deterministic route owns nothing and the model routes only by citing
 * exact spans the host validates. A resolved mention tells the model what
 * was heard; phonetic near-misses and unknown names clarify here instead.
 */
export type CirceHeardMention = {
  readonly heard: string;
  readonly start?: number;
  readonly end?: number;
  readonly match?: "exact" | "near" | "confirmed-pronunciation";
};

export type PreparedCirceSemanticTurn =
  | {
      readonly status: "ready";
      /** Original ASR wording, preserved verbatim. The model never rewrites this. */
      readonly utterance: string;
      /** Bounded copy of the original transcript traced to the Director. */
      readonly sourceUtterance: string;
      /** Advisory acoustic evidence. Never authorizes a route on its own. */
      readonly asrEvidence?: CirceHeardMention;
      /**
       * The project the deterministic grounding resolved for the heard span.
       * The host uses it to correct a proposal that cited the misheard name,
       * so a near match never turns into another clarification.
       */
      readonly groundedProjectId?: ProjectId;
    }
  | CirceCommandNeedsInput;

/**
 * Derive the dispatch instruction deterministically: delete exactly the
 * validated destination wrapper spans and join what survives. Only cited
 * ranges disappear; every untouched character, including inner spacing,
 * survives byte-for-byte with no global whitespace normalization. The
 * joined ends are preserved too. Unsorted, overlapping, or
 * out-of-bounds spans return the source unchanged, so dispatch never
 * paraphrases and never cuts blindly.
 */
export function resolveCirceInstruction(
  source: string,
  deletions: ReadonlyArray<SourceSpan>,
): string {
  if (deletions.length === 0) return source;
  const joined = deleteSourceSpans(source, deletions);
  if (joined === undefined) return source;
  return joined.trim().length === 0 ? source : joined;
}

/** One-line pending summary for the semantic prompt; never request identity. */
function describePendingCirceRequest(
  activities: ReadonlyArray<OrchestrationThreadActivity> | undefined,
): string {
  if (activities === undefined) return "none";
  const state = getPendingCirceReplyState(activities);
  if (state.status === "none") return "none";
  if (state.status === "ambiguous") return "more than one request waiting";
  return state.pending.kind === "approval"
    ? "approval waiting: allow or deny it"
    : "question waiting: answer it directly";
}

export function prepareCirceSemanticTurn(input: CirceCommandContext): PreparedCirceSemanticTurn {
  const utterance = input.utterance;
  if (!/[\p{Letter}\p{Number}]/u.test(utterance)) {
    return {
      status: "needs-input",
      reason: "unsupported-command",
      prompt: "I couldn't understand that command. State the task or control action you want.",
      choices: [],
    };
  }
  if (input.inputMode !== "voice") {
    // Typed turns carry no deterministic route: every project, task, and
    // provider name in the transcript is advisory until the proposal cites
    // it with an exact span the host validates. Prepositions never
    // authorize on their own.
    return { status: "ready", utterance, sourceUtterance: utterance };
  }
  const grounded = groundVoiceTurn({
    utterance,
    candidates: projectCandidates(input.projects, input.aliases),
    mode: input.continueContext ? "explicit-only" : "explicit-or-inferred",
    ...(input.confirmedProjectId === undefined
      ? {}
      : { confirmedCandidateId: input.confirmedProjectId }),
  });
  if (grounded.status === "needs-confirmation" || grounded.status === "needs-clarification") {
    return projectClarification(grounded);
  }
  // The deterministic route owns nothing: a resolved mention is advisory
  // acoustic evidence for the prompt, and an unmentioned turn stays
  // verbatim. The proposal cites spans; the host authorizes them.
  return grounded.status === "resolved"
    ? {
        status: "ready",
        utterance,
        sourceUtterance: utterance,
        asrEvidence: {
          heard: grounded.heard,
          ...(grounded.span === undefined
            ? {}
            : { start: grounded.span.start, end: grounded.span.end }),
          match: grounded.match,
        },
        ...(grounded.span === undefined ? {} : { groundedProjectId: grounded.project.id }),
      }
    : { status: "ready", utterance, sourceUtterance: utterance };
}

function buildCirceSemanticPromptContext(
  input: CirceCommandContext,
  prepared: Extract<PreparedCirceSemanticTurn, { status: "ready" }>,
  limits: { readonly tasks: number; readonly objectiveChars: number } = {
    tasks: 8,
    objectiveChars: 240,
  },
): ReadonlyArray<string> {
  const grouped = groupCirceAliasesByProject(input.aliases);
  const projects = input.projects.map((project) => ({
    name: project.title,
    aliases: projectSemanticNamesForAliases(project, grouped.get(project.id) ?? []).filter(
      (name) => name !== project.title,
    ),
  }));
  const tasks = input.tasks.slice(0, limits.tasks).map((task) => ({
    title: task.title,
    project: input.projects.find((project) => project.id === task.projectId)?.title ?? "unknown",
    objective: task.objective.slice(0, limits.objectiveChars),
    state: task.state,
  }));
  const providers = input.providers.map((provider) => {
    const defaultModel = provider.models.find((model) => model.isDefault === true);
    const onlyModel = provider.models.length === 1 ? provider.models[0] : undefined;
    return {
      name: provider.displayName ?? provider.driver,
      defaultModel:
        defaultModel?.shortName ?? defaultModel?.name ?? onlyModel?.shortName ?? onlyModel?.name,
    };
  });
  const focusedTask =
    input.focusedTask === undefined
      ? null
      : {
          title: input.focusedTask.title,
          project: input.focusedTask.projectTitle,
          objective: input.focusedTask.objective.slice(0, 240),
          state: input.focusedTask.state,
        };
  const heardMention =
    prepared.asrEvidence === undefined
      ? "none"
      : `${prepared.asrEvidence.heard} (advisory only: cite its exact span to route)`;
  const localPending = describePendingCirceRequest(input.contextThread?.activities);
  const pendingRequest =
    localPending !== "none"
      ? localPending
      : input.pendingReplyTask === undefined
        ? "none"
        : `${describePendingCirceRequest(input.pendingReplyThread?.activities)} in task "${input.pendingReplyTask.title}": answer it with continue`;
  return [
    `Request: ${prepared.utterance.slice(0, 16_000)}`,
    `Original transcript: ${prepared.sourceUtterance.slice(0, 16_000)}`,
    `Heard project mention: ${heardMention.slice(0, 240)}`,
    `Pending request: ${pendingRequest}`,
    `Continue selected conversation: ${input.continueContext}`,
    `Current project: ${input.projects.find((project) => project.id === input.currentProjectId)?.title ?? "unknown"}`,
    `Focused task: ${focusedTask === null ? "none" : JSON.stringify(focusedTask)}`,
    `Projects: ${JSON.stringify(projects)}`,
    `Recent tasks: ${JSON.stringify(tasks)}`,
    `Providers: ${JSON.stringify(providers)}`,
  ];
}

const CIRCE_SEMANTIC_PROMPT_RULES: ReadonlyArray<string> = [
  "Translate one Circe request into one structured semantic proposal.",
  "Model proposes never authorizes. Return only the schema fields. Never invent or return internal IDs. Never call tools, dispatch work, or answer approvals.",
  "Use exact catalog names when naming a project, task, provider, model, or effort.",
  "Every ref cites the Original transcript with exact character spans: start and end are UTF-16 code units and text is the source slice copied byte-for-byte, including case, spacing, and punctuation. Offsets prove the text was copied, nothing more. The host rejects any span that does not reproduce the source exactly, any value that does not echo its span, and any destination span that does not contain its named project.",
  "Roles: destination cites only the full routing wrapper, including its separator whitespace or comma, so removing precisely that span leaves the instruction unchanged otherwise. Never include a work verb, literal, constraint, or quoted command in a removable wrapper. correction cites the repaired-to mention. task cites the coded work's title; provider cites a requested runner, not a provider discussed as a subject. subject and excluded never authorize a route.",
  "Cardinality is explicit: at most one destination or correction, one task, and one provider per turn. Multiple sentences describing one request are still one action. One coding task described with several constraints is a single start, continue, or steer with no task ref needed. A sentence that merely starts with or contains a discourse 'and', 'also', or 'so' is still one request, never a compound. Only two genuinely separate commands in one turn use action sequence with ordered steps, each a complete single command with its own refs. A single work request phrased as a question ('can you tell me if there are any open pull requests in Alertify', 'are there any open PRs in Rivvl') is start with its destination, never unsupported.",
  "Only a cited destination or correction span names the project. Mentions inside the work ('compare with X', 'mentioning Y', 'PRs about Z', 'branch W', 'Find docs about Fable') stay out of destination refs and never become the project. A bare object ('check out Zivil', 'Open Rivvl', 'look at Rivvl') is not a wrapper: cite nothing. A leading 'In <project>,' destination overrides any other project named later: 'In Rivvl, document checkout flow Circe uses' cites the In Rivvl wrapper for Rivvl and optionally Circe as subject.",
  "A leading negation rules out the named control or target: Don't, do not, and never mark ruled-out names excluded, never a destination. 'Don't stop the auth task, tell status' is status, never stop: a transcript that opens with don't, do not, or never is never a stop or reroute proposal. 'Check auth but not in Fable' cites Fable excluded, never destination, and keeps the full wording. 'excluding the billing endpoint' cites the endpoint excluded. A bare discourse no ('No, I meant …') is a correction, not a negation.",
  "When a heard project mention is shown, it is advisory evidence only. Cite the heard text exactly as written when routing to it. A typo or mishearing ('Rivvil' for Rivvl, 'Rival' for Rivvl) never spells a catalog name: cite what was heard as subject or excluded, or omit refs and let the host clarify. Established aliases resolve, but only when cited exactly as heard.",
  "A question about, or follow-up to, the focused task that names no other task or project continues it: use continue, not start. Any new instruction that names no other task or project also continues the focused task; only naming another project, or asking for a new task, thread, or conversation, starts a separate one. A general question unrelated to any listed project or task uses converse with the question answered in answer; answer is required for converse, null otherwise.",
  "Actions: start creates new work; continue adds a new turn to a ready task; steer adds direction to running work; queue schedules a follow-up; stop interrupts; status reports state; review creates a review task; reroute recreates a task in another project; focus-project changes the project for new work; focus-task changes the selected task; list-projects lists the catalog; converse answers a general question that needs no project or task; lookup answers weather or local time in a named place; open-website opens a named website or web URL on the user's device; unsupported marks a request Circe cannot do as one action. The host decides steer versus continuation from the task's live state, not from hidden wording.",
  "Quick actions take no project or task. A weather or local-time question uses action lookup with lookup {kind: weather|time, location, day: now|today|tomorrow}. Copy location verbatim from the user's words without translating or normalizing names, and use day now unless the user says today or tomorrow. A request to open a site uses action open-website with website set to the named site or URL the user gave. Never use lookup or open-website for work that edits, deploys, or investigates a project; those are ordinary start tasks. The host rejects a location that does not appear in the transcript and a website outside the allowed set.",
  "A pending approval or question is answered by continuing its task: a bare verdict ('yes', 'allow it', 'deny it') or an answer to the waiting question uses continue, never stop, status, or converse. The host binds the reply to the live request; never invent request identity.",
  "Use null when the user did not specify model, effort, or answer. The host dispatches the original transcript minus cited destination spans and composes acceptance speech from the accepted target; proposals carry no wording and no acknowledgement.",
  "Examples:",
  '- "stop authentication" => action stop with one task ref citing authentication.',
  '- "move the API task to Backend" => action reroute with one task ref citing API and one destination ref citing to Backend.',
  '- "in Web, fix the header with Codex" => action start with one destination ref citing in Web and one provider ref citing Codex.',
  '- "Check auth in Rivvl" => action start with one destination ref citing in Rivvl.',
  '- "Check if there are any GitHub PRs in Rivvl" => action start with one destination ref citing in Rivvl.',
  '- "Ask Claude investigate login failure in Circe" => action start with one provider ref citing Claude and one destination ref citing in Circe.',
  '- "Can you tell me if there are any open pull requests in Alertify" => action start with one destination ref citing in Alertify.',
  '- "Are there any open PRs in Rivvl" => action start with one destination ref citing in Rivvl.',
  '- "Don\'t stop auth task tell status" => action status with no destination ref.',
  '- "Fix auth, then run its tests" => action start: one coding task with several steps.',
  '- "Stop authentication, then create a deployment task" => action unsupported: two independent Circe controls.',
  '- "Fix auth with retries and backoff in Rivvl" => action start with one destination ref citing in Rivvl.',
  '- "In Rivvl compare with Circe" => action start with one destination ref citing In Rivvl and optionally Circe as subject.',
  '- "PRs mentioning Rivvl in Circe repo" => action start with one destination ref citing in Circe repo and optionally Rivvl as subject.',
  '- "what is new today?" with no related task => action converse with empty refs and the brief spoken reply (at most 400 characters) as answer.',
  '- "What is the weather in Ahmedabad?" => action lookup with lookup {kind: "weather", location: "Ahmedabad", day: "now"} and no refs.',
  '- "Will it rain in Paris tomorrow?" => action lookup with lookup {kind: "weather", location: "Paris", day: "tomorrow"}.',
  '- "What time is it in Tokyo?" => action lookup with lookup {kind: "time", location: "Tokyo", day: "now"}.',
  '- "Open YouTube" => action open-website with website "YouTube".',
  '- "Open https://example.com" => action open-website with website "https://example.com".',
  "The deterministic host validates all spans, names, authority, availability, approvals, and dispatch.",
  "",
];

const CIRCE_FAST_SEMANTIC_PROMPT_RULES: ReadonlyArray<string> = [
  "Route one Circe request to one JSON proposal. Output ONLY this JSON, no prose and no tools:",
  '{"action":"start|continue|steer|queue|stop|status|review|reroute|focus-project|focus-task|list-projects|converse|lookup|open-website|unsupported","refs":[{"span":{"start":number,"end":number,"text":string},"role":"destination|task|subject|excluded|correction|provider","value":string}],"model":string|null,"effort":string|null,"answer":string|null,"lookup":{"kind":"weather|time","location":string,"day":"now|today|tomorrow"}|null,"website":string|null}',
  "refs cite exact UTF-16 spans of the Original transcript: text is the exact copied slice and value echoes it; the host rejects any inexact span. destination is only the full routing wrapper (for example 'in Alertify'); only destination or correction names the project. task is a work title, provider a requested runner; subject and excluded never route. At most one destination or correction, one task, one provider.",
  "Use exact catalog names; never invent internal IDs. Use null for unspecified model, effort, answer, lookup, and website; answer is required only for converse (at most 400 characters).",
  "A single work request is start even when phrased as a question ('are there any open PRs in Alertify'). Multiple sentences describing one request are still one action. A sentence starting with or containing 'and', 'also', or 'so' is still one request. Only two genuinely separate commands ('stop auth, then create a deployment task') are action sequence with ordered steps, each a full command; the host runs them in order. A request that continues the focused task is continue; a general question unrelated to any project or task is converse with the reply in answer.",
  "A weather or local-time question is lookup with lookup.location copied verbatim from the transcript and day now|today|tomorrow; a request to open a named site or URL is open-website with website set to it. Neither takes project or task refs.",
  "Examples:",
  '- "Check auth in Rivvl" => start, destination ref citing "in Rivvl".',
  '- "stop authentication" => stop, task ref citing "authentication".',
  '- "Stop auth, then create a deployment task" => unsupported.',
  '- "what is new today?" with no related task => converse with the reply in answer.',
  '- "weather in Ahmedabad" => lookup with lookup {kind: "weather", location: "Ahmedabad", day: "now"}.',
  '- "open YouTube" => open-website with website "YouTube".',
  "",
];

export function buildCirceSemanticPrompt(
  input: CirceCommandContext,
  prepared: Extract<PreparedCirceSemanticTurn, { status: "ready" }>,
): string {
  return [...CIRCE_SEMANTIC_PROMPT_RULES, ...buildCirceSemanticPromptContext(input, prepared)].join(
    "\n",
  );
}

/**
 * Compact prompt for the fx supervisor. fx has no structured-output schema, so
 * this carries the proposal shape explicitly. The provider path keeps the full
 * prompt and its schema enforcement; this one exists to keep fx reasoning
 * short enough to answer in a couple of seconds.
 */
export function buildCirceFastSemanticPrompt(
  input: CirceCommandContext,
  prepared: Extract<PreparedCirceSemanticTurn, { status: "ready" }>,
): string {
  return [
    ...CIRCE_FAST_SEMANTIC_PROMPT_RULES,
    ...buildCirceSemanticPromptContext(input, prepared, { tasks: 4, objectiveChars: 100 }),
  ].join("\n");
}
