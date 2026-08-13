import {
  MessageId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildActivityVoiceReport,
  buildActivityVoiceReportForActivity,
  buildCompletedVoiceReport,
  buildSessionVoiceReport,
} from "./buildVoiceReport.ts";

const thread: OrchestrationThread = {
  id: ThreadId.make("thread-voice"),
  projectId: ProjectId.make("project-voice"),
  title: "Implement presence",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:01:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [
    {
      id: MessageId.make("message-final"),
      role: "assistant",
      text: "Presence is implemented. Idle CPU remains below one percent.",
      turnId: null,
      streaming: false,
      createdAt: "2026-08-12T00:01:00.000Z",
      updatedAt: "2026-08-12T00:01:00.000Z",
    },
  ],
  activities: [
    {
      id: EventId.make("event-jarvis"),
      tone: "info",
      kind: "jarvis.task.created",
      summary: "Started by Jarvis",
      payload: {},
      turnId: null,
      createdAt: "2026-08-12T00:00:00.000Z",
    },
  ],
  proposedPlans: [],
  checkpoints: [],
  session: null,
};

describe("buildCompletedVoiceReport", () => {
  it("includes the actual completed output for a Jarvis-managed task", () => {
    expect(buildCompletedVoiceReport(thread)).toEqual({
      reportId: "message-final",
      projectId: "project-voice",
      threadId: "thread-voice",
      kind: "completed",
      threadTitle: "Implement presence",
      providerName: "codex",
      text: "Presence is implemented. Idle CPU remains below one percent.",
      createdAt: "2026-08-12T00:01:00.000Z",
    });
  });

  it("does not report ordinary T3 tasks", () => {
    expect(buildCompletedVoiceReport({ ...thread, activities: [] })).toBeNull();
  });
});

describe("buildActivityVoiceReport", () => {
  it("speaks the actual question and options when the agent blocks", () => {
    const blocked: OrchestrationThread = {
      ...thread,
      activities: [
        ...thread.activities,
        {
          id: EventId.make("event-question"),
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            requestId: "request-1",
            questions: [
              {
                id: "database",
                header: "Database",
                question: "Which database should I use?",
                options: [{ label: "Postgres", description: "Use Postgres." }],
              },
            ],
          },
          turnId: null,
          createdAt: "2026-08-12T00:02:00.000Z",
        },
      ],
    };

    expect(buildActivityVoiceReport(blocked, "event-question")).toMatchObject({
      reportId: "event-question",
      kind: "waiting-for-input",
      text: "Which database should I use? Options: Postgres.",
    });
  });

  it("reports approval details and runtime errors", () => {
    const activities = [
      ...thread.activities,
      {
        id: EventId.make("event-approval"),
        tone: "approval" as const,
        kind: "approval.requested",
        summary: "Command approval requested",
        payload: {
          requestId: "request-2",
          requestKind: "command",
          detail: "pnpm exec vitest run apps/server/src/jarvis",
        },
        turnId: null,
        createdAt: "2026-08-12T00:03:00.000Z",
      },
      {
        id: EventId.make("event-error"),
        tone: "error" as const,
        kind: "runtime.error",
        summary: "Runtime error",
        payload: { message: "Provider connection closed" },
        turnId: null,
        createdAt: "2026-08-12T00:04:00.000Z",
      },
    ];

    expect(buildActivityVoiceReport({ ...thread, activities }, "event-approval")).toMatchObject({
      kind: "approval-needed",
      text: "The agent wants to run the tests for this project. This reads the project and may use extra processing power for a few minutes. Allow it?",
      approvalRisk: "read-and-compute",
      rawDetail: "pnpm exec vitest run apps/server/src/jarvis",
    });
    expect(buildActivityVoiceReport({ ...thread, activities }, "event-error")).toMatchObject({
      kind: "failed",
      text: "Provider connection closed",
    });
  });

  it("reports provider command failures directly from the triggering activity", () => {
    const failure = {
      id: EventId.make("event-provider-failure"),
      tone: "error" as const,
      kind: "provider.user-input.respond.failed",
      summary: "Provider user input response failed",
      payload: { detail: "The provider no longer has that request open." },
      turnId: null,
      createdAt: "2026-08-12T00:05:00.000Z",
    };
    expect(buildActivityVoiceReportForActivity(thread, failure)).toMatchObject({
      kind: "failed",
      text: "The provider no longer has that request open.",
    });
  });
});

describe("buildSessionVoiceReport", () => {
  it("reports completion only from a ready terminal session transition", () => {
    expect(
      buildSessionVoiceReport(
        thread,
        {
          threadId: thread.id,
          status: "ready",
          providerName: "Codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-08-12T00:06:00.000Z",
        },
        "session-ready",
      ),
    ).toMatchObject({ kind: "completed", text: thread.messages[0]?.text });
  });
});
