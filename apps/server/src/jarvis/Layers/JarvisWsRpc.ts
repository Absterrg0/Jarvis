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
  JarvisTaskCreatedActivityPayload,
  type AuthEnvironmentScope,
  type EnvironmentId,
  JarvisExecutionError,
  JarvisPushRegistrationError,
  JarvisLiveVoiceInvalidInputError,
  JarvisLiveVoiceRuntimeError,
  JarvisLiveVoiceUnavailableError,
  type JarvisLiveVoiceError,
  type JarvisFocusTaskInput,
  type JarvisTaskDeskState,
  type JarvisTaskDeskTask,
  type JarvisTaskDeskTaskView,
  type JarvisTaskDeskView,
  type OrchestrationShellSnapshot,
  jarvisNodeCapabilitiesForPreset,
  JarvisWsRpcGroup,
  WS_METHODS,
} from "@t3tools/contracts";

import * as ServerConfig from "../../config.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { AuthSessionRepository } from "../../persistence/AuthSessions.ts";
import { WsRpcHandlerExtension, type WsRpcExtensionContext } from "../../ws.ts";
import { buildProjectVocabulary } from "@t3tools/jarvis-core/buildProjectVocabulary";
import { getPendingJarvisReplyState } from "@t3tools/jarvis-core/confirmation";
import { deriveJarvisTaskState } from "@t3tools/jarvis-core/deriveTaskState";
import { jarvisRequestAcceptanceKey } from "@t3tools/jarvis-core/requestIdentity";
import * as JarvisController from "../Services/JarvisController.ts";
import * as JarvisLiveVoice from "../Services/JarvisLiveVoice.ts";
import { JarvisPresentationFanout } from "../Services/JarvisPresentationFanout.ts";
import { JarvisProjectLexicon } from "../Services/JarvisProjectLexicon.ts";
import { JarvisTaskDesk } from "../Services/JarvisTaskDesk.ts";
import { JarvisPushRegistrationRepository } from "../../persistence/Services/JarvisPushRegistrations.ts";

const isJarvisExecutionError = Schema.is(JarvisExecutionError);
const isJarvisLiveVoiceInvalidInputError = Schema.is(JarvisLiveVoiceInvalidInputError);
const isJarvisLiveVoiceUnavailableError = Schema.is(JarvisLiveVoiceUnavailableError);
const isJarvisLiveVoiceRuntimeError = Schema.is(JarvisLiveVoiceRuntimeError);
const isJarvisPushRegistrationError = Schema.is(JarvisPushRegistrationError);
const decodeTaskCreatedPayload = Schema.decodeUnknownOption(JarvisTaskCreatedActivityPayload);

/**
 * Live voice is a preset capability: the session runs over WebRTC and the
 * node's stored API key, so Full and Controller offer it without local
 * voice compute.
 */
export interface JarvisLiveVoiceHandlerDependencies {
  readonly presetOffersVoice: boolean;
  readonly liveVoice: JarvisLiveVoice.JarvisLiveVoiceShape;
}

/**
 * Client-safe mapping for jarvis.voiceLiveStart failures. Typed cases keep
 * their reason so the client can point at node settings; anything
 * unrecognized becomes a fixed message, and the API key or HTTP body never
 * crosses the boundary. Exported for tests.
 */
export function toJarvisVoiceLiveStartClientError(error: unknown): JarvisLiveVoiceError {
  if (
    isJarvisLiveVoiceInvalidInputError(error) ||
    isJarvisLiveVoiceUnavailableError(error) ||
    isJarvisLiveVoiceRuntimeError(error)
  ) {
    return error;
  }
  return new JarvisLiveVoiceRuntimeError({
    message: "Live voice could not start on this Jarvis node.",
  });
}

export function runJarvisVoiceLiveStart(
  input: Parameters<JarvisLiveVoice.JarvisLiveVoiceShape["createSession"]>[0],
  dependencies: JarvisLiveVoiceHandlerDependencies,
) {
  const start = dependencies.presetOffersVoice
    ? dependencies.liveVoice.createSession(input)
    : Effect.fail(
        new JarvisLiveVoiceUnavailableError({
          reason: "capability-unavailable",
          message: "Live voice is unavailable on this Jarvis node.",
        }),
      );
  return start.pipe(Effect.mapError((error) => toJarvisVoiceLiveStartClientError(error)));
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
 * Client-safe mapping for jarvis.execute failures. Typed cases keep their
 * messages; anything unrecognized becomes a fixed message so internal detail
 * (persistence paths, provider output) never crosses the WebSocket boundary
 * to remote controllers. Exported for tests.
 */
export function toJarvisExecuteClientError(error: unknown): JarvisExecutionError {
  const decoded = Schema.decodeUnknownOption(JarvisExecutionError)(error);
  if (Option.isSome(decoded)) return decoded.value;
  if (tagOf(error) === "JarvisProjectNotFoundError") {
    return new JarvisExecutionError({
      code: "project-not-found",
      message: `Project '${String((error as { readonly projectId?: unknown }).projectId)}' was not found.`,
    });
  }
  if (tagOf(error) === "JarvisRequestConflictError") {
    return new JarvisExecutionError({
      code: "request-conflict",
      message: messageOf(error) ?? "Jarvis could not start the requested task.",
    });
  }
  return new JarvisExecutionError({
    code: "dispatch-failed",
    message: "Jarvis could not start the requested task.",
  });
}

/**
 * Client-safe mapping for jarvis.interpret failures. Exported for tests.
 */
export function toJarvisInterpretClientError(error: unknown): JarvisExecutionError {
  const decoded = Schema.decodeUnknownOption(JarvisExecutionError)(error);
  if (Option.isSome(decoded)) return decoded.value;
  return new JarvisExecutionError({
    code: "dispatch-failed",
    message: "Jarvis could not interpret that request.",
  });
}

export function validateJarvisFocusTaskIdentity(
  task: JarvisFocusTaskInput,
  executionNodeId: EnvironmentId,
): JarvisExecutionError | null {
  return task.taskRef.executionNodeId === executionNodeId && task.taskRef.threadId === task.threadId
    ? null
    : new JarvisExecutionError({
        code: "node-mismatch",
        message: "The requested task belongs to a different Jarvis execution node.",
      });
}

function liveTaskView(
  task: JarvisTaskDeskTask,
  shell: OrchestrationShellSnapshot,
  projectionSnapshotQuery: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape,
): Effect.Effect<JarvisTaskDeskTaskView | null, never, never> {
  const thread = shell.threads.find((candidate) => candidate.id === task.threadId);
  if (thread === undefined) return Effect.succeed(null);
  return projectionSnapshotQuery.getThreadDetailById(task.threadId).pipe(
    Effect.orElseSucceed(() => Option.none()),
    Effect.map((detail) => {
      const detailValue = Option.isSome(detail) ? detail.value : undefined;
      const marker = detailValue?.activities.findLast(
        (activity) => activity.kind === "jarvis.task.created",
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
        detailValue === undefined ? null : getPendingJarvisReplyState(detailValue.activities);
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
        state: deriveJarvisTaskState(thread),
        modelSelection: thread.modelSelection,
        pendingReply,
      };
    }),
  );
}

function toTaskDeskView(
  state: JarvisTaskDeskState,
  shell: OrchestrationShellSnapshot,
  projectionSnapshotQuery: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape,
): Effect.Effect<JarvisTaskDeskView, never, never> {
  return Effect.gen(function* () {
    const tasksByThreadId = new Map(
      [state.focusedTask, ...state.recentTasks]
        .filter((task): task is JarvisTaskDeskTask => task !== null)
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

export const jarvisRpcScopeExtension = {
  [WS_METHODS.jarvisExecute]: AuthOrchestrationOperateScope,
  [WS_METHODS.jarvisInterpret]: AuthOrchestrationOperateScope,
  [WS_METHODS.jarvisCancelRequest]: AuthOrchestrationOperateScope,
  [WS_METHODS.jarvisGetTaskDesk]: AuthOrchestrationReadScope,
  [WS_METHODS.jarvisFocusTask]: AuthOrchestrationOperateScope,
  [WS_METHODS.jarvisGetProjectVocabulary]: AuthOrchestrationReadScope,
  [WS_METHODS.jarvisManageProjectAlias]: AuthOrchestrationOperateScope,
  [WS_METHODS.subscribeJarvisPresentation]: AuthOrchestrationReadScope,
  [WS_METHODS.jarvisRegisterPushToken]: AuthOrchestrationReadScope,
  [WS_METHODS.jarvisUnregisterPushToken]: AuthOrchestrationReadScope,
  [WS_METHODS.jarvisVoiceLiveStart]: AuthOrchestrationOperateScope,
} as const satisfies Readonly<
  Record<RpcGroup.Rpcs<typeof JarvisWsRpcGroup>["_tag"], AuthEnvironmentScope>
>;

export const JarvisWsRpcHandlerExtensionLive = Layer.effect(
  WsRpcHandlerExtension,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    const executionNodeId = yield* serverEnvironment.getEnvironmentId;
    const jarvis = yield* JarvisController.JarvisController;
    const liveVoice = yield* JarvisLiveVoice.JarvisLiveVoice;
    const taskDesk = yield* JarvisTaskDesk;
    const projectLexicon = yield* JarvisProjectLexicon;
    const pushRegistrations = yield* JarvisPushRegistrationRepository;
    const authSessions = yield* AuthSessionRepository;
    const presentationFanout = yield* JarvisPresentationFanout;
    return {
      build: (context: WsRpcExtensionContext) =>
        Effect.succeed(
          JarvisWsRpcGroup.of({
            [WS_METHODS.jarvisExecute]: (input) =>
              context.observeRpcEffect(
                WS_METHODS.jarvisExecute,
                Effect.gen(function* () {
                  // Project-free conversation bypasses execution gating: it
                  // creates no task and needs no project, only a model.
                  // Carries request identity for pre-accept cancellation.
                  if (input.kind === "converse") {
                    return yield* jarvis.converse({
                      utterance: input.utterance,
                      ...(input.requestMetadata === undefined
                        ? {}
                        : { requestMetadata: input.requestMetadata }),
                      executionNodeId,
                      ...(input.requestMetadata === undefined
                        ? {}
                        : {
                            acceptanceKey: jarvisRequestAcceptanceKey({
                              executionNodeId,
                              requestMetadata: input.requestMetadata,
                            }),
                          }),
                    });
                  }
                  if (
                    !jarvisNodeCapabilitiesForPreset(config.jarvisNodePreset ?? "full").execution
                  ) {
                    return yield* new JarvisExecutionError({
                      code: "execution-unavailable",
                      message:
                        "This ARIS node is configured as a controller and cannot execute tasks.",
                    });
                  }
                  if (
                    input.projectRef !== undefined &&
                    (input.projectRef.nodeId !== executionNodeId ||
                      input.projectRef.projectId !== input.projectId)
                  ) {
                    return yield* new JarvisExecutionError({
                      code: "node-mismatch",
                      message:
                        "The requested project belongs to a different Jarvis execution node.",
                    });
                  }
                  return yield* jarvis.execute({
                    ...input,
                    sessionId: context.sessionId,
                    executionNodeId,
                  });
                }).pipe(
                  Effect.tapCause((cause) =>
                    Effect.logWarning("Jarvis execute failed", {
                      cause: Cause.pretty(cause),
                    }),
                  ),
                  Effect.mapError((error) => toJarvisExecuteClientError(error)),
                ),
                { "rpc.aggregate": "jarvis" },
              ),
            [WS_METHODS.jarvisInterpret]: (input) =>
              context.observeRpcEffect(
                WS_METHODS.jarvisInterpret,
                Effect.gen(function* () {
                  if (
                    !jarvisNodeCapabilitiesForPreset(config.jarvisNodePreset ?? "full").execution
                  ) {
                    return yield* new JarvisExecutionError({
                      code: "execution-unavailable",
                      message:
                        "This ARIS node is configured as a controller and cannot run semantic interpretation.",
                    });
                  }
                  return yield* jarvis.interpret({
                    ...input,
                    executionNodeId,
                    ...(input.requestMetadata === undefined
                      ? {}
                      : {
                          acceptanceKey: jarvisRequestAcceptanceKey({
                            executionNodeId,
                            requestMetadata: input.requestMetadata,
                          }),
                        }),
                  });
                }).pipe(
                  Effect.tapCause((cause) =>
                    Effect.logWarning("Jarvis interpret failed", {
                      cause: Cause.pretty(cause),
                    }),
                  ),
                  Effect.mapError((error) => toJarvisInterpretClientError(error)),
                ),
                { "rpc.aggregate": "jarvis" },
              ),
            [WS_METHODS.jarvisCancelRequest]: (input) =>
              context.observeRpcEffect(
                WS_METHODS.jarvisCancelRequest,
                jarvis.cancelRequest({ ...input, executionNodeId }),
                { "rpc.aggregate": "jarvis" },
              ),
            [WS_METHODS.jarvisVoiceLiveStart]: (input) =>
              context.observeRpcEffect(
                WS_METHODS.jarvisVoiceLiveStart,
                runJarvisVoiceLiveStart(input, {
                  presetOffersVoice: (config.jarvisNodePreset ?? "full") !== "headless",
                  liveVoice,
                }),
                { "rpc.aggregate": "jarvis.voice" },
              ),
            [WS_METHODS.jarvisGetTaskDesk]: (_input) =>
              context.observeRpcEffect(
                WS_METHODS.jarvisGetTaskDesk,
                Effect.all({
                  state: taskDesk.get(context.sessionId),
                  shell: projectionSnapshotQuery.getShellSnapshot(),
                }).pipe(
                  Effect.flatMap(({ state, shell }) =>
                    toTaskDeskView(state, shell, projectionSnapshotQuery),
                  ),
                  Effect.mapError(
                    () =>
                      new JarvisExecutionError({
                        code: "dispatch-failed",
                        message: "Jarvis could not load this device's task desk.",
                      }),
                  ),
                ),
                { "rpc.aggregate": "jarvis" },
              ),
            [WS_METHODS.jarvisGetProjectVocabulary]: (_input) =>
              context.observeRpcEffect(
                WS_METHODS.jarvisGetProjectVocabulary,
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
                        new JarvisExecutionError({
                          code: "dispatch-failed",
                          message: "Jarvis could not read the project vocabulary.",
                        }),
                    ),
                  ),
                ),
                { "rpc.aggregate": "jarvis" },
              ),
            [WS_METHODS.jarvisManageProjectAlias]: (input) =>
              context.observeRpcEffect(
                WS_METHODS.jarvisManageProjectAlias,
                context.authorizeEffect(
                  AuthOrchestrationOperateScope,
                  Effect.gen(function* () {
                    const project = yield* projectionSnapshotQuery.getProjectShellById(
                      input.projectId,
                    );
                    if (Option.isNone(project)) {
                      return yield* new JarvisExecutionError({
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
                      isJarvisExecutionError(error)
                        ? error
                        : new JarvisExecutionError({
                            code: "dispatch-failed",
                            message: "Jarvis could not update that project alias.",
                          }),
                    ),
                  ),
                ),
                { "rpc.aggregate": "jarvis" },
              ),
            [WS_METHODS.jarvisFocusTask]: (task) =>
              context.observeRpcEffect(
                WS_METHODS.jarvisFocusTask,
                Effect.gen(function* () {
                  const identityError = validateJarvisFocusTaskIdentity(task, executionNodeId);
                  if (identityError !== null) return yield* identityError;
                  const thread = yield* projectionSnapshotQuery.getThreadDetailById(task.threadId);
                  if (Option.isNone(thread)) {
                    return yield* new JarvisExecutionError({
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
                    isJarvisExecutionError(error)
                      ? error
                      : new JarvisExecutionError({
                          code: "dispatch-failed",
                          message: "Jarvis could not update this device's task desk.",
                        }),
                  ),
                ),
                { "rpc.aggregate": "jarvis" },
              ),
            [WS_METHODS.subscribeJarvisPresentation]: (input) =>
              context.observeRpcStream(
                WS_METHODS.subscribeJarvisPresentation,
                // One shared projection fans out to every listener: the event
                // is read and built once, then routed here by origin.
                presentationFanout.subscribe({
                  originInteractionId: input.originInteractionId,
                  ...(input.originNodeId === undefined ? {} : { originNodeId: input.originNodeId }),
                }),
                { "rpc.aggregate": "jarvis" },
              ),
            [WS_METHODS.jarvisRegisterPushToken]: (input) =>
              context.observeRpcEffect(
                WS_METHODS.jarvisRegisterPushToken,
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
                      return yield* new JarvisPushRegistrationError({
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
                      isJarvisPushRegistrationError(error)
                        ? error
                        : new JarvisPushRegistrationError({
                            message: "Could not register push notifications.",
                          }),
                    ),
                  ),
                ),
                { "rpc.aggregate": "jarvis.push" },
              ),
            [WS_METHODS.jarvisUnregisterPushToken]: (input) =>
              context.observeRpcEffect(
                WS_METHODS.jarvisUnregisterPushToken,
                context.authorizeEffect(
                  AuthOrchestrationReadScope,
                  pushRegistrations.unregister({ ...input, sessionId: context.sessionId }).pipe(
                    Effect.as({
                      registered: false,
                      nodeId: executionNodeId,
                    }),
                    Effect.mapError(
                      () =>
                        new JarvisPushRegistrationError({
                          message: "Could not unregister push notifications.",
                        }),
                    ),
                  ),
                ),
                { "rpc.aggregate": "jarvis.push" },
              ),
          }),
        ),
    };
  }),
);
