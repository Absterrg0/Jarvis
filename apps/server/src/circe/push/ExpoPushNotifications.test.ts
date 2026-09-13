import {
  AuthSessionId,
  EnvironmentId,
  CircePushNotificationData,
  OrchestrationEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { describe, expect, it } from "@effect/vitest";

import * as Option from "effect/Option";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as AuthSessions from "../../persistence/AuthSessions.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { CircePushRegistrationRepository } from "../../persistence/Services/CircePushRegistrations.ts";
import { CircePushRegistrationsLive } from "../../persistence/Layers/CircePushRegistrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ExpoPushSendError,
  expoPushTicketFailure,
  isActivePushRegistration,
  isDeviceNotRegisteredExpoError,
  isRetryableExpoPushStatus,
  makeCircePushNotifications,
  makeLiveExpoPushSender,
  notificationKindForEvent,
  pushMessageForEvent,
  withPushEventResubscribe,
  type ExpoPushMessage,
  type ExpoPushSender,
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

const finalized = (state: "completed" | "failed" | "interrupted") => ({
  turnId: "turn-1",
  assistantMessageId: null,
  state,
});

describe("Expo push notification event mapping", () => {
  const nodeId = EnvironmentId.make("node-1");

  it("keeps notification identity qualified by node and thread", () => {
    expect(pushMessageForEvent(activityEvent("approval.requested", {}), nodeId)).toMatchObject({
      title: "Approval required",
      channelId: "circe-tasks",
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
        activityEvent("provider.turn.result-finalized", finalized("completed")),
        nodeId,
      ),
    ).toMatchObject({ title: "Task completed", data: { kind: "completed" } });
    expect(
      pushMessageForEvent(
        activityEvent("provider.turn.result-finalized", finalized("failed")),
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
        activityEvent("provider.turn.result-finalized", finalized("completed")),
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
        activityEvent("provider.turn.result-finalized", finalized("completed")),
      ),
    ).toBe("completed");
    expect(notificationKindForEvent(activityEvent("checkpoint.capture.failed", {}))).toBe(null);
    expect(
      notificationKindForEvent(
        activityEvent("provider.turn.result-finalized", finalized("interrupted")),
      ),
    ).toBe(null);
    expect(
      notificationKindForEvent(
        activityEvent("provider.turn.result-finalized", { state: "completed" }),
      ),
    ).toBe(null);
  });

  it("keeps non-closed response errors actionable and marks closed ones failed", () => {
    expect(
      notificationKindForEvent(
        activityEvent("provider.approval.respond.failed", { failureReason: "provider-error" }),
      ),
    ).toBe("approval-required");
    expect(
      notificationKindForEvent(
        activityEvent("provider.user-input.respond.failed", {
          failureReason: "session-unavailable",
        }),
      ),
    ).toBe("needs-input");
    expect(
      notificationKindForEvent(
        activityEvent("provider.approval.respond.failed", { failureReason: "request-closed" }),
      ),
    ).toBe("failed");
    expect(
      pushMessageForEvent(
        activityEvent("provider.approval.respond.failed", { failureReason: "provider-error" }),
        nodeId,
      ),
    ).toMatchObject({ data: { kind: "approval-required" } });
  });

  it("describes a closed request without claiming the task itself failed", () => {
    const message = pushMessageForEvent(
      activityEvent("provider.approval.respond.failed", { failureReason: "request-closed" }),
      nodeId,
    );
    expect(message?.data.kind).toBe("failed");
    expect(`${message?.title} ${message?.body}`).not.toMatch(/task failed/i);
    expect(`${message?.title} ${message?.body}`).toMatch(/request|response/i);
  });

  it("does not turn bookkeeping failures or unrelated events into push state", () => {
    expect(pushMessageForEvent(activityEvent("checkpoint.capture.failed", {}), nodeId)).toBe(null);
    expect(
      pushMessageForEvent(
        activityEvent("provider.turn.result-finalized", finalized("interrupted")),
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
    expect(expoPushTicketFailure({ data: { status: "ok", id: "ticket-1" } })).toBe(null);
    expect(
      expoPushTicketFailure({ data: { status: "error", message: "DeviceNotRegistered" } })?.message,
    ).toBe("DeviceNotRegistered");
    expect(expoPushTicketFailure({ nope: true })?.message).toBe(
      "Expo Push returned an invalid ticket.",
    );
  });

  it("preserves the structured Expo details.error code", () => {
    expect(expoPushTicketFailure({ data: { status: "ok", id: "ticket-1" } })).toBeNull();
    expect(
      expoPushTicketFailure({
        data: {
          status: "error",
          message: "DeviceNotRegistered",
          details: { error: "DeviceNotRegistered" },
        },
      }),
    ).toMatchObject({ message: "DeviceNotRegistered", code: "DeviceNotRegistered" });
    expect(
      expoPushTicketFailure({
        data: {
          status: "error",
          message: "Invalid credentials",
          details: { error: "InvalidCredentials" },
        },
      }),
    ).toMatchObject({ code: "InvalidCredentials" });
    expect(expoPushTicketFailure({ nope: true })).toMatchObject({ code: null });
    const sendError = new ExpoPushSendError({
      cause: "DeviceNotRegistered",
      retryable: false,
      expoCode: "DeviceNotRegistered",
    });
    expect(isDeviceNotRegisteredExpoError(sendError)).toBe(true);
    expect(
      isDeviceNotRegisteredExpoError(
        new ExpoPushSendError({
          cause: "InvalidCredentials",
          retryable: false,
          expoCode: "InvalidCredentials",
        }),
      ),
    ).toBe(false);
    expect(
      isDeviceNotRegisteredExpoError(
        new ExpoPushSendError({ cause: "DeviceNotRegistered", retryable: false }),
      ),
    ).toBe(false);
  });

  it("filters expired and revoked registrations before sending", () => {
    const now = "2026-09-15T00:00:00.000Z";
    const live = Option.some({ revokedAt: null, expiresAt: "2026-10-01T00:00:00.000Z" });
    expect(
      isActivePushRegistration({
        session: live,
        registrationExpiresAt: "2026-10-01T00:00:00.000Z",
        now,
      }),
    ).toBe(true);
    expect(
      isActivePushRegistration({
        session: Option.none(),
        registrationExpiresAt: "2026-10-01T00:00:00.000Z",
        now,
      }),
    ).toBe(false);
    expect(
      isActivePushRegistration({
        session: Option.some({
          revokedAt: "2026-09-14T00:00:00.000Z",
          expiresAt: "2026-10-01T00:00:00.000Z",
        }),
        registrationExpiresAt: "2026-10-01T00:00:00.000Z",
        now,
      }),
    ).toBe(false);
    expect(
      isActivePushRegistration({
        session: Option.some({ revokedAt: null, expiresAt: "2026-09-14T00:00:00.000Z" }),
        registrationExpiresAt: "2026-10-01T00:00:00.000Z",
        now,
      }),
    ).toBe(false);
    expect(
      isActivePushRegistration({
        session: live,
        registrationExpiresAt: "2026-09-14T00:00:00.000Z",
        now,
      }),
    ).toBe(false);
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

describe("Expo push send boundary", () => {
  const boundaryNode = (name: string) => EnvironmentId.make(`node-boundary-${name}`);

  const boundaryLayer = it.layer(
    Layer.mergeAll(
      SqlitePersistenceMemory,
      CircePushRegistrationsLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
      AuthSessions.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ),
  );

  const seedSession = (
    sessions: AuthSessions.AuthSessionRepository["Service"],
    sessionId: string,
    expiresAt: DateTime.Utc,
    revokedAt?: DateTime.Utc,
  ) =>
    Effect.gen(function* () {
      const issuedAt = yield* DateTime.now;
      yield* sessions.create({
        sessionId: AuthSessionId.make(sessionId),
        subject: "mobile",
        scopes: ["orchestration:read"],
        method: "bearer-access-token",
        client: {
          label: null,
          ipAddress: null,
          userAgent: null,
          deviceType: "mobile",
          os: null,
          browser: null,
        },
        issuedAt,
        expiresAt,
      });
      if (revokedAt !== undefined) {
        yield* sessions.revoke({ sessionId: AuthSessionId.make(sessionId), revokedAt });
      }
    });

  const seedRegistration = (
    registrations: CircePushRegistrationRepository["Service"],
    nodeId: EnvironmentId,
    input: {
      readonly token: string;
      readonly deviceId: string;
      readonly sessionId: string;
      readonly updatedAt: string;
      readonly expiresAt: string;
    },
  ) =>
    registrations.register({
      token: input.token,
      deviceId: input.deviceId,
      sessionId: AuthSessionId.make(input.sessionId),
      nodeId,
      updatedAt: input.updatedAt,
      expiresAt: input.expiresAt,
    });

  type SendBehavior =
    | { readonly _tag: "succeed" }
    | { readonly _tag: "device-not-registered" }
    | { readonly _tag: "invalid-credentials" }
    | { readonly _tag: "transient" };

  const runOneBoundaryEvent = (
    registrations: CircePushRegistrationRepository["Service"],
    nodeId: EnvironmentId,
    behaviors: Record<string, SendBehavior>,
    options: {
      readonly trailingToken: string;
      readonly renew?: {
        readonly token: string;
        readonly deviceId: string;
        readonly sessionId: string;
        readonly updatedAt: string;
        readonly expiresAt: string;
      };
    },
  ) =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<OrchestrationEvent>();
      const recorded = yield* Ref.make<ReadonlyArray<ExpoPushMessage>>([]);
      const done = yield* Deferred.make<void>();
      const sender: ExpoPushSender = {
        send: (message) =>
          Effect.gen(function* () {
            yield* Ref.update(recorded, (sent) => [...sent, message]);
            if (options.renew !== undefined && message.to === options.renew.token) {
              yield* registrations
                .register({
                  token: options.renew.token,
                  deviceId: options.renew.deviceId,
                  sessionId: AuthSessionId.make(options.renew.sessionId),
                  nodeId,
                  updatedAt: options.renew.updatedAt,
                  expiresAt: options.renew.expiresAt,
                })
                .pipe(
                  Effect.mapError((cause) => new ExpoPushSendError({ cause, retryable: false })),
                );
            }
            if (message.to === options.trailingToken) {
              yield* Deferred.succeed(done, undefined);
            }
            const behavior = behaviors[message.to] ?? { _tag: "succeed" as const };
            switch (behavior._tag) {
              case "succeed":
                return;
              case "device-not-registered":
                return yield* new ExpoPushSendError({
                  cause: `Expo rejected ${message.to}.`,
                  retryable: false,
                  expoCode: "DeviceNotRegistered",
                });
              case "invalid-credentials":
                return yield* new ExpoPushSendError({
                  cause: "Expo rejected the credentials.",
                  retryable: false,
                  expoCode: "InvalidCredentials",
                });
              case "transient":
                return yield* new ExpoPushSendError({
                  cause: "Expo transport failed.",
                  retryable: true,
                });
            }
          }).pipe(Effect.asVoid),
      };
      const harness = Layer.mergeAll(
        Layer.succeed(OrchestrationEngineService, {
          readEvents: () => Stream.empty,
          readThreadEvents: () => Stream.empty,
          getThreadReplayStats: () =>
            Effect.succeed({ eventCount: 0, payloadBytes: 0, hasCreateEvent: false }),
          dispatch: () => Effect.succeed({ sequence: 1 }),
          streamDomainEvents: Stream.fromQueue(events),
          subscribeDomainEvents: Effect.never,
          latestSequence: Effect.succeed(0),
        } satisfies OrchestrationEngineShape),
        Layer.succeed(ProjectionSnapshotQuery, {
          getThreadShellById: () => Effect.die("projections unused without descriptivePreview"),
          getProjectShellById: () => Effect.die("projections unused without descriptivePreview"),
        } as unknown as ProjectionSnapshotQueryShape),
        Layer.succeed(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed(nodeId),
          getDescriptor: Effect.die("unused"),
          setLabel: () => Effect.die("unused"),
        }),
      );
      const program = Effect.scoped(
        Effect.gen(function* () {
          const push = yield* makeCircePushNotifications(sender);
          yield* push.start();
          yield* Queue.offer(events, activityEvent("approval.requested", {}));
          yield* Deferred.await(done);
          return {
            sent: yield* Ref.get(recorded),
            rows: yield* registrations.listByNode({ nodeId }),
          };
        }),
      );
      return yield* Effect.provide(program, harness);
    });

  boundaryLayer("send boundary", (it) => {
    it.effect("removes only the DeviceNotRegistered row; expired and revoked rows never send", () =>
      Effect.gen(function* () {
        const sessions = yield* AuthSessions.AuthSessionRepository;
        const registrations = yield* CircePushRegistrationRepository;
        const nodeId = boundaryNode("a");
        const now = yield* DateTime.now;
        const live = DateTime.add(now, { days: 30 });
        const stale = DateTime.add(now, { days: -30 });
        const liveIso = DateTime.formatIso(live);
        const staleIso = DateTime.formatIso(stale);
        yield* seedSession(sessions, "s-dead", live);
        yield* seedSession(sessions, "s-ok", live);
        yield* seedSession(sessions, "s-bad", live);
        yield* seedSession(sessions, "s-flaky", live);
        yield* seedSession(sessions, "s-revoked", live, now);
        yield* seedSession(sessions, "s-expired", stale);
        const at = DateTime.formatIso(now);
        yield* seedRegistration(registrations, nodeId, {
          token: "ExponentPushToken[dead]",
          deviceId: "d-dead",
          sessionId: "s-dead",
          updatedAt: at,
          expiresAt: liveIso,
        });
        yield* seedRegistration(registrations, nodeId, {
          token: "ExponentPushToken[bad]",
          deviceId: "d-bad",
          sessionId: "s-bad",
          updatedAt: at,
          expiresAt: liveIso,
        });
        yield* seedRegistration(registrations, nodeId, {
          token: "ExponentPushToken[flaky]",
          deviceId: "d-flaky",
          sessionId: "s-flaky",
          updatedAt: at,
          expiresAt: liveIso,
        });
        yield* seedRegistration(registrations, nodeId, {
          token: "ExponentPushToken[revoked]",
          deviceId: "d-revoked",
          sessionId: "s-revoked",
          updatedAt: at,
          expiresAt: liveIso,
        });
        yield* seedRegistration(registrations, nodeId, {
          token: "ExponentPushToken[old]",
          deviceId: "d-old",
          sessionId: "s-ok",
          updatedAt: at,
          expiresAt: staleIso,
        });
        yield* seedRegistration(registrations, nodeId, {
          token: "ExponentPushToken[sess-old]",
          deviceId: "d-sess-old",
          sessionId: "s-expired",
          updatedAt: at,
          expiresAt: liveIso,
        });
        yield* seedRegistration(registrations, nodeId, {
          token: "ExponentPushToken[ok]",
          deviceId: "d-ok",
          sessionId: "s-ok",
          updatedAt: at,
          expiresAt: liveIso,
        });

        const { sent, rows } = yield* runOneBoundaryEvent(
          registrations,
          nodeId,
          {
            "ExponentPushToken[dead]": { _tag: "device-not-registered" },
            "ExponentPushToken[bad]": { _tag: "invalid-credentials" },
            "ExponentPushToken[flaky]": { _tag: "transient" },
          },
          { trailingToken: "ExponentPushToken[ok]" },
        );

        expect(sent.map((message) => message.to)).toEqual([
          "ExponentPushToken[dead]",
          "ExponentPushToken[bad]",
          "ExponentPushToken[flaky]",
          "ExponentPushToken[ok]",
        ]);
        expect(sent.at(-1)).toMatchObject({
          title: "Approval required",
          data: { kind: "approval-required" },
        });
        expect(rows.map((row) => row.token).sort()).toEqual(
          [
            "ExponentPushToken[bad]",
            "ExponentPushToken[flaky]",
            "ExponentPushToken[ok]",
            "ExponentPushToken[revoked]",
            "ExponentPushToken[old]",
            "ExponentPushToken[sess-old]",
          ].sort(),
        );
      }),
    );

    it.effect("an in-flight renewal survives a stale DeviceNotRegistered failure", () =>
      Effect.gen(function* () {
        const sessions = yield* AuthSessions.AuthSessionRepository;
        const registrations = yield* CircePushRegistrationRepository;
        const nodeId = boundaryNode("b");
        const now = yield* DateTime.now;
        const live = DateTime.add(now, { days: 30 });
        const liveIso = DateTime.formatIso(live);
        const renewedAt = DateTime.formatIso(DateTime.add(now, { hours: 1 }));
        const renewedExpiresAt = DateTime.formatIso(DateTime.add(now, { days: 31 }));
        yield* seedSession(sessions, "s-race", live);
        yield* seedSession(sessions, "s-tail", live);
        yield* seedRegistration(registrations, nodeId, {
          token: "ExponentPushToken[race]",
          deviceId: "d-race",
          sessionId: "s-race",
          updatedAt: DateTime.formatIso(now),
          expiresAt: liveIso,
        });
        yield* seedRegistration(registrations, nodeId, {
          token: "ExponentPushToken[tail]",
          deviceId: "d-tail",
          sessionId: "s-tail",
          updatedAt: DateTime.formatIso(now),
          expiresAt: liveIso,
        });

        const { sent, rows } = yield* runOneBoundaryEvent(
          registrations,
          nodeId,
          { "ExponentPushToken[race]": { _tag: "device-not-registered" } },
          {
            trailingToken: "ExponentPushToken[tail]",
            renew: {
              token: "ExponentPushToken[race]",
              deviceId: "d-race",
              sessionId: "s-race",
              updatedAt: renewedAt,
              expiresAt: renewedExpiresAt,
            },
          },
        );

        expect(sent.map((message) => message.to)).toEqual([
          "ExponentPushToken[race]",
          "ExponentPushToken[tail]",
        ]);
        const renewed = rows.find((row) => row.token === "ExponentPushToken[race]");
        expect(renewed?.updatedAt).toBe(renewedAt);
        expect(rows.some((row) => row.token === "ExponentPushToken[tail]")).toBe(true);
      }),
    );
  });
});

describe("live Expo push sender", () => {
  const message: ExpoPushMessage = {
    to: "ExponentPushToken[one]",
    title: "Approval required",
    body: "A task is waiting for your approval.",
    data: CircePushNotificationData.make({
      environmentId: EnvironmentId.make("node-1"),
      threadId: ThreadId.make("thread-1"),
      kind: "approval-required",
      notificationId: "event-1",
    }),
    channelId: "circe-tasks",
    sound: "default",
    priority: "high",
    ttl: 3_600,
  };

  const stubHttp = (status: number, json: unknown, calls: Ref.Ref<number>) =>
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Ref.update(calls, (count) => count + 1).pipe(
          Effect.as(
            HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify(json), {
                status,
                headers: { "content-type": "application/json" },
              }),
            ),
          ),
        ),
      ),
    );

  const sendOnce = (status: number, json: unknown) =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const program = Effect.gen(function* () {
        const sender = makeLiveExpoPushSender(yield* HttpClient.HttpClient);
        return yield* Effect.flip(sender.send(message));
      });
      const error = yield* Effect.provide(program, stubHttp(status, json, calls));
      return { error, calls: yield* Ref.get(calls) };
    });

  it.effect("maps an HttpClient DeviceNotRegistered ticket to a non-retryable coded error", () =>
    Effect.gen(function* () {
      const { error, calls } = yield* sendOnce(200, {
        data: {
          status: "error",
          message: "DeviceNotRegistered",
          details: { error: "DeviceNotRegistered" },
        },
      });
      expect(error._tag).toBe("ExpoPushSendError");
      expect(error).toMatchObject({ expoCode: "DeviceNotRegistered", retryable: false });
      expect(calls).toBe(1);
    }),
  );

  it.effect("preserves other ticket codes without marking them unregistered", () =>
    Effect.gen(function* () {
      const { error, calls } = yield* sendOnce(200, {
        data: {
          status: "error",
          message: "Invalid credentials",
          details: { error: "InvalidCredentials" },
        },
      });
      expect(error._tag).toBe("ExpoPushSendError");
      expect(error).toMatchObject({ expoCode: "InvalidCredentials", retryable: false });
      expect(isDeviceNotRegisteredExpoError(error)).toBe(false);
      expect(calls).toBe(1);
    }),
  );

  it.live("keeps transient transport failures retryable and uncoded", () =>
    Effect.gen(function* () {
      const { error } = yield* sendOnce(503, { data: { status: "ok", id: "ticket-1" } });
      expect(error._tag).toBe("ExpoPushSendError");
      expect(error).toMatchObject({ retryable: true });
      expect(isDeviceNotRegisteredExpoError(error)).toBe(false);
      expect("expoCode" in error && error.expoCode).toBeFalsy();
    }),
  );

  it.effect("accepts a successful ticket without failing", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const program = Effect.gen(function* () {
        const sender = makeLiveExpoPushSender(yield* HttpClient.HttpClient);
        yield* sender.send(message);
      });
      yield* Effect.provide(
        program,
        stubHttp(200, { data: { status: "ok", id: "ticket-1" } }, calls),
      );
      expect(yield* Ref.get(calls)).toBe(1);
    }),
  );
});
