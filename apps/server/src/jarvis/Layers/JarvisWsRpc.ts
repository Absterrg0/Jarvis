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
  type OrchestrationEvent,
  JarvisWsRpcGroup,
  WS_METHODS,
} from "@t3tools/contracts";

import * as ServerConfig from "../../config.ts";
import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import {
  WsRpcHandlerExtension,
  type WsRpcExtensionContext,
  type WsRpcExtensionHandlers,
} from "../../ws.ts";
import { buildProjectVocabulary } from "@t3tools/jarvis-core/buildProjectVocabulary";
import {
  buildActivityVoiceReportForActivity,
  buildSessionVoiceReport,
} from "@t3tools/jarvis-core/buildVoiceReport";
import { executeWithTaskDesk } from "../executeWithTaskDesk.ts";
import * as JarvisManager from "../Services/JarvisManager.ts";
import { JarvisProjectLexicon } from "../Services/JarvisProjectLexicon.ts";
import * as JarvisReportOutbox from "../Services/JarvisReportOutbox.ts";
import * as JarvisSpeakerLease from "../Services/JarvisSpeakerLease.ts";
import { JarvisTaskDesk } from "../Services/JarvisTaskDesk.ts";

const isJarvisExecutionError = Schema.is(JarvisExecutionError);

export const jarvisRpcScopeExtension = {
  [WS_METHODS.jarvisExecute]: AuthOrchestrationOperateScope,
  [WS_METHODS.jarvisGetTaskDesk]: AuthOrchestrationReadScope,
  [WS_METHODS.jarvisNavigateTaskDesk]: AuthOrchestrationOperateScope,
  [WS_METHODS.jarvisGetProjectVocabulary]: AuthOrchestrationReadScope,
  [WS_METHODS.jarvisManageProjectAlias]: AuthOrchestrationOperateScope,
  [WS_METHODS.subscribeJarvisReports]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeJarvisReportInbox]: AuthOrchestrationReadScope,
  [WS_METHODS.jarvisAcknowledgeReport]: AuthOrchestrationReadScope,
  [WS_METHODS.jarvisClaimSpeaker]: AuthOrchestrationReadScope,
  [WS_METHODS.jarvisConfirmReportSpoken]: AuthOrchestrationReadScope,
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
    const jarvisReportOutbox = yield* JarvisReportOutbox.JarvisReportOutbox;
    const jarvisSpeakerLease = yield* JarvisSpeakerLease.JarvisSpeakerLease;

    return {
      build: (context: WsRpcExtensionContext) =>
        Effect.gen(function* () {
          const loadVoiceReport = Effect.fn("Jarvis.loadVoiceReport")(function* (
            event: Extract<
              OrchestrationEvent,
              { type: "thread.activity-appended" | "thread.session-set" }
            >,
          ) {
            const detail = yield* projectionSnapshotQuery.getThreadDetailById(
              event.payload.threadId,
            );
            const project = Option.isSome(detail)
              ? yield* projectionSnapshotQuery.getProjectShellById(detail.value.projectId)
              : Option.none();
            const report = Option.isSome(detail)
              ? event.type === "thread.activity-appended"
                ? buildActivityVoiceReportForActivity(
                    detail.value,
                    event.payload.activity,
                    Option.isSome(project) ? project.value.title : "this project",
                  )
                : buildSessionVoiceReport(
                    detail.value,
                    event.payload.session,
                    detail.value.latestTurn === null
                      ? `${event.payload.threadId}:session:${event.sequence}`
                      : `${event.payload.threadId}:turn:${detail.value.latestTurn.turnId}:failed`,
                  )
              : null;
            return Option.fromNullishOr(report);
          });

          return JarvisWsRpcGroup.of({
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
                  if (input.requestMetadata !== undefined) {
                    yield* jarvisReportOutbox.register(
                      context.sessionId,
                      input.requestMetadata.origin?.originInteractionId,
                    );
                  }
                  return yield* executeWithTaskDesk(jarvis, taskDesk, context.sessionId, {
                    ...input,
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
            [WS_METHODS.subscribeJarvisReports]: (_input) =>
              context.observeRpcStream(
                WS_METHODS.subscribeJarvisReports,
                orchestrationEngine.streamDomainEvents.pipe(
                  Stream.filter(
                    (
                      event,
                    ): event is Extract<
                      OrchestrationEvent,
                      { type: "thread.activity-appended" | "thread.session-set" }
                    > =>
                      (event.type === "thread.activity-appended" &&
                        (["user-input.requested", "approval.requested", "runtime.error"].includes(
                          event.payload.activity.kind,
                        ) ||
                          event.payload.activity.kind.endsWith(".failed") ||
                          event.payload.activity.kind === "jarvis.turn.completion-ready")) ||
                      (event.type === "thread.session-set" &&
                        event.payload.session.status === "error"),
                  ),
                  Stream.mapEffect((event) =>
                    loadVoiceReport(event).pipe(
                      Effect.catch((cause) =>
                        Effect.logWarning("Failed to build Jarvis voice report", {
                          threadId: event.payload.threadId,
                          cause,
                        }).pipe(Effect.as(Option.none())),
                      ),
                    ),
                  ),
                  Stream.filter(Option.isSome),
                  Stream.map((report) => report.value),
                ),
                { "rpc.aggregate": "jarvis" },
              ),
            [WS_METHODS.subscribeJarvisReportInbox]: (input) =>
              context.observeRpcStream(
                WS_METHODS.subscribeJarvisReportInbox,
                jarvisReportOutbox.subscribe(context.sessionId, input.originInteractionId).pipe(
                  Stream.mapError(
                    () =>
                      new JarvisExecutionError({
                        code: "internal-error",
                        message: "Jarvis could not load pending reports.",
                      }),
                  ),
                ),
                { "rpc.aggregate": "jarvis" },
              ),
            [WS_METHODS.jarvisAcknowledgeReport]: (input) =>
              context.observeRpcEffect(
                WS_METHODS.jarvisAcknowledgeReport,
                jarvisReportOutbox
                  .acknowledge(context.sessionId, input.throughSequence, input.originInteractionId)
                  .pipe(
                    Effect.map((acknowledgedThrough) => ({ acknowledgedThrough })),
                    Effect.mapError(
                      () =>
                        new JarvisExecutionError({
                          code: "internal-error",
                          message: "Jarvis could not acknowledge that report.",
                        }),
                    ),
                  ),
                { "rpc.aggregate": "jarvis" },
              ),
            [WS_METHODS.jarvisClaimSpeaker]: (input) =>
              context.observeRpcEffect(
                WS_METHODS.jarvisClaimSpeaker,
                jarvisSpeakerLease.claim(input).pipe(
                  Effect.flatMap((claim) =>
                    !claim.granted
                      ? Effect.succeed(claim)
                      : jarvisReportOutbox.claimSpeech(input.reportId, input.deviceId).pipe(
                          Effect.map((result) => ({
                            granted: result === "claimed" || result === "missing",
                            speechState: result,
                          })),
                          Effect.mapError(
                            () =>
                              new JarvisExecutionError({
                                code: "internal-error",
                                message: "Jarvis could not reserve speech for that report.",
                              }),
                          ),
                        ),
                  ),
                ),
                { "rpc.aggregate": "jarvis" },
              ),
            [WS_METHODS.jarvisConfirmReportSpoken]: (input) =>
              context.observeRpcEffect(
                WS_METHODS.jarvisConfirmReportSpoken,
                jarvisReportOutbox.confirmSpeech(input.reportId, input.deviceId).pipe(
                  Effect.map((state) => ({ confirmed: state === "confirmed", state })),
                  Effect.mapError(
                    () =>
                      new JarvisExecutionError({
                        code: "internal-error",
                        message: "Jarvis could not confirm speech for that report.",
                      }),
                  ),
                ),
                { "rpc.aggregate": "jarvis" },
              ),
          });
        }),
    };
  }),
);
