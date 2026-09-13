import {
  EnvironmentId,
  CircePushNotificationData,
  CircePushNotificationKind,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import {
  classifyActivityPresentationKind,
  isClosedResponseFailure,
} from "@circe/core/buildPresentation";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { CircePushNotifications } from "../Services/CircePushNotifications.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { CircePushRegistrationRepository } from "../../persistence/Services/CircePushRegistrations.ts";
import { AuthSessionRepository } from "../../persistence/AuthSessions.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { forkParked } from "../../serverActivation.ts";

export const EXPO_PUSH_SEND_URL = "https://exp.host/--/api/v2/push/send";

export interface ExpoPushMessage {
  readonly to: string;
  readonly title: string;
  readonly body: string;
  readonly data: CircePushNotificationData;
  readonly channelId: "circe-tasks";
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
  readonly expoCode?: string;
}> {}

export function isRetryableExpoPushStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export interface ExpoPushTicketFailure {
  readonly message: string;
  readonly code: string | null;
}

function ticketFailureForEntry(entry: unknown): ExpoPushTicketFailure | null {
  if (typeof entry !== "object" || entry === null || !("status" in entry)) {
    return { message: "Expo Push returned an invalid ticket.", code: null };
  }
  if (entry.status === "ok") return null;
  const message =
    "message" in entry && typeof entry.message === "string"
      ? entry.message
      : "Expo Push rejected the notification.";
  const details =
    "details" in entry && typeof entry.details === "object" && entry.details !== null
      ? (entry.details as Record<string, unknown>)
      : null;
  const code =
    details !== null && "error" in details && typeof details.error === "string"
      ? details.error
      : null;
  return { message, code };
}

export function expoPushTicketFailure(body: unknown): ExpoPushTicketFailure | null {
  if (typeof body !== "object" || body === null || !("data" in body)) {
    return { message: "Expo Push returned an invalid ticket.", code: null };
  }
  const data = (body as { readonly data: unknown }).data;
  if (Array.isArray(data)) {
    for (const entry of data) {
      const failure = ticketFailureForEntry(entry);
      if (failure !== null) return failure;
    }
    return data.length > 0
      ? null
      : { message: "Expo Push returned an invalid ticket.", code: null };
  }
  return ticketFailureForEntry(data);
}

/** Invalidate only on the structured DeviceNotRegistered code, never on text. */
export function isDeviceNotRegisteredExpoError(error: unknown): boolean {
  return error instanceof ExpoPushSendError && error.expoCode === "DeviceNotRegistered";
}

export function notificationKindForEvent(
  event: OrchestrationEvent,
): CircePushNotificationKind | null {
  if (event.type !== "thread.activity-appended") return null;
  const classified = classifyActivityPresentationKind(event.payload.activity);
  if (classified === null) return null;
  if (classified === "approval-needed") return "approval-required";
  if (classified === "waiting-for-input") return "needs-input";
  return classified;
}

const PUSH_THREAD_TITLE_LENGTH = 80;
const PUSH_PROJECT_TITLE_LENGTH = 40;

/** Collapse to one line and strip control characters before third-party send. */
function pushCopyLine(value: string, maximum: number): string {
  const singleLine = value.replace(/[\r\n\t]+/gu, " ");
  const printable = [...singleLine]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 32;
      return code >= 32 && code !== 127;
    })
    .join("");
  return printable.replace(/\s+/gu, " ").trim().slice(0, maximum);
}

export function pushMessageForEvent(
  event: OrchestrationEvent,
  nodeId: EnvironmentId,
  context: {
    readonly threadTitle?: string;
    readonly projectTitle?: string;
    /**
     * Thread/project titles leave the node for Expo and render on lock
     * screens. They stay out unless the user opts into descriptive previews.
     */
    readonly descriptivePreview?: boolean;
  } = {},
): ExpoPushMessage | null {
  const notification = notificationKindForEvent(event);
  if (notification === null || event.type !== "thread.activity-appended") return null;
  const data = CircePushNotificationData.make({
    environmentId: nodeId,
    threadId: event.payload.threadId,
    kind: notification,
    notificationId: event.eventId,
  });
  // A closed request is not a task execution failure. The wire kind stays
  // "failed" but the lock-screen copy must say the request closed.
  const closedRequest =
    notification === "failed" && isClosedResponseFailure(event.payload.activity);
  const kindTitle = closedRequest
    ? "Response not sent"
    : notification === "approval-required"
      ? "Approval required"
      : notification === "needs-input"
        ? "Input needed"
        : notification === "completed"
          ? "Task completed"
          : "Task failed";
  const kindBody = closedRequest
    ? "A request closed before your response arrived"
    : notification === "approval-required"
      ? "A task is waiting for your approval"
      : notification === "needs-input"
        ? "A task needs your input"
        : notification === "completed"
          ? "A task completed"
          : "A task failed";
  const subject =
    context.descriptivePreview === true && context.threadTitle !== undefined
      ? pushCopyLine(context.threadTitle, PUSH_THREAD_TITLE_LENGTH)
      : "";
  const where =
    context.descriptivePreview === true && context.projectTitle !== undefined
      ? pushCopyLine(context.projectTitle, PUSH_PROJECT_TITLE_LENGTH)
      : "";
  return {
    to: "",
    title: subject.length > 0 ? subject : kindTitle,
    body: `${kindBody}${where.length > 0 ? ` in ${where}` : ""}.`,
    data,
    channelId: "circe-tasks",
    sound: "default",
    priority: "high",
    ttl: 60 * 60,
  };
}

export const makeLiveExpoPushSender = (httpClient: HttpClient.HttpClient): ExpoPushSender => ({
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
      const ticketFailure = expoPushTicketFailure(ticket);
      if (ticketFailure !== null) {
        return yield* new ExpoPushSendError({
          cause: ticketFailure.message,
          retryable: false,
          ...(ticketFailure.code === null ? {} : { expoCode: ticketFailure.code }),
        });
      }
    }).pipe(
      Effect.retry({
        times: 2,
        while: (error) => error.retryable,
        schedule: Schedule.exponential("200 millis"),
      }),
    ),
});

/**
 * Circe-owned push startup. Provided in server composition next to the
 * controller and parked in serverRuntimeStartup alongside the follow-up
 * dispatcher; upstream orchestration owns no product hook for it.
 */
export const CircePushNotificationsLive = Layer.effect(
  CircePushNotifications,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const sender = makeLiveExpoPushSender(httpClient);
    return yield* makeCircePushNotifications(sender);
  }),
);

export const makeCircePushNotifications = (
  sender: ExpoPushSender,
  options: {
    /**
     * Descriptive thread/project copy leaves the node for Expo. Off by
     * default; wire a user preference here before enabling.
     */
    readonly descriptivePreview?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const projections = yield* ProjectionSnapshotQuery;
    const registrations = yield* CircePushRegistrationRepository;
    const sessions = yield* AuthSessionRepository;
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    const nodeId = yield* serverEnvironment.getEnvironmentId;
    const descriptivePreview = options.descriptivePreview === true;
    const start = Effect.fn("ExpoPushNotifications.start")(function* () {
      const subscribe = Stream.runForEach(engine.streamDomainEvents, (event) => {
        // Classify before any projection read: tool, progress,
        // checkpoint, and ordinary activity events return here with zero
        // database work instead of paying for a thread snapshot.
        if (notificationKindForEvent(event) === null) return Effect.void;
        if (event.type !== "thread.activity-appended") return Effect.void;
        const threadId = event.payload.threadId;
        return Effect.gen(function* () {
          // Generic copy needs no thread data at all. Descriptive
          // previews use narrow shell rows (title + project id), never
          // the full thread detail snapshot.
          const titles =
            descriptivePreview !== true
              ? {}
              : yield* projections.getThreadShellById(threadId).pipe(
                  Effect.flatMap((shell) =>
                    Option.isSome(shell)
                      ? projections.getProjectShellById(shell.value.projectId).pipe(
                          Effect.map((project) => ({
                            threadTitle: shell.value.title,
                            ...(Option.isSome(project)
                              ? { projectTitle: project.value.title }
                              : {}),
                          })),
                          Effect.orElseSucceed(() => ({
                            threadTitle: shell.value.title,
                          })),
                        )
                      : Effect.succeed({}),
                  ),
                  Effect.orElseSucceed(() => ({})),
                );
          const preview = pushMessageForEvent(event, nodeId, {
            ...titles,
            ...(descriptivePreview === true ? { descriptivePreview: true as const } : {}),
          });
          if (preview === null) return;
          const now = DateTime.formatIso(yield* DateTime.now);
          const rows = yield* registrations.listByNode({ nodeId });
          const activeRows = yield* Effect.forEach(rows, (registration) =>
            sessions.getById({ sessionId: registration.sessionId }).pipe(
              Effect.map((session) => {
                const view = Option.isSome(session)
                  ? Option.some({
                      revokedAt:
                        session.value.revokedAt === null
                          ? null
                          : DateTime.formatIso(session.value.revokedAt),
                      expiresAt: DateTime.formatIso(session.value.expiresAt),
                    })
                  : Option.none();
                return isActivePushRegistration({
                  session: view,
                  registrationExpiresAt: registration.expiresAt,
                  now,
                })
                  ? Option.some(registration)
                  : Option.none();
              }),
              Effect.orElseSucceed(() => Option.none()),
            ),
          );
          const activeRegistrations = activeRows.flatMap((registration) =>
            Option.isSome(registration) ? [registration.value] : [],
          );
          yield* Effect.forEach(activeRegistrations, (registration) =>
            sender.send({ ...preview, to: registration.token }).pipe(
              Effect.catch((error) =>
                Effect.gen(function* () {
                  // Ticket-only invalidation: Expo tickets confirm
                  // acceptance, not delivery. Remove only the structured
                  // DeviceNotRegistered version seen here; any same-token
                  // renewal guard skips the delete.
                  if (isDeviceNotRegisteredExpoError(error)) {
                    const invalidated = yield* registrations
                      .unregisterIfUnchanged({
                        token: registration.token,
                        deviceId: registration.deviceId,
                        sessionId: registration.sessionId,
                        updatedAt: registration.updatedAt,
                        expiresAt: registration.expiresAt,
                      })
                      .pipe(Effect.orElseSucceed(() => false));
                    yield* Effect.logWarning("Expo Push registration invalid", {
                      threadId,
                      kind: preview.data.kind,
                      invalidated,
                      cause: error,
                    });
                    return;
                  }
                  yield* Effect.logWarning("Expo Push notification failed", {
                    threadId,
                    kind: preview.data.kind,
                    cause: error,
                  });
                }),
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning("Expo Push notification failed", {
                  threadId,
                  kind: preview.data.kind,
                  cause: Cause.pretty(cause),
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
              cause: Cause.pretty(cause),
            }),
          ),
        );
      });
      yield* forkParked(withPushEventResubscribe(subscribe));
    });
    return { start };
  });

/**
 * Pure send-time gate. Expired registrations, missing sessions, revoked
 * sessions, and expired sessions never send. Rows are filtered here, not
 * deleted; explicit unregister or DeviceNotRegistered invalidation removes
 * them. ISO strings compare lexicographically.
 */
export function isActivePushRegistration(input: {
  readonly session: Option.Option<{
    readonly revokedAt: string | null;
    readonly expiresAt: string;
  }>;
  readonly registrationExpiresAt: string;
  readonly now: string;
}): boolean {
  if (Option.isNone(input.session)) return false;
  if (input.session.value.revokedAt !== null) return false;
  if (!(input.session.value.expiresAt > input.now)) return false;
  return input.registrationExpiresAt > input.now;
}

/** Capped exponential backoff with jitter for the push event subscription. */
export const pushResubscribeSchedule = Schedule.exponential("1 second").pipe(
  Schedule.jittered,
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(60))),
  ),
);

export class PushSubscriptionStopped extends Data.TaggedError("PushSubscriptionStopped")<{
  readonly cause: string;
}> {}

/**
 * A dead orchestration event stream must not silently end push delivery.
 *
 * The production subscription is `Stream.runForEach(...)` over
 * `Stream<OrchestrationEvent, never>`: it has no typed failure channel, so
 * `Effect.retry` alone would never run. Any abnormal non-interruption
 * termination — a stream defect, or a hot stream completing normally — is
 * converted into a retryable `PushSubscriptionStopped` sentinel and
 * resubscribed on the backoff schedule above. Interruption (shutdown)
 * propagates instead of restarting.
 */
export const withPushEventResubscribe = <A, E, R>(
  subscribe: Effect.Effect<A, E, R>,
  schedule: Schedule.Schedule<
    unknown,
    E | PushSubscriptionStopped,
    never,
    never
  > = pushResubscribeSchedule,
): Effect.Effect<never, E | PushSubscriptionStopped, R> =>
  Effect.retry(
    subscribe.pipe(
      Effect.catchCause(
        (cause: Cause.Cause<E>): Effect.Effect<never, E | PushSubscriptionStopped> =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.andThen(
                Effect.logWarning("Expo Push event subscriber stopped; resubscribing", {
                  cause: Cause.pretty(cause),
                }),
                Effect.fail(new PushSubscriptionStopped({ cause: Cause.pretty(cause) })),
              ),
      ),
      // A hot event stream completing normally would equally disable push.
      Effect.andThen(
        Effect.fail(new PushSubscriptionStopped({ cause: "event stream completed normally" })),
      ),
    ),
    { schedule },
  );
