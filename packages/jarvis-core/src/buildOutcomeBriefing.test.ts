import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
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
  it("keeps the main outcome and verification instead of reading a changelog", () => {
    const result = [
      "Implemented exact completion reporting for Jarvis.",
      "",
      "- Added a report cursor.",
      "- Updated the Companion relay.",
      "",
      "Verification:",
      "- 24 focused tests passed.",
    ].join("\n");

    expect(buildOutcomeBriefing({ thread, messageId, result, completedAt })).toMatchObject({
      goal: "Make voice reports dependable.",
      outcome: "I've implemented exact completion reporting for Jarvis.",
      verification: ["24 focused tests passed."],
      spokenText:
        "I've implemented exact completion reporting for Jarvis. 24 focused tests passed.",
    });
  });

  it("never reads code blocks or file-level detail as the outcome", () => {
    const result = [
      "Done.",
      "`apps/server/src/ws.ts` now subscribes to the final event.",
      "```ts",
      "const secret = 'not for speech';",
      "```",
      "The current turn now reports once.",
    ].join("\n");

    expect(buildOutcomeBriefing({ thread, messageId, result, completedAt }).spokenText).toBe(
      "The current turn now reports once.",
    );
  });

  it("retains important findings and common changes headings", () => {
    const result = [
      "Review complete.",
      "Important findings:",
      "- I found a critical privilege-escalation issue.",
      "Changes made:",
      "- Fixed the authorization guard.",
      "Tests:",
      "- Tests passed.",
    ].join("\n");

    expect(buildOutcomeBriefing({ thread, messageId, result, completedAt })).toMatchObject({
      outcome: "I found a critical privilege-escalation issue.",
      findings: ["I found a critical privilege-escalation issue."],
      changeDetails: ["Fixed the authorization guard."],
      verification: ["Tests passed."],
      spokenText:
        "I found a critical privilege-escalation issue. Fixed the authorization guard. Tests passed.",
    });
  });

  it("skips a generic preamble and keeps the meaningful following outcome", () => {
    expect(
      buildOutcomeBriefing({
        thread,
        messageId,
        result: "Here's what I found.\nThere is a critical privilege-escalation issue.",
        completedAt,
      }).outcome,
    ).toBe("Here's what I found. There is a critical privilege-escalation issue.");
  });
});
