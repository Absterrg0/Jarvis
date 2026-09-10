import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ProviderExecutionPolicy from "../provider/Services/ProviderExecutionPolicy.ts";
import * as JarvisProviderExecutionPolicy from "./ProviderExecutionPolicy.ts";

const baseConfigLayer = ServerConfig.layerTest(process.cwd(), process.cwd()).pipe(
  Layer.provide(NodeServices.layer),
);

const policyLayer = (preset: "full" | "controller" | "headless") =>
  JarvisProviderExecutionPolicy.layer.pipe(
    Layer.provide(
      Layer.effect(
        ServerConfig.ServerConfig,
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          return ServerConfig.ServerConfig.of({ ...config, jarvisNodePreset: preset });
        }).pipe(Effect.provide(baseConfigLayer)),
      ),
    ),
  );

describe("Jarvis provider execution policy", () => {
  it.effect("denies provider execution for controller nodes", () =>
    Effect.gen(function* () {
      const policy = yield* ProviderExecutionPolicy.ProviderExecutionPolicy;
      assert.isFalse(yield* policy.canExecute);
    }).pipe(Effect.provide(policyLayer("controller"))),
  );

  it.effect("allows provider execution for full and headless nodes", () =>
    Effect.forEach(
      ["full", "headless"] as const,
      (preset) =>
        Effect.gen(function* () {
          const policy = yield* ProviderExecutionPolicy.ProviderExecutionPolicy;
          assert.isTrue(yield* policy.canExecute);
        }).pipe(Effect.provide(policyLayer(preset))),
      { discard: true },
    ),
  );
});
