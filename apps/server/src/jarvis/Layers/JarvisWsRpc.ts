import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  JarvisTaskCreatedActivityPayload,
  type AuthEnvironmentScope,
  JarvisExecutionError,
  type JarvisTaskDeskState,
  type JarvisTaskDeskTask,
  type JarvisTaskDeskTaskView,
  type JarvisTaskDeskView,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
  jarvisNodeCapabilitiesForPreset,
  JarvisWsRpcGroup,
  WS_METHODS,
} from "@t3tools/contracts";

import * as ServerConfig from "../../config.ts";
import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { WsRpcHandlerExtension, type WsRpcExtensionContext } from "../../ws.ts";
import { buildProjectVocabulary } from "@t3tools/jarvis-core/buildProjectVocabulary";
import * as JarvisController from "../Services/JarvisController.ts";
import { JarvisProjectLexicon } from "../Services/JarvisProjectLexicon.ts";
import { JarvisTaskDesk } from "../Services/JarvisTaskDesk.ts";
import {
  buildJarvisPresentation,
  isJarvisPresentationSource,
  isPresentationForOrigin,
} from "../presentation.ts";

const isJarvisExecutionError = Schema.is(JarvisExecutionError);
const decodeTaskCreatedPayload = Schema.decodeUnknownOption(JarvisTaskCreatedActivityPayload);

export function deriveTaskDeskTaskState(
  thread: Pick<
    OrchestrationThreadShell,
    "hasPendingApprovals" | "hasPendingUserInput" | "latestTurn" | "session"
  >,
): JarvisTaskDeskTaskView["state"] {
  if (thread.hasPendingApprovals) return "waiting-for-approval";
  if (thread.hasPendingUserInput) return "waiting-for-input";
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") return "failed";
  if (
    thread.session?.status === "interrupted" ||
    thread.session?.status === "stopped" ||
    thread.latestTurn?.state === "interrupted"
  ) {
    return "interrupted";
  }
  if (thread.session?.status === "ready" || thread.latestTurn?.state === "completed") {
    return "ready";
  }
  return "running";
}

function liveTaskView(
  task: JarvisTaskDeskTask,
  shell: OrchestrationShellSnapshot,
  projectionSnapshotQuery: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape,
): Effect.Effect<JarvisTaskDeskTaskView | undefined, never, never> {
  const thread = shell.threads.find((candidate) => candidate.id === task.threadId);
  if (thread === undefined) return Effect.succeed(undefined);
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
      return {
        threadId: task.threadId,
        taskRef: task.taskRef,
        projectRef: task.projectRef,
        title: thread.title,
        objective,
        state: deriveTaskDeskTaskState(thread),
        modelSelection: thread.modelSelection,
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
    const focusedTask =
      state.focusedTask === null
        ? null
        : ((yield* liveTaskView(state.focusedTask, shell, projectionSnapshotQuery)) ?? null);
    const recentTasks = yield* Effect.forEach(state.recentTasks, (task) =>
      liveTaskView(task, shell, projectionSnapshotQuery),
    ).pipe(Effect.map((tasks) => tasks.flatMap((task) => (task === undefined ? [] : [task]))));
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
  [WS_METHODS.jarvisGetTaskDesk]: AuthOrchestrationReadScope,
  [WS_METHODS.jarvisNavigateTaskDesk]: AuthOrchestrationOperateScope,
  [WS_METHODS.jarvisGetProjectVocabulary]: AuthOrchestrationReadScope,
  [WS_METHODS.jarvisManageProjectAlias]: AuthOrchestrationOperateScope,
  [WS_METHODS.subscribeJarvisPresentation]: AuthOrchestrationReadScope,
} as const satisfies Readonly<
  Record<RpcGroup.Rpcs<typeof JarvisWsRpcGroup>["_tag"], AuthEnvironmentScope>
>;

export const JarvisWsRpcHandlerExtensionLive = Layer.effect(
  WsRpcHandlerExtension,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    const executionNodeId = yield* serverEnvironment.getEnvironmentId;
    const jarvis = yield* JarvisController.JarvisController;
    const taskDesk = yield* JarvisTaskDesk;
    const projectLexicon = yield* JarvisProjectLexicon;
    return {
      build: (context: WsRpcExtensionContext) =>
        Effect.succeed(
          JarvisWsRpcGroup.of({
            [WS_METHODS.jarvisExecute]: (input) =>
              context.observeRpcEffect(
                WS_METHODS.jarvisExecute,
                Effect.gen(function* () {
                  if (
                    !jarvisNodeCapabilitiesForPreset(config.jarvisNodePreset ?? "full").execution
                  ) {
                    return yield* new JarvisExecutionError({
                      code: "execution-unavailable",
                      message:
                        "This Jarvis node is configured as a controller and cannot execute tasks.",
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
                  Effect.mapError((error) =>
                    error._tag === "JarvisExecutionError"
                      ? error
                      : new JarvisExecutionError({
                          code:
                            error._tag === "JarvisProjectNotFoundError"
                              ? "project-not-found"
                              : error._tag === "JarvisRequestConflictError"
                                ? "request-conflict"
                                : "dispatch-failed",
                          message:
                            error._tag === "JarvisProjectNotFoundError"
                              ? `Project '${error.projectId}' was not found.`
                              : error instanceof Error
                                ? error.message
                                : "Jarvis could not start the requested task.",
                        }),
                  ),
                ),
                { "rpc.aggregate": "jarvis" },
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
            [WS_METHODS.jarvisNavigateTaskDesk]: (navigation) =>
              context.observeRpcEffect(
                WS_METHODS.jarvisNavigateTaskDesk,
                taskDesk.navigate({ sessionId: context.sessionId, navigation }).pipe(
                  Effect.flatMap((state) =>
                    projectionSnapshotQuery
                      .getShellSnapshot()
                      .pipe(
                        Effect.flatMap((shell) =>
                          toTaskDeskView(state, shell, projectionSnapshotQuery),
                        ),
                      ),
                  ),
                  Effect.mapError(
                    () =>
                      new JarvisExecutionError({
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
                orchestrationEngine.streamDomainEvents.pipe(
                  Stream.filter(isJarvisPresentationSource),
                  Stream.mapEffect((event) =>
                    Effect.gen(function* () {
                      if (
                        event.type !== "thread.activity-appended" &&
                        event.type !== "thread.session-set"
                      ) {
                        return Option.none();
                      }
                      const threadId = event.payload.threadId;
                      const detail = yield* projectionSnapshotQuery.getThreadDetailById(threadId);
                      if (Option.isNone(detail)) return Option.none();
                      const project = yield* projectionSnapshotQuery.getProjectShellById(
                        detail.value.projectId,
                      );
                      const presentation = buildJarvisPresentation(
                        event,
                        detail.value,
                        Option.isSome(project) ? project.value.title : "this project",
                      );
                      if (
                        presentation === null ||
                        !isPresentationForOrigin(
                          presentation,
                          input.originInteractionId,
                          input.originNodeId,
                        )
                      ) {
                        return Option.none();
                      }
                      return Option.some(presentation);
                    }).pipe(
                      Effect.catch((cause) =>
                        Effect.logWarning("Failed to build Jarvis presentation", {
                          aggregateId: event.aggregateId,
                          cause,
                        }).pipe(Effect.as(Option.none())),
                      ),
                    ),
                  ),
                  Stream.filter(Option.isSome),
                  Stream.map((presentation) => presentation.value),
                ),
                { "rpc.aggregate": "jarvis" },
              ),
          }),
        ),
    };
  }),
);
