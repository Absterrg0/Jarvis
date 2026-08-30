import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
  JarvisExecutionError,
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
import type { JarvisTaskDeskCandidate } from "@t3tools/jarvis-core/resolveTaskDeskNavigation";
import { executeWithTaskDesk } from "../executeWithTaskDesk.ts";
import * as JarvisManager from "../Services/JarvisManager.ts";
import { JarvisProjectLexicon } from "../Services/JarvisProjectLexicon.ts";
import { JarvisTaskDesk } from "../Services/JarvisTaskDesk.ts";
import {
  buildJarvisPresentation,
  isJarvisPresentationSource,
  isPresentationForOrigin,
} from "../presentation.ts";

const isJarvisExecutionError = Schema.is(JarvisExecutionError);

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
    const jarvis = yield* JarvisManager.JarvisManager;
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
                  const shell = yield* projectionSnapshotQuery.getShellSnapshot();
                  const liveTasks: ReadonlyArray<JarvisTaskDeskCandidate> = shell.threads.map(
                    (thread) => ({
                      threadId: thread.id,
                      projectRef: { nodeId: executionNodeId, projectId: thread.projectId },
                      title: thread.title,
                      objective: thread.title,
                      state: thread.hasPendingApprovals
                        ? "waiting-for-approval"
                        : thread.hasPendingUserInput
                          ? "waiting-for-input"
                          : thread.session?.status === "error"
                            ? "failed"
                            : thread.session?.status === "interrupted"
                              ? "interrupted"
                              : thread.session?.status === "ready"
                                ? "ready"
                                : "running",
                      voiceAliases: [],
                    }),
                  );
                  return yield* executeWithTaskDesk(
                    jarvis,
                    taskDesk,
                    context.sessionId,
                    { ...input, executionNodeId },
                    liveTasks,
                  );
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
                taskDesk.get(context.sessionId).pipe(
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
