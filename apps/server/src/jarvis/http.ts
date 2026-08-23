import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  jarvisNodeCapabilitiesForPreset,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  failEnvironmentOperationForbidden,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { executeWithTaskDesk } from "./executeWithTaskDesk.ts";
import { JarvisManager } from "./Services/JarvisManager.ts";
import { JarvisReportOutbox } from "./Services/JarvisReportOutbox.ts";
import { JarvisTaskDesk } from "./Services/JarvisTaskDesk.ts";
import { JarvisProjectLexicon } from "./Services/JarvisProjectLexicon.ts";
import { buildProjectVocabulary } from "@t3tools/jarvis-core/buildProjectVocabulary";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerConfig from "../config.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

export const jarvisHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "jarvis",
  Effect.fnUntraced(function* (handlers) {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const jarvis = yield* JarvisManager;
    const taskDesk = yield* JarvisTaskDesk;
    const projectLexicon = yield* JarvisProjectLexicon;
    const providers = yield* ProviderRegistry;
    const serverConfig = yield* ServerConfig.ServerConfig;
    const jarvisReportOutbox = yield* JarvisReportOutbox;
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    const executionNodeId = yield* serverEnvironment.getEnvironmentId;

    return handlers
      .handle(
        "jarvisProviders",
        Effect.fn("environment.orchestration.jarvisProviders")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* providers.getProviders;
        }),
      )
      .handle(
        "jarvisProjectVocabulary",
        Effect.fn("environment.orchestration.jarvisProjectVocabulary")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* Effect.all({
            shell: projectionSnapshotQuery.getShellSnapshot(),
            aliases: projectLexicon.list(),
          }).pipe(
            Effect.map(({ shell, aliases }) =>
              buildProjectVocabulary({ projects: shell.projects, aliases }),
            ),
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_snapshot_failed", cause),
            ),
          );
        }),
      )
      .handle(
        "jarvisManageProjectAlias",
        Effect.fn("environment.orchestration.jarvisManageProjectAlias")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const project = yield* projectionSnapshotQuery
            .getProjectShellById(args.payload.projectId)
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
          if (Option.isNone(project)) return yield* failEnvironmentNotFound("project_not_found");
          const changed =
            args.payload.action === "set"
              ? yield* projectLexicon.learn(args.payload).pipe(
                  Effect.as(true),
                  Effect.catch((cause) =>
                    failEnvironmentInternal("jarvis_execution_failed", cause),
                  ),
                )
              : yield* projectLexicon
                  .forget(args.payload)
                  .pipe(
                    Effect.catch((cause) =>
                      failEnvironmentInternal("jarvis_execution_failed", cause),
                    ),
                  );
          return { changed };
        }),
      )
      .handle(
        "jarvis",
        Effect.fn("environment.orchestration.jarvis")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const session = yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          if (!jarvisNodeCapabilitiesForPreset(serverConfig.jarvisNodePreset ?? "full").execution) {
            return yield* failEnvironmentOperationForbidden("jarvis_execution_unavailable");
          }
          if (
            args.payload.projectRef !== undefined &&
            (args.payload.projectRef.nodeId !== executionNodeId ||
              (args.payload.projectId !== undefined &&
                args.payload.projectId !== args.payload.projectRef.projectId))
          ) {
            return yield* failEnvironmentInvalidRequest("jarvis_target_mismatch");
          }

          // A qualified project reference already identifies the target. Do
          // not resolve the legacy unscoped project fallback first: doing so
          // would reject a valid routed request whenever this host has more
          // than one local project.
          const requestedProjectId = args.payload.projectRef?.projectId ?? args.payload.projectId;
          const projects =
            requestedProjectId === undefined
              ? yield* projectionSnapshotQuery.getShellSnapshot().pipe(
                  Effect.catch((cause) =>
                    failEnvironmentInternal("orchestration_snapshot_failed", cause),
                  ),
                  Effect.map((snapshot) => snapshot.projects),
                )
              : [];
          if (requestedProjectId === undefined && projects.length > 1) {
            return yield* failEnvironmentNotFound("project_required");
          }
          const projectId = requestedProjectId ?? projects[0]?.id;
          if (projectId === undefined) {
            return yield* failEnvironmentNotFound("project_not_found");
          }
          if (args.payload.requestMetadata !== undefined) {
            yield* jarvisReportOutbox
              .register(session.sessionId, args.payload.requestMetadata.origin?.originInteractionId)
              .pipe(
                Effect.catch((cause) => failEnvironmentInternal("jarvis_execution_failed", cause)),
              );
          }
          return yield* executeWithTaskDesk(jarvis, taskDesk, session.sessionId, {
            projectId,
            executionNodeId,
            utterance: args.payload.utterance,
            ...(args.payload.requestMetadata === undefined
              ? {}
              : { requestMetadata: args.payload.requestMetadata }),
            ...(args.payload.contextThreadId === undefined
              ? {}
              : { contextThreadId: args.payload.contextThreadId }),
            ...(args.payload.referenceThreadId === undefined
              ? {}
              : { referenceThreadId: args.payload.referenceThreadId }),
            ...(args.payload.continueContext === undefined
              ? {}
              : { continueContext: args.payload.continueContext }),
            ...(args.payload.modelSelection === undefined
              ? {}
              : { modelSelection: args.payload.modelSelection }),
          }).pipe(
            Effect.map((result) => ({ projectId, result })),
            Effect.catchTags({
              JarvisProjectNotFoundError: () => failEnvironmentNotFound("project_not_found"),
              JarvisRequestConflictError: () =>
                failEnvironmentInvalidRequest("jarvis_request_conflict"),
              OrchestrationCommandIdConflictError: () =>
                failEnvironmentInvalidRequest("jarvis_request_conflict"),
              PersistenceSqlError: (cause) =>
                failEnvironmentInternal("jarvis_execution_failed", cause),
              PersistenceDecodeError: (cause) =>
                failEnvironmentInternal("jarvis_execution_failed", cause),
              OrchestrationCommandInvariantError: (cause) =>
                failEnvironmentInternal("jarvis_execution_failed", cause),
              OrchestrationCommandPreviouslyRejectedError: (cause) =>
                failEnvironmentInternal("jarvis_execution_failed", cause),
              OrchestrationProjectorDecodeError: (cause) =>
                failEnvironmentInternal("jarvis_execution_failed", cause),
              OrchestrationListenerCallbackError: (cause) =>
                failEnvironmentInternal("jarvis_execution_failed", cause),
            }),
          );
        }),
      )
      .handle(
        "jarvisTaskDesk",
        Effect.fn("environment.orchestration.jarvisTaskDesk")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const session = yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* taskDesk
            .get(session.sessionId)
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "jarvisNavigateTaskDesk",
        Effect.fn("environment.orchestration.jarvisNavigateTaskDesk")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const session = yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* taskDesk
            .navigate({ sessionId: session.sessionId, navigation: args.payload })
            .pipe(
              Effect.catch((cause) => failEnvironmentInternal("jarvis_execution_failed", cause)),
            );
        }),
      );
  }),
);
