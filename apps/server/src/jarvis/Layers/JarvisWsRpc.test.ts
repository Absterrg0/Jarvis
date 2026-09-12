import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  JarvisExecutionError,
  JarvisLiveVoiceInvalidInputError,
  JarvisLiveVoiceUnavailableError,
  JarvisWsRpcGroup,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  jarvisRpcScopeExtension,
  runJarvisVoiceLiveStart,
  toJarvisExecuteClientError,
  toJarvisInterpretClientError,
  toJarvisVoiceLiveStartClientError,
  validateJarvisFocusTaskIdentity,
} from "./JarvisWsRpc.ts";
import {
  JarvisLiveVoice,
  unavailableLayer as unavailableLiveVoiceLayer,
} from "../Services/JarvisLiveVoice.ts";

describe("Jarvis WebSocket RPC extension", () => {
  it("declares exactly one scope for every product handler", () => {
    expect(new Set(Object.keys(jarvisRpcScopeExtension))).toEqual(
      new Set(JarvisWsRpcGroup.requests.keys()),
    );
  });

  it("keeps operation and read scopes exact", () => {
    expect(jarvisRpcScopeExtension[WS_METHODS.jarvisExecute]).toBe(AuthOrchestrationOperateScope);
    expect(jarvisRpcScopeExtension[WS_METHODS.jarvisGetTaskDesk]).toBe(AuthOrchestrationReadScope);
    expect(jarvisRpcScopeExtension[WS_METHODS.jarvisManageProjectAlias]).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(jarvisRpcScopeExtension[WS_METHODS.subscribeJarvisPresentation]).toBe(
      AuthOrchestrationReadScope,
    );
    expect(jarvisRpcScopeExtension[WS_METHODS.jarvisVoiceLiveStart]).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it.effect("delegates live voice sessions on a preset that offers voice", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const liveVoice = {
        createSession: () => {
          calls.push("create");
          return Effect.succeed({
            sessionId: "live_1",
            sdpAnswer: "v=0\r\ns=answer\r\n",
            model: "gpt-live-1",
            voice: "marin",
          });
        },
      };

      // Live voice is preset-gated and must still start on Full and
      // Controller, because it does not use local voice compute at all.
      const result = yield* runJarvisVoiceLiveStart(
        { sdpOffer: "v=0\r\ns=offer\r\n" },
        { presetOffersVoice: true, liveVoice },
      );
      expect(result.sessionId).toBe("live_1");
      expect(calls).toEqual(["create"]);

      const gated = yield* runJarvisVoiceLiveStart(
        { sdpOffer: "v=0\r\ns=offer\r\n" },
        { presetOffersVoice: false, liveVoice },
      ).pipe(Effect.flip);
      expect(gated).toMatchObject({
        _tag: "JarvisLiveVoiceUnavailableError",
        reason: "capability-unavailable",
      });
      expect(calls).toEqual(["create"]);
    }),
  );

  it("keeps internal live voice detail off the client-facing error", () => {
    const typed = new JarvisLiveVoiceUnavailableError({
      reason: "not-configured",
      message: "Add an OpenAI API key on this node to use live voice.",
    });
    expect(toJarvisVoiceLiveStartClientError(typed)).toBe(typed);

    const invalid = new JarvisLiveVoiceInvalidInputError({ message: "empty offer" });
    expect(toJarvisVoiceLiveStartClientError(invalid)).toBe(invalid);

    const leaked = toJarvisVoiceLiveStartClientError(
      new Error("HTTP 401: invalid api key sk-secret at /home/user/settings.json"),
    );
    expect(leaked).toMatchObject({
      _tag: "JarvisLiveVoiceRuntimeError",
      message: "Live voice could not start on this Jarvis node.",
    });
    expect(leaked.message).not.toContain("sk-secret");
    expect(leaked.message).not.toContain("settings.json");
  });

  it.effect("ships an unavailable live voice service until a node composes a runtime", () =>
    Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        const service = yield* JarvisLiveVoice;
        return yield* service.createSession({ sdpOffer: "v=0\r\ns=offer\r\n" });
      }).pipe(Effect.provide(unavailableLiveVoiceLayer), Effect.flip);
      expect(result).toMatchObject({
        _tag: "JarvisLiveVoiceUnavailableError",
        reason: "capability-unavailable",
      });
    }),
  );

  it("rejects client focus identities for another node or thread", () => {
    const nodeId = EnvironmentId.make("node-one");
    const threadId = ThreadId.make("thread-one");
    expect(
      validateJarvisFocusTaskIdentity(
        {
          threadId,
          taskRef: { executionNodeId: nodeId, threadId: ThreadId.make("thread-other") },
        },
        nodeId,
      ),
    ).toMatchObject({ code: "node-mismatch" });
    expect(
      validateJarvisFocusTaskIdentity(
        {
          threadId,
          taskRef: { executionNodeId: EnvironmentId.make("node-other"), threadId },
        },
        nodeId,
      ),
    ).toMatchObject({ code: "node-mismatch" });
    expect(
      validateJarvisFocusTaskIdentity(
        { threadId, taskRef: { executionNodeId: nodeId, threadId } },
        nodeId,
      ),
    ).toBeNull();
  });

  it("keeps internal execute detail off the client-facing error", () => {
    // A persistence-shaped failure must not leak paths or SQL to controllers.
    const leaked = toJarvisExecuteClientError(
      new Error("SQLITE_CORRUPT: database disk image is malformed at /data/state.sqlite"),
    );
    expect(leaked).toMatchObject({
      _tag: "JarvisExecutionError",
      code: "dispatch-failed",
      message: "Jarvis could not start the requested task.",
    });
    expect(leaked.message).not.toContain("/data/state.sqlite");

    const interpretLeaked = toJarvisInterpretClientError(new Error("provider blew up: secret=x"));
    expect(interpretLeaked).toMatchObject({
      _tag: "JarvisExecutionError",
      code: "dispatch-failed",
      message: "Jarvis could not interpret that request.",
    });
    expect(interpretLeaked.message).not.toContain("secret=x");
  });

  it("recognizes typed errors that crossed a serialization boundary", () => {
    // Regression: instanceof misses decoded/JSON-round-tripped errors, which
    // misclassified them as dispatch-failed. Schema.is matches structurally.
    const typed = new JarvisExecutionError({
      code: "execution-unavailable",
      message: "This ARIS node is configured as a controller and cannot execute tasks.",
    });
    const roundTripped = JSON.parse(JSON.stringify(typed)) as unknown;
    expect(Object.getPrototypeOf(roundTripped)).not.toBe(JarvisExecutionError.prototype);
    const mapped = toJarvisExecuteClientError(roundTripped);
    expect(mapped).toMatchObject({
      _tag: "JarvisExecutionError",
      code: "execution-unavailable",
    });
  });
});
