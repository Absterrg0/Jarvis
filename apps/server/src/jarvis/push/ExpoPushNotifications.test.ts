import { EnvironmentId, OrchestrationEvent } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  expoPushTicketError,
  isRetryableExpoPushStatus,
  pushMessageForEvent,
} from "./ExpoPushNotifications.ts";

const decodeEvent = Schema.decodeUnknownSync(OrchestrationEvent);

function activityEvent(kind: string, payload: unknown) {
  return decodeEvent({
    sequence: 1,
    eventId: "event-1",
    aggregateKind: "thread",
    aggregateId: "thread-1",
    occurredAt: "2026-01-01T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.activity-appended",
    payload: {
      threadId: "thread-1",
      activity: {
        id: "activity-1",
        tone: kind.endsWith("failed") ? "error" : "info",
        kind,
        summary: "A task needs your attention.",
        payload,
        turnId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    },
  });
}

describe("Expo push notification event mapping", () => {
  const nodeId = EnvironmentId.make("node-1");

  it("keeps notification identity qualified by node and thread", () => {
    expect(pushMessageForEvent(activityEvent("approval.requested", {}), nodeId)).toMatchObject({
      title: "Approval required",
      channelId: "jarvis-tasks",
      priority: "high",
      ttl: 3_600,
      data: {
        environmentId: "node-1",
        threadId: "thread-1",
        kind: "approval-required",
      },
    });
  });

  it("maps provider completion and failure to the corresponding notification", () => {
    expect(
      pushMessageForEvent(
        activityEvent("provider.turn.result-finalized", { state: "completed" }),
        nodeId,
      ),
    ).toMatchObject({ title: "Task completed", data: { kind: "completed" } });
    expect(
      pushMessageForEvent(
        activityEvent("provider.turn.result-finalized", { state: "failed" }),
        nodeId,
      ),
    ).toMatchObject({ title: "Task failed", data: { kind: "failed" } });
  });

  it("names the thread and project instead of sending generic copy", () => {
    expect(
      pushMessageForEvent(activityEvent("approval.requested", {}), nodeId, {
        threadTitle: "Review Rivvl Authentication",
        projectTitle: "Rivvl",
      }),
    ).toMatchObject({
      title: "Review Rivvl Authentication",
      body: "A task is waiting for your approval in Rivvl.",
    });
    expect(
      pushMessageForEvent(
        activityEvent("provider.turn.result-finalized", { state: "completed" }),
        nodeId,
        { threadTitle: "Review Rivvl Authentication", projectTitle: "Rivvl" },
      ),
    ).toMatchObject({
      title: "Review Rivvl Authentication",
      body: "A task completed in Rivvl.",
    });
  });

  it("does not turn bookkeeping failures or unrelated events into push state", () => {
    expect(pushMessageForEvent(activityEvent("checkpoint.capture.failed", {}), nodeId)).toBe(null);
    expect(
      pushMessageForEvent(
        activityEvent("provider.turn.result-finalized", { state: "interrupted" }),
        nodeId,
      ),
    ).toBe(null);
  });

  it("retries only transient transport statuses", () => {
    expect(isRetryableExpoPushStatus(429)).toBe(true);
    expect(isRetryableExpoPushStatus(503)).toBe(true);
    expect(isRetryableExpoPushStatus(400)).toBe(false);
  });

  it("accepts successful Expo tickets and surfaces rejected tickets", () => {
    expect(expoPushTicketError({ data: { status: "ok", id: "ticket-1" } })).toBe(null);
    expect(expoPushTicketError({ data: { status: "error", message: "DeviceNotRegistered" } })).toBe(
      "DeviceNotRegistered",
    );
    expect(expoPushTicketError({ nope: true })).toBe("Expo Push returned an invalid ticket.");
  });
});
