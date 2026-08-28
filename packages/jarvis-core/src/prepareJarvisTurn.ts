import type { JarvisProjectAlias, OrchestrationProjectShell, ProjectId } from "@t3tools/contracts";

import { classifySpokenRequest, type SpokenRequestKind } from "./classifySpokenRequest.ts";
import { interpretControlIntent, type JarvisControlIntent } from "./interpretControlIntent.ts";
import { resolveProjectTarget } from "./resolveProjectTarget.ts";

export type JarvisTurnExecutionPolicy = "default" | "approval-required";

export type PreparedJarvisTurn =
  | { readonly status: "project-catalog-required" }
  | {
      readonly status: "needs-input";
      readonly prompt: string;
      readonly choices: ReadonlyArray<string>;
      readonly candidates: ReadonlyArray<{
        readonly projectId: ProjectId;
        readonly label: string;
        readonly learnedAlias?: string;
      }>;
    }
  | {
      readonly status: "ready";
      readonly sourceUtterance: string;
      readonly utterance: string;
      readonly projectId: ProjectId;
      readonly controlIntent: JarvisControlIntent;
      readonly requestKind: SpokenRequestKind;
      readonly executionPolicy: JarvisTurnExecutionPolicy;
    };

/**
 * Owns every deterministic decision that must happen before a provider sees a
 * Jarvis turn. Callers supply live project state and apply the returned plan.
 */
export function prepareJarvisTurn(input: {
  readonly utterance: string;
  readonly currentProjectId: ProjectId;
  readonly projects?: ReadonlyArray<OrchestrationProjectShell>;
  readonly aliases?: ReadonlyArray<JarvisProjectAlias>;
  readonly confirmedProjectId?: ProjectId;
  readonly inputMode?: "voice";
  readonly continueContext?: boolean;
}): PreparedJarvisTurn {
  const sourceUtterance = input.utterance.trim();
  const controlIntent = interpretControlIntent(sourceUtterance);
  const inferNamedTarget =
    input.inputMode === "voice" &&
    controlIntent.action === "new-task" &&
    input.continueContext !== true;
  const shouldResolveProject =
    input.confirmedProjectId !== undefined ||
    controlIntent.action === "focus-project" ||
    controlIntent.action === "reroute" ||
    inferNamedTarget;
  if (shouldResolveProject && input.projects === undefined) {
    return { status: "project-catalog-required" };
  }
  const target = shouldResolveProject
    ? resolveProjectTarget({
        utterance: sourceUtterance,
        projects: input.projects ?? [],
        aliases: input.aliases ?? [],
        inferNamedTarget,
        ...(input.confirmedProjectId === undefined
          ? {}
          : { confirmedProjectId: input.confirmedProjectId }),
      })
    : { status: "not-requested" as const };

  if (target.status === "needs-input") {
    return {
      status: "needs-input",
      prompt: target.prompt,
      choices: target.choices,
      candidates: target.candidates,
    };
  }

  const utterance =
    target.status === "resolved" ? (target.correctedUtterance ?? sourceUtterance) : sourceUtterance;
  const groundedControlIntent = interpretControlIntent(utterance);
  const requestKind = input.inputMode === "voice" ? classifySpokenRequest(utterance) : "unknown";

  return {
    status: "ready",
    sourceUtterance,
    utterance,
    projectId: target.status === "resolved" ? target.projectId : input.currentProjectId,
    controlIntent: groundedControlIntent,
    requestKind,
    executionPolicy: "default",
  };
}
