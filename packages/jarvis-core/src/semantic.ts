import type {
  JarvisProjectAlias,
  OrchestrationProjectShell,
  OrchestrationThreadActivity,
} from "@t3tools/contracts";

import type { JarvisCommandContext, JarvisCommandNeedsInput } from "./command.ts";
import { groupJarvisAliasesByProject } from "./buildProjectVocabulary.ts";
import { getPendingJarvisReplyState } from "./confirmation.ts";
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
  aliases: ReadonlyArray<JarvisProjectAlias>,
): ReadonlyArray<string> =>
  projectSemanticNamesForAliases(
    project,
    aliases.filter((alias) => alias.projectId === project.id),
  );

const projectSemanticNamesForAliases = (
  project: OrchestrationProjectShell,
  aliases: ReadonlyArray<JarvisProjectAlias>,
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
  aliases: ReadonlyArray<JarvisProjectAlias>,
): ReadonlyArray<VoiceProjectCandidate<OrchestrationProjectShell>> => {
  const grouped = groupJarvisAliasesByProject(aliases);
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

const projectClarification = (grounded: GroundingClarification): JarvisCommandNeedsInput =>
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
export type JarvisHeardMention = {
  readonly heard: string;
  readonly start?: number;
  readonly end?: number;
  readonly match?: "exact" | "near" | "confirmed-pronunciation";
};

export type PreparedJarvisSemanticTurn =
  | {
      readonly status: "ready";
      /** Original ASR wording, preserved verbatim. The model never rewrites this. */
      readonly utterance: string;
      /** Bounded copy of the original transcript traced to the Director. */
      readonly sourceUtterance: string;
      /** Advisory acoustic evidence. Never authorizes a route on its own. */
      readonly asrEvidence?: JarvisHeardMention;
    }
  | JarvisCommandNeedsInput;

/**
 * Derive the dispatch instruction deterministically: delete exactly the
 * validated destination wrapper spans and join what survives. Only cited
 * ranges disappear; every untouched character, including inner spacing,
 * survives byte-for-byte with no global whitespace normalization. The
 * joined ends are preserved too. Unsorted, overlapping, or
 * out-of-bounds spans return the source unchanged, so dispatch never
 * paraphrases and never cuts blindly.
 */
export function resolveJarvisInstruction(
  source: string,
  deletions: ReadonlyArray<SourceSpan>,
): string {
  if (deletions.length === 0) return source;
  const joined = deleteSourceSpans(source, deletions);
  if (joined === undefined) return source;
  return joined.trim().length === 0 ? source : joined;
}

/** One-line pending summary for the semantic prompt; never request identity. */
function describePendingJarvisRequest(
  activities: ReadonlyArray<OrchestrationThreadActivity> | undefined,
): string {
  if (activities === undefined) return "none";
  const state = getPendingJarvisReplyState(activities);
  if (state.status === "none") return "none";
  if (state.status === "ambiguous") return "more than one request waiting";
  return state.pending.kind === "approval"
    ? "approval waiting: allow or deny it"
    : "question waiting: answer it directly";
}

export function prepareJarvisSemanticTurn(input: JarvisCommandContext): PreparedJarvisSemanticTurn {
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
      }
    : { status: "ready", utterance, sourceUtterance: utterance };
}

export function buildJarvisSemanticPrompt(
  input: JarvisCommandContext,
  prepared: Extract<PreparedJarvisSemanticTurn, { status: "ready" }>,
): string {
  const grouped = groupJarvisAliasesByProject(input.aliases);
  const projects = input.projects.map((project) => ({
    name: project.title,
    aliases: projectSemanticNamesForAliases(project, grouped.get(project.id) ?? []).filter(
      (name) => name !== project.title,
    ),
  }));
  const tasks = input.tasks.slice(0, 8).map((task) => ({
    title: task.title,
    project: input.projects.find((project) => project.id === task.projectId)?.title ?? "unknown",
    objective: task.objective.slice(0, 240),
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
  const pendingRequest = describePendingJarvisRequest(input.contextThread?.activities);
  return [
    "Translate one ARIS request into one structured semantic proposal.",
    "Model proposes never authorizes. Return only the schema fields. Never invent or return internal IDs. Never call tools, dispatch work, or answer approvals.",
    "Use exact catalog names when naming a project, task, provider, model, or effort.",
    "Every ref cites the Original transcript with exact character spans: start and end are UTF-16 code units and text is the source slice copied byte-for-byte, including case, spacing, and punctuation. Offsets prove the text was copied, nothing more. The host rejects any span that does not reproduce the source exactly, any value that does not echo its span, and any destination span that does not contain its named project.",
    "Roles: destination cites only the full routing wrapper, including its separator whitespace or comma, so removing precisely that span leaves the instruction unchanged otherwise. Never include a work verb, literal, constraint, or quoted command in a removable wrapper. correction cites the repaired-to mention. task cites the coded work's title; provider cites a requested runner, not a provider discussed as a subject. subject and excluded never authorize a route.",
    "Cardinality is explicit: at most one destination or correction, one task, and one provider per turn. One coding task described with several constraints is a single start, continue, or steer with no task ref needed. For requests joining two independent control commands with then, also, and, or commas, propose action unsupported with empty refs. The host answers with needs-input and nothing dispatches.",
    "Only a cited destination or correction span names the project. Mentions inside the work ('compare with X', 'mentioning Y', 'PRs about Z', 'branch W', 'Find docs about Fable') stay out of destination refs and never become the project. A bare object ('check out Zivil', 'Open Rivvl', 'look at Rivvl') is not a wrapper: cite nothing. A leading 'In <project>,' destination overrides any other project named later: 'In Rivvl, document checkout flow Jarvis uses' cites the In Rivvl wrapper for Rivvl and optionally Jarvis as subject.",
    "A leading negation rules out the named control or target: Don't, do not, and never mark ruled-out names excluded, never a destination. 'Don't stop the auth task, tell status' is status, never stop: a transcript that opens with don't, do not, or never is never a stop or reroute proposal. 'Check auth but not in Fable' cites Fable excluded, never destination, and keeps the full wording. 'excluding the billing endpoint' cites the endpoint excluded. A bare discourse no ('No, I meant …') is a correction, not a negation.",
    "When a heard project mention is shown, it is advisory evidence only. Cite the heard text exactly as written when routing to it. A typo or mishearing ('Rivvil' for Rivvl, 'Rival' for Rivvl) never spells a catalog name: cite what was heard as subject or excluded, or omit refs and let the host clarify. Established aliases resolve, but only when cited exactly as heard.",
    "A question about, or follow-up to, the focused task that names no other task or project continues it: use continue, not start. A general question unrelated to any listed project or task uses converse with the question answered in answer; answer is required for converse, null otherwise.",
    "Actions: start creates new work; continue adds a new turn to a ready task; steer adds direction to running work; queue schedules a follow-up; stop interrupts; status reports state; review creates a review task; reroute recreates a task in another project; focus-project changes the project for new work; focus-task changes the selected task; list-projects lists the catalog; converse answers a general question that needs no project or task; unsupported marks a request ARIS cannot do as one action. The host decides steer versus continuation from the task's live state, not from hidden wording.",
    "A pending approval or question is answered by continuing its task: a bare verdict ('yes', 'allow it', 'deny it') or an answer to the waiting question uses continue, never stop, status, or converse. The host binds the reply to the live request; never invent request identity.",
    "Use null when the user did not specify model, effort, or answer. The host dispatches the original transcript minus cited destination spans and composes acceptance speech from the accepted target; proposals carry no wording and no acknowledgement.",
    "Examples:",
    '- "stop authentication" => action stop with one task ref citing authentication.',
    '- "move the API task to Backend" => action reroute with one task ref citing API and one destination ref citing to Backend.',
    '- "in Web, fix the header with Codex" => action start with one destination ref citing in Web and one provider ref citing Codex.',
    '- "Check auth in Rivvl" => action start with one destination ref citing in Rivvl.',
    '- "Check if there are any GitHub PRs in Rivvl" => action start with one destination ref citing in Rivvl.',
    '- "Ask Claude investigate login failure in Jarvis" => action start with one provider ref citing Claude and one destination ref citing in Jarvis.',
    '- "Don\'t stop auth task tell status" => action status with no destination ref.',
    '- "Fix auth, then run its tests" => action start: one coding task with several steps.',
    '- "Stop authentication, then create a deployment task" => action unsupported: two independent Jarvis controls.',
    '- "Fix auth with retries and backoff in Rivvl" => action start with one destination ref citing in Rivvl.',
    '- "In Rivvl compare with Jarvis" => action start with one destination ref citing In Rivvl and optionally Jarvis as subject.',
    '- "PRs mentioning Rivvl in Jarvis repo" => action start with one destination ref citing in Jarvis repo and optionally Rivvl as subject.',
    '- "what is new today?" with no related task => action converse with empty refs and the brief spoken reply (at most 400 characters) as answer.',
    "The deterministic host validates all spans, names, authority, availability, approvals, and dispatch.",
    "",
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
  ].join("\n");
}
