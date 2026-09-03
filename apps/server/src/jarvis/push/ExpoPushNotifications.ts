import {
  EnvironmentId,
  JarvisPushNotificationData,
  JarvisPushNotificationKind,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationReactorExtension } from "../../orchestration/Services/OrchestrationReactorExtension.ts";
import { JarvisPushRegistrationRepository } from "../../persistence/Services/JarvisPushRegistrations.ts";
import { AuthSessionRepository } from "../../persistence/AuthSessions.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { forkParked } from "../../serverActivation.ts";

export const EXPO_PUSH_SEND_URL = "https://exp.host/--/api/v2/push/send";

export interface ExpoPushMessage {
  readonly to: string;
  readonly title: string;
  readonly body: string;
  readonly data: JarvisPushNotificationData;
  readonly channelId: "jarvis-tasks";
  readonly sound: "default";
  readonly priority: "high";
  readonly ttl: number;
}

export interface ExpoPushSender {
  readonly send: (message: ExpoPushMessage) => Effect.Effect<void, ExpoPushSendError>;
}

export class ExpoPushSendError extends Data.TaggedError("ExpoPushSendError")<{
  readonly cause: unknown;
  readonly retryable: boolean;
}> {}

export function isRetryableExpoPushStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export function expoPushTicketError(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("data" in body)) {
    return "Expo Push returned an invalid ticket.";
  }
  const data = body.data;
  if (typeof data !== "object" || data === null || !("status" in data)) {
    return "Expo Push returned an invalid ticket.";
  }
  if (data.status === "ok") return null;
  if ("message" in data && typeof data.message === "string") return data.message;
  return "Expo Push rejected the notification.";
}

function notificationKindForEvent(event: OrchestrationEvent): JarvisPushNotificationKind | null {
  if (event.type === "thread.activity-appended") {
    const { kind } = event.payload.activity;
    if (kind === "approval.requested") return "approval-required";
    if (kind === "user-input.requested") return "needs-input";
    if (kind === "provider.turn.result-finalized") {
      const payload = event.payload.activity.payload;
      const state =
        typeof payload === "object" && payload !== null && "state" in payload
          ? payload.state
          : undefined;
      if (state === "completed") return "completed";
      if (state === "failed") return "failed";
    }
    if ((kind === "runtime.error" || kind.endsWith(".failed")) && !kind.startsWith("checkpoint.")) {
      return "failed";
    }
  }
  return null;
}

export function pushMessageForEvent(
  event: OrchestrationEvent,
  nodeId: EnvironmentId,
): ExpoPushMessage | null {
  const notification = notificationKindForEvent(event);
  if (notification === null || event.type !== "thread.activity-appended") return null;
  const data = JarvisPushNotificationData.make({
    environmentId: nodeId,
    threadId: event.payload.threadId,
    kind: notification,
    notificationId: event.eventId,
  });
  const title =
    notification === "approval-required"
      ? "Approval required"
      : notification === "needs-input"
        ? "Input needed"
        : notification === "completed"
          ? "Task completed"
          : "Task failed";
  const body =
    notification === "approval-required"
      ? "A task is waiting for your approval."
      : notification === "needs-input"
        ? "A task needs your input."
        : notification === "completed"
          ? "A task completed."
          : "A task failed.";
  return {
    to: "",
    title,
    body,
    data,
    channelId: "jarvis-tasks",
    sound: "default",
    priority: "high",
    ttl: 60 * 60,
  };
}

const makeLiveExpoPushSender = (httpClient: HttpClient.HttpClient): ExpoPushSender => ({
  send: (message) =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(EXPO_PUSH_SEND_URL).pipe(
        HttpClientRequest.bodyJson(message),
        Effect.flatMap(httpClient.execute),
        Effect.mapError((cause) => new ExpoPushSendError({ cause, retryable: true })),
      );
      if (response.status < 200 || response.status >= 300) {
        return yield* new ExpoPushSendError({
          cause: `Expo Push returned HTTP ${response.status}.`,
          retryable: isRetryableExpoPushStatus(response.status),
        });
      }
      const ticket = yield* response.json.pipe(
        Effect.mapError((cause) => new ExpoPushSendError({ cause, retryable: true })),
      );
      const ticketError = expoPushTicketError(ticket);
      if (ticketError !== null) {
        return yield* new ExpoPushSendError({ cause: ticketError, retryable: false });
      }
    }).pipe(
      Effect.retry({
        times: 2,
        while: (error) => error.retryable,
        schedule: Schedule.exponential("200 millis"),
      }),
    ),
});

export const makeExpoPushReactorExtension = (sender: ExpoPushSender) =>
  Layer.effect(
    OrchestrationReactorExtension,
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const registrations = yield* JarvisPushRegistrationRepository;
      const sessions = yield* AuthSessionRepository;
      const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
      const nodeId = yield* serverEnvironment.getEnvironmentId;
      const start = Effect.fn("ExpoPushNotifications.start")(function* () {
        yield* forkParked(
          Stream.runForEach(engine.streamDomainEvents, (event) => {
            const preview = pushMessageForEvent(event, nodeId);
            if (preview === null || event.type !== "thread.activity-appended") return Effect.void;
            const threadId = event.payload.threadId;
            return Effect.gen(function* () {
              const now = DateTime.formatIso(yield* DateTime.now);
              const rows = yield* registrations.listByNode({ nodeId });
              const activeRows = yield* Effect.forEach(rows, (registration) =>
                sessions.getById({ sessionId: registration.sessionId }).pipe(
                  Effect.map((session) =>
                    Option.isSome(session) &&
                    session.value.revokedAt === null &&
                    DateTime.formatIso(session.value.expiresAt) > now &&
                    registration.expiresAt > now
                      ? Option.some(registration)
                      : Option.none(),
                  ),
                  Effect.orElseSucceed(() => Option.none()),
                ),
              );
              const activeRegistrations = activeRows.flatMap((registration) =>
                Option.isSome(registration) ? [registration.value] : [],
              );
              yield* Effect.forEach(activeRegistrations, (registration) =>
                sender.send({ ...preview, to: registration.token }).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Expo Push notification failed", {
                      threadId,
                      kind: preview.data.kind,
                      cause,
                    }),
                  ),
                ),
              );
            }).pipe(
              // One bad event (or one transient DB failure) must not stop the
              // subscriber: runForEach would terminate the whole stream.
              Effect.catchCause((cause) =>
                Effect.logWarning("Expo Push notification skipped an event", {
                  threadId,
                  kind: preview.data.kind,
                  cause: Cause.pretty(cause),
                }),
              ),
            );
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Expo Push event subscriber stopped", {
                cause: Cause.pretty(cause),
              }),
            ),
          ),
        );
      });
      return { start };
    }),
  );

export const ExpoPushNotificationsLive = Layer.unwrap(
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    return makeExpoPushReactorExtension(makeLiveExpoPushSender(httpClient));
  }),
);
