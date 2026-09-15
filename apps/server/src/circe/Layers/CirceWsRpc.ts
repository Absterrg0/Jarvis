import { FetchHttpClient } from "effect/unstable/http";
import { runCirceQuickLookup } from "../Services/CirceQuickLookup.ts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CirceTaskCreatedActivityPayload,
  type AuthEnvironmentScope,
  type EnvironmentId,
  CirceExecutionError,
  CircePushRegistrationError,
  CirceLiveVoiceInvalidInputError,
  CirceLiveVoiceRuntimeError,
  CirceLiveVoiceUnavailableError,
  type CirceLiveVoiceError,
  type CirceFocusTaskInput,
  type CirceTaskDeskState,
  type CirceTaskDeskTask,
  type CirceTaskDeskTaskView,
  type CirceSemanticProposal,
  type CirceTaskDeskView,
  type OrchestrationShellSnapshot,
  circeNodeCapabilitiesForPreset,
  CirceWsRpcGroup,
  WS_METHODS,
} from "@t3tools/contracts";

import * as ServerConfig from "../../config.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { AuthSessionRepository } from "../../persistence/AuthSessions.ts";
import { WsRpcHandlerExtension, type WsRpcExtensionContext } from "../../ws.ts";
import { buildProjectVocabulary } from "@circe/core/buildProjectVocabulary";
import { getPendingCirceReplyState } from "@circe/core/confirmation";
import { circeWebsiteUrl } from "@circe/core/website";
import { deriveCirceTaskState } from "@circe/core/deriveTaskState";
import { circeRequestAcceptanceKey } from "@circe/core/requestIdentity";
import * as CirceController from "../Services/CirceController.ts";
import * as CirceLiveVoice from "../Services/CirceLiveVoice.ts";
import { CircePresentationFanout } from "../Services/CircePresentationFanout.ts";
import { CirceProjectLexicon } from "../Services/CirceProjectLexicon.ts";
import { CirceTaskDesk } from "../Services/CirceTaskDesk.ts";
import { CircePushRegistrationRepository } from "../../persistence/Services/CircePushRegistrations.ts";

const isCirceExecutionError = Schema.is(CirceExecutionError);
const isCirceLiveVoiceInvalidInputError = Schema.is(CirceLiveVoiceInvalidInputError);
const isCirceLiveVoiceUnavailableError = Schema.is(CirceLiveVoiceUnavailableError);
const isCirceLiveVoiceRuntimeError = Schema.is(CirceLiveVoiceRuntimeError);
const isCircePushRegistrationError = Schema.is(CircePushRegistrationError);
const decodeTaskCreatedPayload = Schema.decodeUnknownOption(CirceTaskCreatedActivityPayload);

/**
 * Live voice is a preset capability: the session runs over WebRTC and the
 * node's stored API key, so Full and Controller offer it without local
 * voice compute.
 */
export interface CirceLiveVoiceHandlerDependencies {
  readonly presetOffersVoice: boolean;
  readonly liveVoice: CirceLiveVoice.CirceLiveVoiceShape;
}

/**
 * Client-safe mapping for circe.voiceLiveStart failures. Typed cases keep
 * their reason so the client can point at node settings; anything
 * unrecognized becomes a fixed message, and the API key or HTTP body never
 * crosses the boundary. Exported for tests.
 */
export function toCirceVoiceLiveStartClientError(error: unknown): CirceLiveVoiceError {
  if (
    isCirceLiveVoiceInvalidInputError(error) ||
    isCirceLiveVoiceUnavailableError(error) ||
    isCirceLiveVoiceRuntimeError(error)
  ) {
    return error;
  }
  return new CirceLiveVoiceRuntimeError({
    message: "Live voice could not start on this Circe node.",
  });
}

export function runCirceVoiceLiveStart(
  input: Parameters<CirceLiveVoice.CirceLiveVoiceShape["createSession"]>[0],
  dependencies: CirceLiveVoiceHandlerDependencies,
) {
  const start = dependencies.presetOffersVoice
    ? dependencies.liveVoice.createSession(input)
    : Effect.fail(
        new CirceLiveVoiceUnavailableError({
          reason: "capability-unavailable",
          message: "Live voice is unavailable on this Circe node.",
        }),
      );
  return start.pipe(Effect.mapError((error) => toCirceVoiceLiveStartClientError(error)));
}

const tagOf = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string"
    ? error._tag
    : undefined;

const messageOf = (error: unknown): string | undefined =>
  typeof error === "object" &&
  error !== null &&
  "message" in error &&
  typeof error.message === "string"
    ? error.message
    : undefined;

/**
 * Client-safe mapping for circe.execute failures. Typed cases keep their
 * messages; anything unrecognized becomes a fixed message so internal detail
 * (persistence paths, provider output) never crosses the WebSocket boundary
 * to remote controllers. Exported for tests.
 */
export function toCirceExecuteClientError(error: unknown): CirceExecutionError {
  const decoded = Schema.decodeUnknownOption(CirceExecutionError)(error);
  if (Option.isSome(decoded)) return decoded.value;
  if (tagOf(error) === "CirceProjectNotFoundError") {
    return new CirceExecutionError({
      code: "project-not-found",
      message: `Project '${String((error as { readonly projectId?: unknown }).projectId)}' was not found.`,
    });
  }
  if (tagOf(error) === "CirceRequestConflictError") {
    return new CirceExecutionError({
      code: "request-conflict",
      message: messageOf(error) ?? "Circe could not start the requested task.",
    });
  }
  return new CirceExecutionError({
    code: "dispatch-failed",
    message: "Circe could not start the requested task.",
  });
}

/**
 * Client-safe mapping for circe.interpret failures. Exported for tests.
 */
export function toCirceInterpretClientError(error: unknown): CirceExecutionError {
  const decoded = Schema.decodeUnknownOption(CirceExecutionError)(error);
  if (Option.isSome(decoded)) return decoded.value;
  return new CirceExecutionError({
    code: "dispatch-failed",
    message: "Circe could not interpret that request.",
  });
}

/**
 * The host authorizes a proposed quick action before any client sees it.
 * A website target that cannot be grounded in the user's own utterance is
 * downgraded to `unsupported`, so a hallucinated alias or URL never reaches
 * a launcher. A quick action that carries project or task refs is a compound
 * the wire format cannot express, so it is downgraded too: the Director
 * answers it loudly instead of a client silently dropping the extra work.
 */
export function groundCirceQuickActionProposal(
  proposal: CirceSemanticProposal,
  sourceUtterance: string,
): CirceSemanticProposal {
  if (proposal.action !== "open-website" && proposal.action !== "lookup") return proposal;
  if (proposal.refs.length > 0)
    return { action: "unsupported", refs: [], model: null, effort: null, answer: null };
  if (proposal.action !== "open-website") return proposal;
  return typeof proposal.website === "string" &&
    circeWebsiteUrl(proposal.website, sourceUtterance) !== null
    ? proposal
    : { action: "unsupported", refs: [], model: null, effort: null, answer: null };
}

export function validateCirceFocusTaskIdentity(
  task: CirceFocusTaskInput,
  executionNodeId: EnvironmentId,
): CirceExecutionError | null {
  return task.taskRef.executionNodeId === executionNodeId && task.taskRef.threadId === task.threadId
    ? null
    : new CirceExecutionError({
        code: "node-mismatch",
        message: "The requested task belongs to a different Circe execution node.",
      });
}

function liveTaskView(
  task: CirceTaskDeskTask,
  shell: OrchestrationShellSnapshot,
  projectionSnapshotQuery: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape,
): Effect.Effect<CirceTaskDeskTaskView | null, never, never> {
  const thread = shell.threads.find((candidate) => candidate.id === task.threadId);
  if (thread === undefined) return Effect.succeed(null);
  return projectionSnapshotQuery.getThreadDetailById(task.threadId).pipe(
    Effect.orElseSucceed(() => Option.none()),
    Effect.map((detail) => {
      const detailValue = Option.isSome(detail) ? detail.value : undefined;
      const marker = detailValue?.activities.findLast(
        (activity) => activity.kind === "circe.task.created",
      );
      const markerPayload =
        marker === undefined
          ? undefined
          : Option.getOrUndefined(decodeTaskCreatedPayload(marker.payload));
      const objective =
        markerPayload?.objective ??
        detailValue?.messages.find((message) => message.role === "user")?.text.trim() ??
        thread.title;
      // Project the live pending request: the single waiter becomes the
      // client's answer pin, while none or several project to null so a
      // snapshot of "nothing uniquely waiting" stays explicit. Ambiguous
      // remains no-authorize: no pin is emitted for several.
      const pendingState =
        detailValue === undefined ? null : getPendingCirceReplyState(detailValue.activities);
      const pendingReply =
        pendingState !== null && pendingState.status === "single"
          ? pendingState.pending.kind === "approval"
            ? { kind: "approval" as const, requestId: pendingState.pending.requestId }
            : {
                kind: "user-input" as const,
                requestId: pendingState.pending.requestId,
                ...(pendingState.pending.questionIds.length === 0
                  ? {}
                  : { questionIds: [...pendingState.pending.questionIds] }),
              }
          : null;
      return {
        threadId: task.threadId,
        taskRef: task.taskRef,
        projectRef: task.projectRef,
        title: thread.title,
        objective,
        state: deriveCirceTaskState(thread),
        modelSelection: thread.modelSelection,
        pendingReply,
      };
    }),
  );
}

function toTaskDeskView(
  state: CirceTaskDeskState,
  shell: OrchestrationShellSnapshot,
  projectionSnapshotQuery: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape,
): Effect.Effect<CirceTaskDeskView, never, never> {
  return Effect.gen(function* () {
    const tasksByThreadId = new Map(
      [state.focusedTask, ...state.recentTasks]
        .filter((task): task is CirceTaskDeskTask => task !== null)
        .map((task) => [task.threadId, task]),
    );
    const liveTasks = yield* Effect.forEach([...tasksByThreadId.values()], (task) =>
      liveTaskView(task, shell, projectionSnapshotQuery).pipe(
        Effect.map((view) => [task.threadId, view] as const),
      ),
    );
    const liveTaskByThreadId = new Map(liveTasks);
    const focusedTask =
      state.focusedTask === null
        ? null
        : (liveTaskByThreadId.get(state.focusedTask.threadId) ?? null);
    const recentTasks = state.recentTasks.flatMap((task) => {
      const view = liveTaskByThreadId.get(task.threadId);
      return view === undefined || view === null ? [] : [view];
    });
    return {
      focusedTask,
      recentTasks,
      pendingInteraction: state.pendingInteraction,
      updatedAt: state.updatedAt,
    };
  });
}

export const circeRpcScopeExtension = {
  [WS_METHODS.circeExecute]: AuthOrchestrationOperateScope,
  [WS_METHODS.circeInterpret]: AuthOrchestrationOperateScope,
  [WS_METHODS.circeCancelRequest]: AuthOrchestrationOperateScope,
  [WS_METHODS.circeGetTaskDesk]: AuthOrchestrationReadScope,
  [WS_METHODS.circeFocusTask]: AuthOrchestrationOperateScope,
  [WS_METHODS.circeGetProjectVocabulary]: AuthOrchestrationReadScope,
  [WS_METHODS.circeManageProjectAlias]: AuthOrchestrationOperateScope,
  [WS_METHODS.subscribeCircePresentation]: AuthOrchestrationReadScope,
  [WS_METHODS.circeRegisterPushToken]: AuthOrchestrationReadScope,
  [WS_METHODS.circeUnregisterPushToken]: AuthOrchestrationReadScope,
  [WS_METHODS.circeQuickLookup]: AuthOrchestrationOperateScope,
  [WS_METHODS.circeVoiceLiveStart]: AuthOrchestrationOperateScope,
  [WS_METHODS.circeVoiceLiveRelease]: AuthOrchestrationOperateScope,
  [WS_METHODS.circeVoiceLiveRenew]: AuthOrchestrationOperateScope,
} as const satisfies Readonly<
  Record<RpcGroup.Rpcs<typeof CirceWsRpcGroup>["_tag"], AuthEnvironmentScope>
>;

export const CirceWsRpcHandlerExtensionLive = Layer.effect(
  WsRpcHandlerExtension,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    const executionNodeId = yield* serverEnvironment.getEnvironmentId;
    const circe = yield* CirceController.CirceController;
    const liveVoice = yield* CirceLiveVoice.CirceLiveVoice;
    const taskDesk = yield* CirceTaskDesk;
    const projectLexicon = yield* CirceProjectLexicon;
    const pushRegistrations = yield* CircePushRegistrationRepository;
    const authSessions = yield* AuthSessionRepository;
    const presentationFanout = yield* CircePresentationFanout;
    return {
      build: (context: WsRpcExtensionContext) =>
        Effect.succeed(
          CirceWsRpcGroup.of({
            [WS_METHODS.circeExecute]: (input) =>
              context.observeRpcEffect(
                WS_METHODS.circeExecute,
                Effect.gen(function* () {
                  // Project-free conversation bypasses execution gating: it
                  // creates no task and needs no project, only a model.
                  // Carries request identity for pre-accept cancellation.
                  if (input.kind === "converse") {
                    return yield* circe.converse({
                      utterance: input.utterance,
                      ...(input.requestMetadata === undefined
                        ? {}
                        : { requestMetadata: input.requestMetadata }),
                      executionNodeId,
                      ...(input.requestMetadata === undefined
                        ? {}
                        : {
                            acceptanceKey: circeRequestAcceptanceKey({
                              executionNodeId,
                              requestMetadata: input.requestMetadata,
                            }),
                          }),
                    });
                  }
                  if (!circeNodeCapabilitiesForPreset(config.circeNodePreset ?? "full").execution) {
                    return yield* new CirceExecutionError({
                      code: "execution-unavailable",
                      message:
                        "This Circe node is configured as a controller and cannot execute tasks.",
                    });
                  }
                  if (
                    input.projectRef !== undefined &&
                    (input.projectRef.nodeId !== executionNodeId ||
                      input.projectRef.projectId !== input.projectId)
                  ) {
                    return yield* new CirceExecutionError({
                      code: "node-mismatch",
                      message: "The requested project belongs to a different Circe execution node.",
                    });
                  }
                  return yield* circe.execute({
                    ...input,
                    sessionId: context.sessionId,
                    executionNodeId,
                  });
                }).pipe(
                  Effect.tapCause((cause) =>
                    Effect.logWarning("Circe execute failed", {
                      cause: Cause.pretty(cause),
                    }),
                  ),
                  Effect.mapError((error) => toCirceExecuteClientError(error)),
                ),
                { "rpc.aggregate": "circe" },
              ),
            [WS_METHODS.circeInterpret]: (input) =>
              context.observeRpcEffect(
                WS_METHODS.circeInterpret,
                Effect.gen(function* () {
                  if (!circeNodeCapabilitiesForPreset(config.circeNodePreset ?? "full").execution) {
                    return yield* new CirceExecutionError({
                      code: "execution-unavailable",
                      message:
                        "This Circe node is configured as a controller and cannot run semantic interpretation.",
                    });
                  }
                  const proposal = yield* circe.interpret({
                    ...input,
                    executionNodeId,
                    ...(input.requestMetadata === undefined
                      ? {}
                      : {
                          acceptanceKey: circeRequestAcceptanceKey({
                            executionNodeId,
                            requestMetadata: input.requestMetadata,
                          }),
                        }),
                  });
                  return groundCirceQuickActionProposal(proposal, input.utterance);
                }).pipe(
                  Effect.tapCause((cause) =>
                    Effect.logWarning("Circe interpret failed", {
                      cause: Cause.pretty(cause),
                    }),
                  ),
                  Effect.mapError((error) => toCirceInterpretClientError(error)),
                ),
                { "rpc.aggregate": "circe" },
              ),
            [WS_METHODS.circeCancelRequest]: (input) =>
              context.observeRpcEffect(
                WS_METHODS.circeCancelRequest,
                circe.cancelRequest({ ...input, executionNodeId }),
                { "rpc.aggregate": "circe" },
              ),
            [WS_METHODS.circeQuickLookup]: (input) =>
              context.observeRpcEffect(
                WS_METHODS.circeQuickLookup,
                runCirceQuickLookup(input, config.circeNodePreset ?? "full").pipe(
                  Effect.provide(FetchHttpClient.layer),
                  Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
                ),
                { "rpc.aggregate": "circe.quick" },
              ),
            // Release is intentionally not gated on presetOffersVoice like start
            // is: it is a cleanup path, and a session minted before a preset
            // change (or by a stale client) must still be closable. Release is
            // idempotent and mints nothing, so it cannot grant voice capability.
            [WS_METHODS.circeVoiceLiveRelease]: (input) =>
              context.observeRpcEffect(
                WS_METHODS.circeVoiceLiveRelease,
                liveVoice
                  .releaseSession(input)
                  .pipe(Effect.mapError(toCirceVoiceLiveStartClientError)),
                { "rpc.aggregate": "circe.voice" },
              ),
            [WS_METHODS.circeVoiceLiveStart]: (input) =>
              context.observeRpcEffect(
                WS_METHODS.circeVoiceLiveStart,
                runCirceVoiceLiveStart(input, {
                  presetOffersVoice: (config.circeNodePreset ?? "full") !== "headless",
                  liveVoice,
                }),
                { "rpc.aggregate": "circe.voice" },
              ),
            // Renderer liveness for an active session. Unknown ids are a no-op,
            // so a renew after a sweep or release can never resurrect a session.
            [WS_METHODS.circeVoiceLiveRenew]: (input) =>
              context.observeRpcEffect(
                WS_METHODS.circeVoiceLiveRenew,
                liveVoice
                  .renewSession(input)
                  .pipe(Effect.mapError(toCirceVoiceLiveStartClientError)),
                { "rpc.aggregate": "circe.voice" },
              ),
            [WS_METHODS.circeGetTaskDesk]: (_input) =>
              context.observeRpcEffect(
                WS_METHODS.circeGetTaskDesk,
                Effect.all({
                  state: taskDesk.get(context.sessionId),
                  shell: projectionSnapshotQuery.getShellSnapshot(),
                }).pipe(
                  Effect.flatMap(({ state, shell }) =>
                    toTaskDeskView(state, shell, projectionSnapshotQuery),
                  ),
                  Effect.mapError(
                    () =>
                      new CirceExecutionError({
                        code: "dispatch-failed",
                        message: "Circe could not load this device's task desk.",
                      }),
                  ),
                ),
                { "rpc.aggregate": "circe" },
              ),
            [WS_METHODS.circeGetProjectVocabulary]: (_input) =>
              context.observeRpcEffect(
                WS_METHODS.circeGetProjectVocabulary,
                context.authorizeEffect(
                  AuthOrchestrationReadScope,
                  Effect.all({
                    shell: projectionSnapshotQuery.getShellSnapshot(),
                    aliases: projectLexicon.list(),
                  }).pipe(
                    Effect.map(({ shell, aliases }) =>
                      buildProjectVocabulary({ projects: shell.projects, aliases }),
                    ),
                    Effect.mapError(
                      () =>
                        new CirceExecutionError({
                          code: "dispatch-failed",
                          message: "Circe could not read the project vocabulary.",
                        }),
                    ),
                  ),
                ),
                { "rpc.aggregate": "circe" },
              ),
            [WS_METHODS.circeManageProjectAlias]: (input) =>
              context.observeRpcEffect(
                WS_METHODS.circeManageProjectAlias,
                context.authorizeEffect(
                  AuthOrchestrationOperateScope,
                  Effect.gen(function* () {
                    const project = yield* projectionSnapshotQuery.getProjectShellById(
                      input.projectId,
                    );
                    if (Option.isNone(project)) {
                      return yield* new CirceExecutionError({
                        code: "project-not-found",
                        message: `Project '${input.projectId}' was not found.`,
                      });
                    }
                    const changed =
                      input.action === "set"
                        ? yield* projectLexicon.learn(input).pipe(Effect.as(true))
                        : yield* projectLexicon.forget(input);
                    return { changed };
                  }).pipe(
                    Effect.mapError((error) =>
                      isCirceExecutionError(error)
                        ? error
                        : new CirceExecutionError({
                            code: "dispatch-failed",
                            message: "Circe could not update that project alias.",
                          }),
                    ),
                  ),
                ),
                { "rpc.aggregate": "circe" },
              ),
            [WS_METHODS.circeFocusTask]: (task) =>
              context.observeRpcEffect(
                WS_METHODS.circeFocusTask,
                Effect.gen(function* () {
                  const identityError = validateCirceFocusTaskIdentity(task, executionNodeId);
                  if (identityError !== null) return yield* identityError;
                  const thread = yield* projectionSnapshotQuery.getThreadDetailById(task.threadId);
                  if (Option.isNone(thread)) {
                    return yield* new CirceExecutionError({
                      code: "dispatch-failed",
                      message: "That task is no longer available.",
                    });
                  }
                  const state = yield* taskDesk.focus({
                    sessionId: context.sessionId,
                    task: {
                      threadId: thread.value.id,
                      taskRef: { executionNodeId, threadId: thread.value.id },
                      projectRef: { nodeId: executionNodeId, projectId: thread.value.projectId },
                    },
                  });
                  const shell = yield* projectionSnapshotQuery.getShellSnapshot();
                  return yield* toTaskDeskView(state, shell, projectionSnapshotQuery);
                }).pipe(
                  Effect.mapError((error) =>
                    isCirceExecutionError(error)
                      ? error
                      : new CirceExecutionError({
                          code: "dispatch-failed",
                          message: "Circe could not update this device's task desk.",
                        }),
                  ),
                ),
                { "rpc.aggregate": "circe" },
              ),
            [WS_METHODS.subscribeCircePresentation]: (input) =>
              context.observeRpcStream(
                WS_METHODS.subscribeCircePresentation,
                // One shared projection fans out to every listener: the event
                // is read and built once, then routed here by origin.
                presentationFanout.subscribe({
                  originInteractionId: input.originInteractionId,
                  ...(input.originNodeId === undefined ? {} : { originNodeId: input.originNodeId }),
                }),
                { "rpc.aggregate": "circe" },
              ),
            [WS_METHODS.circeRegisterPushToken]: (input) =>
              context.observeRpcEffect(
                WS_METHODS.circeRegisterPushToken,
                context.authorizeEffect(
                  AuthOrchestrationReadScope,
                  Effect.gen(function* () {
                    const now = yield* DateTime.now;
                    const session = yield* authSessions.getById({ sessionId: context.sessionId });
                    if (
                      Option.isNone(session) ||
                      session.value.revokedAt !== null ||
                      !DateTime.isGreaterThan(session.value.expiresAt, now)
                    ) {
                      return yield* new CircePushRegistrationError({
                        message: "This authenticated session cannot register push notifications.",
                      });
                    }
                    yield* pushRegistrations.register({
                      ...input,
                      sessionId: context.sessionId,
                      nodeId: executionNodeId,
                      updatedAt: DateTime.formatIso(now),
                      expiresAt: DateTime.formatIso(
                        DateTime.min(session.value.expiresAt, DateTime.add(now, { days: 30 })),
                      ),
                    });
                    return { registered: true, nodeId: executionNodeId };
                  }).pipe(
                    Effect.mapError((error) =>
                      isCircePushRegistrationError(error)
                        ? error
                        : new CircePushRegistrationError({
                            message: "Could not register push notifications.",
                          }),
                    ),
                  ),
                ),
                { "rpc.aggregate": "circe.push" },
              ),
            [WS_METHODS.circeUnregisterPushToken]: (input) =>
              context.observeRpcEffect(
                WS_METHODS.circeUnregisterPushToken,
                context.authorizeEffect(
                  AuthOrchestrationReadScope,
                  pushRegistrations.unregister({ ...input, sessionId: context.sessionId }).pipe(
                    Effect.as({
                      registered: false,
                      nodeId: executionNodeId,
                    }),
                    Effect.mapError(
                      () =>
                        new CircePushRegistrationError({
                          message: "Could not unregister push notifications.",
                        }),
                    ),
                  ),
                ),
                { "rpc.aggregate": "circe.push" },
              ),
          }),
        ),
    };
  }),
);
