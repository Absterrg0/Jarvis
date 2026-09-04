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
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
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

export function notificationKindForEvent(
  event: OrchestrationEvent,
): JarvisPushNotificationKind | null {
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
  const data = JarvisPushNotificationData.make({
    environmentId: nodeId,
    threadId: event.payload.threadId,
    kind: notification,
    notificationId: event.eventId,
  });
  const kindTitle =
    notification === "approval-required"
      ? "Approval required"
      : notification === "needs-input"
        ? "Input needed"
        : notification === "completed"
          ? "Task completed"
          : "Task failed";
  const kindBody =
    notification === "approval-required"
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

export const makeExpoPushReactorExtension = (
  sender: ExpoPushSender,
  options: {
    /**
     * Descriptive thread/project copy leaves the node for Expo. Off by
     * default; wire a user preference here before enabling.
     */
    readonly descriptivePreview?: boolean;
  } = {},
) =>
  Layer.effect(
    OrchestrationReactorExtension,
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const projections = yield* ProjectionSnapshotQuery;
      const registrations = yield* JarvisPushRegistrationRepository;
      const sessions = yield* AuthSessionRepository;
      const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
      const nodeId = yield* serverEnvironment.getEnvironmentId;
      const descriptivePreview = options.descriptivePreview === true;
      const start = Effect.fn("ExpoPushNotifications.start")(function* () {
        yield* forkParked(
          Stream.runForEach(engine.streamDomainEvents, (event) => {
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
