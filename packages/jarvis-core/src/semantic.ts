import type { JarvisProjectAlias, OrchestrationProjectShell, ProjectId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { JarvisCommandContext, JarvisCommandNeedsInput } from "./command.ts";
import { groundVoiceTurn, type VoiceProjectCandidate } from "./groundVoiceTurn.ts";

export const JarvisSemanticIntent = Schema.Struct({
  action: Schema.Literals([
    "start",
    "continue",
    "steer",
    "queue",
    "stop",
    "status",
    "review",
    "reroute",
    "focus-project",
    "focus-task",
    "list-projects",
  ]),
  project: Schema.NullOr(Schema.String),
  task: Schema.NullOr(Schema.String),
  instruction: Schema.NullOr(Schema.String),
  provider: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  effort: Schema.NullOr(Schema.String),
});
export type JarvisSemanticIntent = typeof JarvisSemanticIntent.Type;

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
  [
    project.title,
    semanticBasename(project.workspaceRoot),
    project.repositoryIdentity?.displayName,
    project.repositoryIdentity?.name,
    ...aliases.filter((alias) => alias.projectId === project.id).map((alias) => alias.alias),
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

const projectCandidates = (
  projects: ReadonlyArray<OrchestrationProjectShell>,
  aliases: ReadonlyArray<JarvisProjectAlias>,
): ReadonlyArray<VoiceProjectCandidate<OrchestrationProjectShell>> =>
  projects.map((project) => ({
    id: project.id,
    title: project.title,
    label: `${project.title} — ${semanticBasename(project.workspaceRoot)}`,
    names: projectSemanticNames(project, aliases),
    project,
  }));

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

export type PreparedJarvisSemanticTurn =
  | { readonly status: "ready"; readonly utterance: string; readonly projectId?: ProjectId }
  | JarvisCommandNeedsInput;

/** Acoustic grounding stays deterministic and precedes semantic interpretation. */
export function prepareJarvisSemanticTurn(input: JarvisCommandContext): PreparedJarvisSemanticTurn {
  const utterance = input.utterance.trim();
  if (!/[\p{Letter}\p{Number}]/u.test(utterance)) {
    return {
      status: "needs-input",
      reason: "unsupported-command",
      prompt: "I couldn't understand that command. State the task or control action you want.",
      choices: [],
    };
  }
  if (input.inputMode !== "voice" && input.confirmedProjectId === undefined) {
    return { status: "ready", utterance };
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
  return grounded.status === "resolved"
    ? { status: "ready", utterance: grounded.utterance, projectId: grounded.project.id }
    : { status: "ready", utterance: grounded.utterance };
}

export function buildJarvisSemanticPrompt(
  input: JarvisCommandContext,
  prepared: Extract<PreparedJarvisSemanticTurn, { status: "ready" }>,
): string {
  const projects = input.projects.map((project) => ({
    name: project.title,
    aliases: projectSemanticNames(project, input.aliases).filter((name) => name !== project.title),
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
  return [
    "Translate one Jarvis request into one structured semantic proposal.",
    "Return only the schema fields. Never invent or return internal IDs.",
    "Use exact catalog names when naming a project, task, provider, model, or effort.",
    "Use null when the user did not specify a field. Put the work or reply text in instruction.",
    "Actions: start creates new work; continue adds a new turn to a ready task; steer adds direction to running work; queue schedules a follow-up; stop interrupts; status reports state; review creates a review task; reroute recreates a task in another project; focus-project changes the project for new work; focus-task changes the selected task; list-projects lists the catalog.",
    "Examples:",
    '- "stop authentication" => action stop, task Authentication, all other unspecified fields null.',
    '- "move the API task to Backend" => action reroute, task API, project Backend, instruction null.',
    '- "in Web, fix the header with Codex" => action start, project Web, provider Codex, instruction fix the header.',
    "The deterministic host validates all names, authority, availability, approvals, and dispatch.",
    "",
    `Request: ${prepared.utterance.slice(0, 16_000)}`,
    `Continue selected conversation: ${input.continueContext}`,
    `Current project: ${input.projects.find((project) => project.id === input.currentProjectId)?.title ?? "unknown"}`,
    `Projects: ${JSON.stringify(projects)}`,
    `Recent tasks: ${JSON.stringify(tasks)}`,
    `Providers: ${JSON.stringify(providers)}`,
  ].join("\n");
}
