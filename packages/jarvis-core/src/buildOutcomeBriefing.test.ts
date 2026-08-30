import {
  CheckpointRef,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildOutcomeBriefing } from "./buildOutcomeBriefing.ts";

const completedAt = "2026-08-12T00:01:00.000Z";
const messageId = MessageId.make("message-briefing");
const thread: OrchestrationThread = {
  id: ThreadId.make("thread-briefing"),
  projectId: ProjectId.make("project-briefing"),
  title: "Ground voice reports",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: completedAt,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [
    {
      id: EventId.make("event-briefing-created"),
      tone: "info",
      kind: "jarvis.task.created",
      summary: "Started by Jarvis",
      payload: { objective: "Make voice reports dependable." },
      turnId: null,
      createdAt: "2026-08-12T00:00:00.000Z",
    },
  ],
  checkpoints: [],
  session: null,
};

describe("buildOutcomeBriefing", () => {
  it("formats a plain provider summary without classifying its sentences", () => {
    const result = "The result is ready. Tests passed. Deployment is not part of this task.";

    expect(buildOutcomeBriefing({ thread, messageId, result, completedAt })).toMatchObject({
      goal: "Make voice reports dependable.",
      outcome: result,
      findings: [],
      changeDetails: [],
      verification: [],
      limitations: [],
      nextActions: [],
      spokenText: result,
    });
  });

  it("uses structured status and detail fields when supplied", () => {
    expect(
      buildOutcomeBriefing({
        thread,
        messageId,
        result: "Provider prose that must not be classified.",
        completedAt,
        outcome: {
          status: "partial",
          summary: "The requested change is ready for review.",
          findings: ["One known limitation remains."],
          changes: ["Updated the report formatter."],
          checks: ["Focused tests passed."],
          blockers: ["Production deployment was not requested."],
          nextActions: ["Review the resulting diff."],
        },
      }),
    ).toMatchObject({
      outcome: "Partially completed: The requested change is ready for review.",
      findings: ["One known limitation remains."],
      changeDetails: ["Updated the report formatter."],
      verification: ["Focused tests passed."],
      limitations: ["Production deployment was not requested."],
      nextActions: ["Review the resulting diff."],
      spokenText:
        "Partially completed: The requested change is ready for review. One known limitation remains. Updated the report formatter. Focused tests passed. Production deployment was not requested. Review the resulting diff.",
    });
  });

  it.each([
    ["success", "Completed"],
    ["failure", "Failed"],
    ["interrupted", "Interrupted"],
  ] as const)("keeps the %s label only when structured status supplies it", (status, label) => {
    expect(
      buildOutcomeBriefing({
        thread,
        messageId,
        result: "Contradictory prose says this succeeded and failed.",
        completedAt,
        outcome: { status, summary: "Structured result summary." },
      }).outcome,
    ).toBe(`${label}: Structured result summary.`);
  });

  it("does not infer deployment, blockers, or success from contradictory prose", () => {
    const result =
      "Deployment is working. Deployment is broken. Tests passed. Remaining blocker: credentials.";
    const briefing = buildOutcomeBriefing({ thread, messageId, result, completedAt });

    expect(briefing.outcome).toBe(result);
    expect(briefing.limitations).toEqual([]);
    expect(briefing.verification).toEqual([]);
  });

  it("drops fenced code and bounds speech without changing the report result", () => {
    const result = `${"A long provider summary. ".repeat(80)}\n\n\`\`\`sh\nrm -rf /\n\`\`\``;
    const briefing = buildOutcomeBriefing({ thread, messageId, result, completedAt });

    expect(briefing.spokenText.length).toBeLessThanOrEqual(600);
    expect(briefing.spokenText).not.toContain("rm -rf");
    expect(briefing.outcome.length).toBeLessThanOrEqual(1_000);
  });

  it("retains structured checkpoint change counts without speaking them", () => {
    const briefing = buildOutcomeBriefing({
      thread: {
        ...thread,
        checkpoints: [
          {
            turnId: TurnId.make("turn-briefing"),
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-briefing/turn/1"),
            status: "ready",
            files: [{ path: "src/report.ts", kind: "modified", additions: 2, deletions: 1 }],
            assistantMessageId: messageId,
            completedAt,
          },
        ],
      },
      messageId,
      result: "The report is ready.",
      completedAt,
    });

    expect(briefing.changes).toEqual({ fileCount: 1, additions: 2, deletions: 1 });
    expect(briefing.spokenText).toBe("The report is ready.");
  });
});
