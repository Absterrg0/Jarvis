import {
  CheckpointRef,
  EnvironmentId,
  MessageId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
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
      briefing: {
        goal: "Implement presence",
        outcome: "Presence is implemented. Idle CPU remains below one percent.",
        findings: [],
        changeDetails: [],
        verification: [],
        limitations: [],
        nextActions: [],
        spokenText: "Presence is implemented. Idle CPU remains below one percent.",
      },
      createdAt: "2026-08-12T00:01:00.000Z",
    });
  });

  it("does not report ordinary T3 tasks", () => {
    expect(buildCompletedVoiceReport({ ...thread, activities: [] })).toBeNull();
  });

  it("copies routed task identity and origin from the durable task marker", () => {
    const taskRef = {
      executionNodeId: EnvironmentId.make("environment-worker"),
      remoteTaskId: thread.id,
      remoteThreadId: thread.id,
      projectId: thread.projectId,
      providerId: thread.modelSelection.instanceId,
    };
    const origin = {
      originNodeId: EnvironmentId.make("environment-companion"),
      originInteractionId: "interaction-1",
    };
    const routedThread = {
      ...thread,
      activities: [
        {
          ...thread.activities[0]!,
          payload: {
            objective: "Implement presence",
            taskRef,
            requestMetadata: { requestId: "request-1", origin },
          },
        },
      ],
    };
    const question = {
      ...thread.activities[0]!,
      id: EventId.make("event-routed-question"),
      kind: "user-input.requested" as const,
      payload: { questions: [{ question: "Which database?" }] },
    };
    const approval = {
      ...thread.activities[0]!,
      id: EventId.make("event-routed-approval"),
      kind: "approval.requested" as const,
      payload: { requestKind: "command", detail: "pnpm test" },
    };
    const failure = {
      ...thread.activities[0]!,
      id: EventId.make("event-routed-failure"),
      kind: "runtime.error" as const,
      payload: { message: "Provider connection closed" },
    };

    expect(buildCompletedVoiceReport(routedThread)).toMatchObject({ taskRef, origin });
    expect(
      buildActivityVoiceReportForActivity(
        { ...routedThread, activities: [...routedThread.activities, question] },
        question,
      ),
    ).toMatchObject({ taskRef, origin });
    expect(
      buildActivityVoiceReportForActivity(
        { ...routedThread, activities: [...routedThread.activities, approval] },
        approval,
      ),
    ).toMatchObject({ taskRef, origin });
    expect(
      buildActivityVoiceReportForActivity(
        { ...routedThread, activities: [...routedThread.activities, failure] },
        failure,
      ),
    ).toMatchObject({ taskRef, origin });
    expect(
      buildSessionVoiceReport(
        routedThread,
        {
          threadId: thread.id,
          status: "error",
          providerName: "Codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: "Provider connection closed",
          updatedAt: "2026-08-12T00:06:00.000Z",
        },
        "session-failed",
      ),
    ).toMatchObject({ taskRef, origin });
  });

  it("reports the review thread, not the source thread that requested the review", () => {
    const reviewSource = {
      ...thread.activities[0]!,
      kind: "jarvis.review.source",
      payload: {
        sourceThreadId: ThreadId.make("thread-source"),
        objective: "Use Fable to review this Codex output.",
      },
    };
    const reviewRequested = {
      ...thread.activities[0]!,
      kind: "jarvis.review.requested",
      payload: { reviewThreadId: "thread-review" },
    };
    expect(buildCompletedVoiceReport({ ...thread, activities: [reviewSource] })).toMatchObject({
      kind: "completed",
      briefing: { goal: "Use Fable to review this Codex output." },
    });
    expect(buildCompletedVoiceReport({ ...thread, activities: [reviewRequested] })).toBeNull();
    expect(
      buildActivityVoiceReportForActivity(
        { ...thread, activities: [reviewRequested] },
        {
          ...reviewRequested,
          kind: "runtime.error",
          tone: "error",
          summary: "Unrelated failure",
          payload: { message: "Unrelated failure" },
        },
      ),
    ).toBeNull();
  });

  it("uses the exact final message event instead of a stale result from another turn", () => {
    const stale = {
      ...thread.messages[0]!,
      id: MessageId.make("message-stale"),
      text: "Old result.",
    };
    const current = {
      ...thread.messages[0]!,
      id: MessageId.make("message-current"),
      text: "Current result.",
    };
    expect(
      buildCompletedVoiceReport(
        { ...thread, messages: [stale, current] },
        MessageId.make("message-current"),
      ),
    ).toMatchObject({ reportId: "message-current", text: "Current result." });
    expect(
      buildCompletedVoiceReport(
        { ...thread, messages: [stale, current] },
        MessageId.make("message-missing"),
      ),
    ).toBeNull();
  });

  it("projects a grounded outcome briefing without replacing the full provider result", () => {
    const result = [
      "I found one serious issue in the admin revocation flow.",
      "",
      "Verification:",
      "- Type-checking passed.",
      "- Lint could not run because the plugin is unavailable.",
      "",
      "Next action: Would you like me to fix it?",
    ].join("\n");
    const turnId = TurnId.make("turn-review");
    const report = buildCompletedVoiceReport({
      ...thread,
      activities: [
        {
          ...thread.activities[0]!,
          payload: { objective: "Review the admin revocation flow." },
        },
      ],
      messages: [
        {
          ...thread.messages[0]!,
          id: MessageId.make("message-user"),
          role: "user",
          text: "Please do that review now.",
          turnId,
          createdAt: "2026-08-12T00:00:30.000Z",
          updatedAt: "2026-08-12T00:00:30.000Z",
        },
        { ...thread.messages[0]!, text: result, turnId },
      ],
      checkpoints: [
        {
          turnId,
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-voice/turn/1"),
          status: "ready",
          files: [
            { path: "src/admin.ts", kind: "modified", additions: 12, deletions: 4 },
            { path: "src/admin.test.ts", kind: "added", additions: 30, deletions: 0 },
          ],
          assistantMessageId: MessageId.make("message-final"),
          completedAt: "2026-08-12T00:01:00.000Z",
        },
      ],
    });

    expect(report).toMatchObject({
      text: result,
      briefing: {
        goal: "Review the admin revocation flow.",
        outcome: "I found one serious issue in the admin revocation flow.",
        findings: [],
        changes: { fileCount: 2, additions: 42, deletions: 4 },
        changeDetails: [],
        verification: ["Type-checking passed."],
        limitations: ["Lint could not run because the plugin is unavailable."],
        nextActions: ["Would you like me to fix it?"],
        spokenText:
          "I found one serious issue in the admin revocation flow. I changed 2 files. Type-checking passed. Lint could not run because the plugin is unavailable. Would you like me to fix it?",
      },
    });
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

  it("reports the exact finalized result when a workspace has no checkpoint", () => {
    const activity = {
      id: EventId.make("event-no-checkpoint-completion"),
      tone: "info" as const,
      kind: "jarvis.turn.completion-ready",
      summary: "Jarvis completion ready",
      payload: {
        turnId: "turn-no-checkpoint",
        assistantMessageId: "message-final",
        state: "completed",
      },
      turnId: null,
      createdAt: "2026-08-12T00:04:30.000Z",
    };
    expect(buildActivityVoiceReportForActivity(thread, activity)).toMatchObject({
      reportId: "message-final",
      kind: "completed",
      text: "Presence is implemented. Idle CPU remains below one percent.",
    });
  });

  it("keeps recoverable response failures attached to the pending blocker", () => {
    const failure = {
      id: EventId.make("event-provider-failure"),
      tone: "error" as const,
      kind: "provider.user-input.respond.failed",
      summary: "Provider user input response failed",
      payload: { detail: "The provider connection closed before the response was sent." },
      turnId: null,
      createdAt: "2026-08-12T00:05:00.000Z",
    };
    expect(buildActivityVoiceReportForActivity(thread, failure)).toMatchObject({
      kind: "waiting-for-input",
      text: "I couldn't send that response. The task is still waiting for your input. The provider connection closed before the response was sent.",
    });
    expect(
      buildActivityVoiceReportForActivity(thread, {
        ...failure,
        id: EventId.make("event-approval-response-failure"),
        kind: "provider.approval.respond.failed",
      }),
    ).toMatchObject({
      kind: "approval-needed",
      text: "I couldn't send that approval. The task still needs your decision. The provider connection closed before the response was sent.",
    });
    expect(
      buildActivityVoiceReportForActivity(thread, {
        ...failure,
        id: EventId.make("event-stale-response-failure"),
        payload: { detail: "Unknown pending user-input request." },
      }),
    ).toMatchObject({
      kind: "failed",
      text: "I couldn't send that response because the request is no longer open. Unknown pending user-input request.",
    });
  });
});

describe("buildSessionVoiceReport", () => {
  it("waits for the exact final assistant message instead of reporting session readiness", () => {
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
    ).toBeNull();
  });
});
