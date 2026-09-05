import { EnvironmentId, OrchestrationEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "@effect/vitest";

import {
  expoPushTicketError,
  isRetryableExpoPushStatus,
  notificationKindForEvent,
  pushMessageForEvent,
  withPushEventResubscribe,
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

  it("names the thread and project only with an explicit preview opt-in", () => {
    expect(
      pushMessageForEvent(activityEvent("approval.requested", {}), nodeId, {
        threadTitle: "Review Rivvl Authentication",
        projectTitle: "Rivvl",
        descriptivePreview: true,
      }),
    ).toMatchObject({
      title: "Review Rivvl Authentication",
      body: "A task is waiting for your approval in Rivvl.",
    });
    expect(
      pushMessageForEvent(
        activityEvent("provider.turn.result-finalized", { state: "completed" }),
        nodeId,
        {
          threadTitle: "Review Rivvl Authentication",
          projectTitle: "Rivvl",
          descriptivePreview: true,
        },
      ),
    ).toMatchObject({
      title: "Review Rivvl Authentication",
      body: "A task completed in Rivvl.",
    });
  });

  it("keeps titles out of third-party payloads by default", () => {
    expect(
      pushMessageForEvent(activityEvent("approval.requested", {}), nodeId, {
        threadTitle: "Review Rivvl Authentication",
        projectTitle: "Rivvl",
      }),
    ).toMatchObject({
      title: "Approval required",
      body: "A task is waiting for your approval.",
    });
  });

  it("bounds preview titles to one redacted line", () => {
    expect(
      pushMessageForEvent(activityEvent("approval.requested", {}), nodeId, {
        threadTitle: `Review\nRivvl\tAuthentication ${"x".repeat(200)}`,
        projectTitle: "Rivvl\nCustomer\tAcme Corp",
        descriptivePreview: true,
      }),
    ).toMatchObject({
      title: `Review Rivvl Authentication ${"x".repeat(52)}`,
      body: "A task is waiting for your approval in Rivvl Customer Acme Corp.",
    });
  });

  it("classifies push-worthiness before any projection read", () => {
    expect(notificationKindForEvent(activityEvent("approval.requested", {}))).toBe(
      "approval-required",
    );
    expect(notificationKindForEvent(activityEvent("user-input.requested", {}))).toBe("needs-input");
    expect(
      notificationKindForEvent(
        activityEvent("provider.turn.result-finalized", { state: "completed" }),
      ),
    ).toBe("completed");
    expect(notificationKindForEvent(activityEvent("checkpoint.capture.failed", {}))).toBe(null);
    expect(
      notificationKindForEvent(
        activityEvent("provider.turn.result-finalized", { state: "interrupted" }),
      ),
    ).toBe(null);
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

  it.effect("resubscribes a dying event stream instead of going silent", () =>
    Effect.gen(function* () {
      let subscriptions = 0;
      const processed: Array<string> = [];
      // Production failure mode: the subscription is Stream.runForEach over
      // Stream<OrchestrationEvent, never>, so death arrives as a defect with
      // no typed failure channel — never as Effect.fail.
      const failure = yield* withPushEventResubscribe<void, never, never>(
        Effect.gen(function* () {
          subscriptions += 1;
          if (subscriptions < 3) {
            yield* Stream.runForEach(Stream.die(new Error("event bus died")), () => Effect.void);
          } else {
            yield* Stream.runForEach(Stream.make("live-event"), (event) =>
              Effect.sync(() => {
                processed.push(event);
              }),
            );
          }
        }),
        Schedule.recurs(2),
      ).pipe(Effect.flip);
      // Attempts 1-2 die and resubscribe; attempt 3 processes its event, then
      // its normal completion also resubscribes until the schedule exhausts.
      expect(subscriptions).toBe(3);
      expect(processed).toEqual(["live-event"]);
      expect(failure._tag).toBe("PushSubscriptionStopped");
    }),
  );

  it.effect("lets shutdown interruption exit instead of resubscribing", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        withPushEventResubscribe<never, never, never>(Effect.interrupt, Schedule.recurs(5)),
      );
      expect(Exit.hasInterrupts(exit)).toBe(true);
    }),
  );
});
