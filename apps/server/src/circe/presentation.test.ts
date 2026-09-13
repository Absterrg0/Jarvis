import {
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildCircePresentation,
  isCircePresentationSource,
  isPresentationForOrigin,
} from "./presentation.ts";

const threadId = ThreadId.make("thread-presentation");
const projectId = ProjectId.make("project-presentation");
const turnId = TurnId.make("turn-presentation");
const assistantMessageId = MessageId.make("message-presentation");
const originNodeId = EnvironmentId.make("controller-presentation");
const now = "2026-08-30T00:00:00.000Z";

const thread: OrchestrationThread = {
  id: threadId,
  projectId,
  title: "Presentation task",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  pullRequests: [],
  deletedAt: null,
  messages: [
    {
      id: assistantMessageId,
      role: "assistant",
      text: "The task finished on the execution node.",
      turnId,
      streaming: false,
      createdAt: now,
      updatedAt: now,
    },
  ],
  activities: [
    {
      id: EventId.make("activity-task-created-presentation"),
      tone: "info",
      kind: "circe.task.created",
      summary: "Started by Circe",
      payload: {
        objective: "Finish the presentation task.",
        taskRef: {
          executionNodeId: EnvironmentId.make("execution-presentation"),
          threadId,
        },
        requestMetadata: {
          requestId: "request-presentation",
          origin: {
            originNodeId,
            originInteractionId: "interaction-presentation",
          },
        },
      },
      turnId: null,
      createdAt: now,
    },
  ],
  proposedPlans: [],
  checkpoints: [],
  session: null,
};

const activityEvent = (
  kind: string,
  payload: unknown,
): Extract<OrchestrationEvent, { type: "thread.activity-appended" }> => ({
  aggregateKind: "thread",
  aggregateId: threadId,
  sequence: 2,
  eventId: EventId.make(`event-${kind}`),
  occurredAt: now,
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type: "thread.activity-appended",
  payload: {
    threadId,
    activity: {
      id: EventId.make(`activity-${kind}`),
      tone: kind.endsWith("failed") || kind === "runtime.error" ? "error" : "info",
      kind,
      summary: kind,
      payload,
      turnId,
      createdAt: now,
    },
  },
});

describe("Circe live presentation adapter", () => {
  it("projects a terminal T3 activity for the exact origin", () => {
    const event = activityEvent("provider.turn.result-finalized", {
      turnId,
      assistantMessageId,
      state: "completed",
    });

    expect(isCircePresentationSource(event)).toBe(true);
    const presentation = buildCircePresentation(event, thread, "Circe");
    expect(presentation).toMatchObject({
      kind: "completed",
      projectId,
      threadId,
      origin: { originNodeId, originInteractionId: "interaction-presentation" },
    });
    expect(presentation).not.toBeNull();
    if (presentation === null) return;
    expect(isPresentationForOrigin(presentation, "interaction-presentation", originNodeId)).toBe(
      true,
    );
    expect(isPresentationForOrigin(presentation, "other-interaction", originNodeId)).toBe(false);
    expect(isPresentationForOrigin(presentation, "interaction-presentation", "other-node")).toBe(
      false,
    );
  });

  it.each(["checkpoint.capture.failed", "checkpoint.revert.failed"])(
    "skips %s before reading thread history",
    (kind) => {
      const event = activityEvent(kind, { message: "Optional checkpoint failed." });
      expect(buildCircePresentation(event, thread)).toBeNull();
      expect(isCircePresentationSource(event)).toBe(false);
    },
  );

  it("skips interrupted results before reading thread history", () => {
    const event = activityEvent("provider.turn.result-finalized", {
      turnId,
      assistantMessageId: null,
      state: "interrupted",
    });
    expect(buildCircePresentation(event, thread)).toBeNull();
    expect(isCircePresentationSource(event)).toBe(false);
  });

  it("projects blockers live but never presents an ordinary T3 thread", () => {
    const inputEvent = activityEvent("user-input.requested", {
      questions: [{ question: "Which database?", options: [{ label: "SQLite" }] }],
    });
    expect(buildCircePresentation(inputEvent, thread)).toMatchObject({
      kind: "waiting-for-input",
    });

    const ordinaryThread = { ...thread, activities: [] };
    const failureEvent = activityEvent("runtime.error", { message: "The node disconnected." });
    expect(buildCircePresentation(failureEvent, ordinaryThread)).toBeNull();
  });

  it("does not speak the session mirror after presenting a runtime error", () => {
    const runtimeEvent = activityEvent("runtime.error", { message: "The node disconnected." });
    const sessionEvent: Extract<OrchestrationEvent, { type: "thread.session-set" }> = {
      aggregateKind: "thread",
      aggregateId: threadId,
      sequence: 3,
      eventId: EventId.make("event-session-error"),
      occurredAt: now,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.session-set",
      payload: {
        threadId,
        session: {
          threadId,
          status: "error",
          providerName: "Codex",
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          lastError: "The node disconnected.",
          updatedAt: now,
        },
      },
    };
    expect(buildCircePresentation(runtimeEvent, thread)).toMatchObject({ kind: "failed" });
    expect(
      buildCircePresentation(sessionEvent, {
        ...thread,
        activities: [...thread.activities, runtimeEvent.payload.activity],
      }),
    ).toBeNull();
    expect(buildCircePresentation(sessionEvent, thread)).toMatchObject({ kind: "failed" });
  });

  it("still presents a session failure that differs from the recorded runtime error", () => {
    // The recorded error carries no message, so it cannot be the mirror of
    // this failure; silencing it would hide a real failure.
    const runtimeEvent = activityEvent("runtime.error", {});
    const sessionEvent: Extract<OrchestrationEvent, { type: "thread.session-set" }> = {
      aggregateKind: "thread",
      aggregateId: threadId,
      sequence: 3,
      eventId: EventId.make("event-session-error"),
      occurredAt: now,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.session-set",
      payload: {
        threadId,
        session: {
          threadId,
          status: "error",
          providerName: "Codex",
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          lastError: "The provider rejected the request.",
          updatedAt: now,
        },
      },
    };
    expect(
      buildCircePresentation(sessionEvent, {
        ...thread,
        activities: [...thread.activities, runtimeEvent.payload.activity],
      }),
    ).toMatchObject({ kind: "failed" });
  });
});
