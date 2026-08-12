import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { executeJarvisInstruction } from "./jarvis.ts";

describe("Jarvis operations", () => {
  it.effect("routes an instruction through the active environment", () =>
    Effect.gen(function* () {
      const inputs: unknown[] = [];
      const client = {
        [WS_METHODS.jarvisExecute]: (input: unknown) =>
          Effect.sync(() => {
            inputs.push(input);
            return {
              status: "started" as const,
              threadId: ThreadId.make("thread-jarvis"),
              objective: "Review the current changes.",
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-5.6-sol",
              },
            };
          }),
      } as unknown as WsRpcProtocolClient;
      const target = new PrimaryConnectionTarget({
        environmentId: EnvironmentId.make("environment-jarvis"),
        label: "Jarvis laptop",
        httpBaseUrl: "http://127.0.0.1:3002",
        wsBaseUrl: "ws://127.0.0.1:3002",
      });
      const session: RpcSession = {
        client,
        initialConfig: Effect.never,
        ready: Effect.void,
        probe: Effect.void,
        closed: Effect.never,
      };
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session)),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });

      const result = yield* executeJarvisInstruction({
        projectId: ProjectId.make("project-jarvis"),
        utterance: "Jarvis, use Codex Sol to review the current changes.",
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(result.status).toBe("started");
      expect(inputs).toEqual([
        {
          projectId: "project-jarvis",
          utterance: "Jarvis, use Codex Sol to review the current changes.",
        },
      ]);
    }),
  );
});
