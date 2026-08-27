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
    ).toBe("There is a critical privilege-escalation issue.");
  });

  it("speaks an agent clarification directly instead of calling it an unclear answer", () => {
    const question =
      "What would you like me to check about Alertify: its codebase, current status, or something specific?";
    expect(
      buildOutcomeBriefing({
        thread: {
          ...thread,
          activities: [
            {
              ...thread.activities[0]!,
              payload: { objective: "Can you please check out Alertify?" },
            },
          ],
        },
        messageId,
        result: question,
        completedAt,
      }),
    ).toMatchObject({
      outcome: question,
      nextActions: [question],
      spokenText: question,
    });
  });

  it("answers whether a deployment works instead of reporting task bookkeeping", () => {
    const result = [
      "Deployment checks completed:",
      "",
      "- Tests: 83/83 passed.",
      "- Production build: passed.",
      "- Runtime smoke tests: /, /pricing, robots.txt, and sitemap.xml all returned 200.",
      "- Fixed the merged analytics panel TypeScript error by adding the missing warning tone.",
      "- Remaining build output contains only non-blocking lint/Tailwind/Browserslist warnings.",
      "",
      "Changed file: AnalyticsPanel.tsx",
    ].join("\n");

    expect(
      buildOutcomeBriefing({
        thread: {
          ...thread,
          activities: [
            {
              ...thread.activities[0]!,
              payload: { objective: "Check whether the deployment is working." },
            },
          ],
          checkpoints: [
            {
              turnId: TurnId.make("turn-deployment-check"),
              checkpointTurnCount: 1,
              checkpointRef: CheckpointRef.make(
                "refs/t3/checkpoints/thread-briefing/turn/deployment-check",
              ),
              status: "ready",
              files: [{ path: "AnalyticsPanel.tsx", kind: "modified", additions: 1, deletions: 0 }],
              assistantMessageId: messageId,
              completedAt,
            },
          ],
        },
        messageId,
        result,
        completedAt,
      }).spokenText,
    ).toBe(
      "Deployment is working. All 83 tests passed, the production build passed, and the checked routes returned 200. I fixed one TypeScript error. Only non-blocking warnings remain.",
    );
  });

  it("states why a deployment is broken and what to do next", () => {
    const result = [
      "Deployment check failed:",
      "",
      "- Production build failed because VITE_API_URL is missing.",
      "- Next step: Add VITE_API_URL to the production environment and redeploy.",
    ].join("\n");

    expect(
      buildOutcomeBriefing({
        thread: {
          ...thread,
          activities: [
            {
              ...thread.activities[0]!,
              payload: { objective: "Check whether the deployment is working." },
            },
          ],
        },
        messageId,
        result,
        completedAt,
      }).spokenText,
    ).toBe(
      "Deployment is not working. The production build failed because VITE_API_URL is missing. Add VITE_API_URL to the production environment, then redeploy.",
    );
  });

  it("keeps a concrete change summary that ends with a colon", () => {
    const result = [
      "Added a cinematic light effect to the landing-page hero:",
      "",
      "- Soft warm spotlight follows pointer movement.",
      "- Gentle ambient breathing animation.",
      "",
      "Production build passes successfully.",
    ].join("\n");

    expect(buildOutcomeBriefing({ thread, messageId, result, completedAt })).toMatchObject({
      outcome: "I've added a cinematic light effect to the landing-page hero:",
      spokenText:
        "I've added a cinematic light effect to the landing-page hero: Production build passes successfully.",
    });
  });
});
