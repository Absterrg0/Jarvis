import { jarvisNodeCapabilitiesForPreset } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { ProviderExecutionPolicy } from "../provider/Services/ProviderExecutionPolicy.ts";

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  return ProviderExecutionPolicy.of({
    canExecute: Effect.map(
      Effect.succeed(config.jarvisNodePreset ?? "full"),
      (preset) => jarvisNodeCapabilitiesForPreset(preset).execution,
    ),
  });
});

export const layer = Layer.effect(ProviderExecutionPolicy, make);
