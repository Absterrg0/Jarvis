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
import { JarvisManager } from "../jarvis/Services/JarvisManager.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";

export const orchestrationHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "orchestration",
  Effect.fnUntraced(function* (handlers) {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const jarvis = yield* JarvisManager;
    const providers = yield* ProviderRegistry;

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
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);

          const projects =
            args.payload.projectId === undefined
              ? yield* projectionSnapshotQuery.getShellSnapshot().pipe(
                  Effect.catch((cause) =>
                    failEnvironmentInternal("orchestration_snapshot_failed", cause),
                  ),
                  Effect.map((snapshot) => snapshot.projects),
                )
              : [];
          if (args.payload.projectId === undefined && projects.length > 1) {
            return yield* failEnvironmentNotFound("project_required");
          }
          const projectId = args.payload.projectId ?? projects[0]?.id;
          if (projectId === undefined) {
            return yield* failEnvironmentNotFound("project_not_found");
          }

          return yield* jarvis
            .execute({
              projectId,
              utterance: args.payload.utterance,
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
            })
            .pipe(
              Effect.map((result) => ({ projectId, result })),
              Effect.catchTags({
                JarvisProjectNotFoundError: () => failEnvironmentNotFound("project_not_found"),
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
      );
  }),
);
