// @effect-diagnostics multipleEffectProvide:off - this test composes isolated stub layers around one effect.
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ensureCirceConversationsProject } from "./conversationsProject.ts";

const testCryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(size),
    digest: (_algorithm, data) => Effect.succeed(data),
  }),
);

describe("ensureCirceConversationsProject", () => {
  it.effect("fails without creating the project when the guidance file cannot be written", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const root = path.join(config.baseDir, "conversations");
      yield* fs.makeDirectory(root, { recursive: true });
      yield* fs.makeDirectory(path.join(root, "AGENTS.md"), { recursive: true });

      let dispatchCalls = 0;
      const projectionsLayer = Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]);
      const orchestrationLayer = Layer.succeed(OrchestrationEngine.OrchestrationEngineService, {
        dispatch: () =>
          Effect.sync(() => {
            dispatchCalls += 1;
            return { sequence: 1 };
          }),
      } as unknown as OrchestrationEngine.OrchestrationEngineService["Service"]);
      const exit = yield* Effect.exit(
        ensureCirceConversationsProject.pipe(
          Effect.provide(orchestrationLayer),
          Effect.provide(projectionsLayer),
          Effect.provide(testCryptoLayer),
        ),
      );
      expect(exit._tag).toBe("Failure");
      expect(dispatchCalls).toBe(0);
    }).pipe(
      Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "circe-conv-fail-" })),
      Effect.provide(NodeServices.layer),
    ),
  );
});
