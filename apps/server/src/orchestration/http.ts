import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { projectThreadDetailSnapshot } from "./ActivityPayloadProjection.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { executeWithTaskDesk } from "../jarvis/executeWithTaskDesk.ts";
import { JarvisManager } from "../jarvis/Services/JarvisManager.ts";
import { JarvisReportOutbox } from "../jarvis/Services/JarvisReportOutbox.ts";
import { JarvisTaskDesk } from "../jarvis/Services/JarvisTaskDesk.ts";
import { JarvisProjectLexicon } from "../jarvis/Services/JarvisProjectLexicon.ts";
import { buildProjectVocabulary } from "../jarvis/buildProjectVocabulary.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

export const orchestrationHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "orchestration",
  Effect.fnUntraced(function* (handlers) {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const jarvis = yield* JarvisManager;
    const taskDesk = yield* JarvisTaskDesk;
    const projectLexicon = yield* JarvisProjectLexicon;
    const providers = yield* ProviderRegistry;
    // The project CLI mounts this route group without the full server runtime;
    // it never accepts Jarvis work, so keep the outbox optional for that legacy
    // mount while registering routed requests on production hosts.
    const jarvisReportOutbox = yield* Effect.serviceOption(JarvisReportOutbox);
    // The project CLI mounts this route group without the full server
    // environment because it never invokes Jarvis. Keep that legacy mount
    // valid while production hosts still provide the node identity.
    const executionNodeId = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment).pipe(
      Effect.flatMap((serverEnvironment) =>
        Option.isSome(serverEnvironment)
          ? serverEnvironment.value.getEnvironmentId.pipe(Effect.map(Option.some))
          : Effect.succeed(Option.none()),
      ),
    );

    return handlers
      .handle(
        "jarvisProviders",
        Effect.fn("environment.orchestration.jarvisProviders")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* providers.getProviders.pipe(
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_snapshot_failed", cause),
            ),
          );
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
        "snapshot",
        Effect.fn("environment.orchestration.snapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          // Serve the lightweight command read model (thread bodies empty)
          // instead of the fully hydrated snapshot. Hydrating every message
          // and activity payload in the database has OOM-killed servers, and
          // the route's only consumer (the project CLI) reads projects alone —
          // UI clients load the shell and per-thread snapshots instead.
          return yield* projectionSnapshotQuery
            .getCommandReadModel()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "shellSnapshot",
        Effect.fn("environment.orchestration.shellSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* projectionSnapshotQuery
            .getShellSnapshot()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "threadSnapshot",
        Effect.fn("environment.orchestration.threadSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const snapshot = yield* projectionSnapshotQuery
            .getThreadDetailSnapshot(
              args.params.threadId,
              args.payload.turnLimit === undefined
                ? undefined
                : {
                    turnLimit: args.payload.turnLimit,
                    ...(args.payload.beforeCursor !== undefined
                      ? { beforeCursor: args.payload.beforeCursor }
                      : {}),
                  },
            )
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
              ),
            );
          if (Option.isNone(snapshot)) {
            return yield* failEnvironmentNotFound("thread_not_found");
          }
          return projectThreadDetailSnapshot(snapshot.value);
        }),
      )
      .handle(
        "dispatch",
        Effect.fn("environment.orchestration.dispatch")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const normalizedCommand = yield* normalizeDispatchCommand(args.payload).pipe(
            Effect.catch(() => failEnvironmentInvalidRequest("invalid_command")),
          );
          return yield* orchestrationEngine
            .dispatch(normalizedCommand)
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_dispatch_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "jarvis",
        Effect.fn("environment.orchestration.jarvis")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const session = yield* requireEnvironmentScope(AuthOrchestrationOperateScope);

          if (
            args.payload.projectRef !== undefined &&
            (Option.isNone(executionNodeId) ||
              args.payload.projectRef.nodeId !== executionNodeId.value ||
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

          if (args.payload.requestMetadata !== undefined && Option.isSome(jarvisReportOutbox)) {
            yield* jarvisReportOutbox.value
              .register(session.sessionId, args.payload.requestMetadata.origin?.originInteractionId)
              .pipe(
                Effect.catch((cause) => failEnvironmentInternal("jarvis_execution_failed", cause)),
              );
          }

          return yield* executeWithTaskDesk(jarvis, taskDesk, session.sessionId, {
            projectId,
            ...(Option.isNone(executionNodeId) ? {} : { executionNodeId: executionNodeId.value }),
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
