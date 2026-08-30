import {
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildActivityPresentationForActivity,
  buildCompletedPresentation,
} from "./buildPresentation.ts";

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
      turnId: TurnId.make("turn-1"),
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
      payload: {
        objective: "Implement presence",
        taskRef: {
          executionNodeId: EnvironmentId.make("node-1"),
          remoteTaskId: "thread-voice",
          remoteThreadId: ThreadId.make("thread-voice"),
          projectId: ProjectId.make("project-voice"),
          providerId: ProviderInstanceId.make("codex"),
        },
        requestMetadata: {
          requestId: "request-1",
          origin: {
            originNodeId: EnvironmentId.make("controller-1"),
            originInteractionId: "interaction-1",
          },
        },
      },
      turnId: null,
      createdAt: "2026-08-12T00:00:00.000Z",
    },
  ],
  proposedPlans: [],
  checkpoints: [],
  session: null,
};

const activity = (
  kind: string,
  payload: unknown,
  turnId: TurnId | null = TurnId.make("turn-1"),
) => ({
  id: EventId.make(`event-${kind}`),
  tone:
    kind.includes("failed") || kind === "runtime.error" ? ("error" as const) : ("info" as const),
  kind,
  summary: kind,
  payload,
  turnId,
  createdAt: "2026-08-12T00:02:00.000Z",
});

describe("Jarvis live presentation projection", () => {
  it("projects the authoritative final result into a short completion event", () => {
    expect(
      buildActivityPresentationForActivity(
        thread,
        activity("provider.turn.result-finalized", {
          turnId: "turn-1",
          assistantMessageId: "message-final",
          state: "completed",
        }),
      ),
    ).toMatchObject({
      presentationId: "event-provider.turn.result-finalized",
      kind: "completed",
      origin: { originInteractionId: "interaction-1" },
      taskRef: { executionNodeId: "node-1" },
      text: "Presence is implemented. Idle CPU remains below one percent.",
    });
  });

  it("bounds the provider summary without inferring status or deployment", () => {
    const result =
      "Deployment passed. Deployment failed. Tests passed. Remaining blocker: credentials.";
    const presentation = buildCompletedPresentation({
      ...thread,
      messages: [{ ...thread.messages[0]!, text: result }],
    });

    expect(presentation?.text).toBe(result);
  });

  it("omits fenced code and uses a safe fallback for an empty result", () => {
    const codePresentation = buildCompletedPresentation({
      ...thread,
      messages: [{ ...thread.messages[0]!, text: "Summary.\n```sh\nrm -rf /\n```" }],
    });
    expect(codePresentation?.text).toBe("Summary.");

    const emptyPresentation = buildCompletedPresentation({
      ...thread,
      messages: [{ ...thread.messages[0]!, text: "   " }],
    });
    expect(emptyPresentation?.text).toBe("The agent did not provide a summary.");
  });

  it("projects pending input and approval without copying durable T3 state", () => {
    expect(
      buildActivityPresentationForActivity(
        thread,
        activity("user-input.requested", {
          questions: [{ question: "Which database?", options: [{ label: "SQLite" }] }],
        }),
      ),
    ).toMatchObject({ kind: "waiting-for-input", text: "Which database? Options: SQLite." });
    expect(
      buildActivityPresentationForActivity(
        thread,
        activity("approval.requested", { detail: "Run the migration", requestKind: "command" }),
      ),
    ).toMatchObject({ kind: "approval-needed" });
  });

  it("never presents ordinary T3 work or an unqualified legacy task", () => {
    const ordinary = { ...thread, activities: [] };
    expect(buildCompletedPresentation(ordinary)).toBeNull();
    expect(
      buildActivityPresentationForActivity(
        ordinary,
        activity("provider.turn.result-finalized", {
          turnId: "turn-1",
          assistantMessageId: "message-final",
          state: "completed",
        }),
      ),
    ).toBeNull();
    expect(
      buildActivityPresentationForActivity(
        {
          ...thread,
          activities: [{ ...thread.activities[0]!, payload: { objective: "no origin" } }],
        },
        activity("runtime.error", { message: "Disconnected" }),
      ),
    ).toBeNull();
  });
});
