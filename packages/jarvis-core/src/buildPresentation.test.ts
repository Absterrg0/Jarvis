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
      id: MessageId.make("message-user-1"),
      role: "user",
      text: "Implement presence",
      turnId: null,
      streaming: false,
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
    },
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
        messageId: MessageId.make("message-user-1"),
        taskRef: {
          executionNodeId: EnvironmentId.make("node-1"),
          threadId: ThreadId.make("thread-voice"),
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
          userMessageId: "message-user-1",
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

  it("routes each result to its correlated Jarvis turn", () => {
    const continuedThread: OrchestrationThread = {
      ...thread,
      messages: [
        ...thread.messages,
        {
          id: MessageId.make("message-user-2"),
          role: "user",
          text: "Continue",
          turnId: null,
          streaming: false,
          createdAt: "2026-08-12T00:01:20.000Z",
          updatedAt: "2026-08-12T00:01:20.000Z",
        },
        {
          id: MessageId.make("message-final-2"),
          role: "assistant",
          text: "Continuation finished.",
          turnId: TurnId.make("turn-2"),
          streaming: false,
          createdAt: "2026-08-12T00:02:00.000Z",
          updatedAt: "2026-08-12T00:02:00.000Z",
        },
      ],
      activities: [
        ...thread.activities,
        {
          id: EventId.make("event-turn-origin"),
          tone: "info",
          kind: "jarvis.turn.origin",
          summary: "Continued by Jarvis",
          payload: {
            messageId: MessageId.make("message-user-2"),
            requestMetadata: {
              requestId: "request-2",
              origin: {
                originNodeId: EnvironmentId.make("controller-2"),
                originInteractionId: "interaction-2",
              },
            },
          },
          turnId: null,
          createdAt: "2026-08-12T00:01:30.000Z",
        },
      ],
    };

    expect(
      buildActivityPresentationForActivity(
        continuedThread,
        activity(
          "provider.turn.result-finalized",
          {
            turnId: "turn-2",
            userMessageId: "message-user-2",
            assistantMessageId: "message-final-2",
            state: "completed",
          },
          TurnId.make("turn-2"),
        ),
      ),
    ).toMatchObject({
      origin: {
        originNodeId: "controller-2",
        originInteractionId: "interaction-2",
      },
      taskRef: { executionNodeId: "node-1" },
    });
    expect(
      buildActivityPresentationForActivity(
        continuedThread,
        activity("provider.turn.result-finalized", {
          turnId: "turn-1",
          userMessageId: "message-user-1",
          assistantMessageId: "message-final",
          state: "completed",
        }),
      ),
    ).toMatchObject({ origin: { originInteractionId: "interaction-1" } });
  });

  it("does not route an ordinary UI continuation to an earlier Jarvis interaction", () => {
    const ordinaryUserMessage = MessageId.make("message-user-ui");
    const ordinaryAssistantMessage = MessageId.make("message-final-ui");
    const continuedThread: OrchestrationThread = {
      ...thread,
      messages: [
        ...thread.messages,
        {
          id: ordinaryUserMessage,
          role: "user",
          text: "Continue from the UI",
          turnId: null,
          streaming: false,
          createdAt: "2026-08-12T00:02:00.000Z",
          updatedAt: "2026-08-12T00:02:00.000Z",
        },
        {
          id: ordinaryAssistantMessage,
          role: "assistant",
          text: "UI continuation finished.",
          turnId: TurnId.make("turn-ui"),
          streaming: false,
          createdAt: "2026-08-12T00:03:00.000Z",
          updatedAt: "2026-08-12T00:03:00.000Z",
        },
      ],
    };

    expect(
      buildActivityPresentationForActivity(
        continuedThread,
        activity(
          "provider.turn.result-finalized",
          {
            turnId: "turn-ui",
            userMessageId: ordinaryUserMessage,
            assistantMessageId: ordinaryAssistantMessage,
            state: "completed",
          },
          TurnId.make("turn-ui"),
        ),
      ),
    ).toBeNull();
  });

  it("bounds the provider summary without inferring status or deployment", () => {
    const result =
      "Deployment passed. Deployment failed. Tests passed. Remaining blocker: credentials.";
    const presentation = buildCompletedPresentation({
      ...thread,
      messages: [thread.messages[0]!, { ...thread.messages[1]!, text: result }],
    });

    expect(presentation?.text).toBe(result);
  });

  it("omits fenced code and uses a safe fallback for an empty result", () => {
    const codePresentation = buildCompletedPresentation({
      ...thread,
      messages: [
        thread.messages[0]!,
        { ...thread.messages[1]!, text: "Summary.\n```sh\nrm -rf /\n```" },
      ],
    });
    expect(codePresentation?.text).toBe("Summary.");

    const emptyPresentation = buildCompletedPresentation({
      ...thread,
      messages: [thread.messages[0]!, { ...thread.messages[1]!, text: "   " }],
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
