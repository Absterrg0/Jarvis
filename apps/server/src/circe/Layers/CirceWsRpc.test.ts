import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  CirceExecutionError,
  CirceLiveVoiceInvalidInputError,
  CirceLiveVoiceUnavailableError,
  CirceWsRpcGroup,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  circeRpcScopeExtension,
  groundCirceQuickActionProposal,
  runCirceVoiceLiveStart,
  toCirceExecuteClientError,
  toCirceInterpretClientError,
  toCirceVoiceLiveStartClientError,
  validateCirceFocusTaskIdentity,
} from "./CirceWsRpc.ts";
import {
  CirceLiveVoice,
  unavailableLayer as unavailableLiveVoiceLayer,
} from "../Services/CirceLiveVoice.ts";

describe("Circe WebSocket RPC extension", () => {
  it("declares exactly one scope for every product handler", () => {
    expect(new Set(Object.keys(circeRpcScopeExtension))).toEqual(
      new Set(CirceWsRpcGroup.requests.keys()),
    );
  });

  it("keeps operation and read scopes exact", () => {
    expect(circeRpcScopeExtension[WS_METHODS.circeExecute]).toBe(AuthOrchestrationOperateScope);
    expect(circeRpcScopeExtension[WS_METHODS.circeGetTaskDesk]).toBe(AuthOrchestrationReadScope);
    expect(circeRpcScopeExtension[WS_METHODS.circeManageProjectAlias]).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(circeRpcScopeExtension[WS_METHODS.subscribeCircePresentation]).toBe(
      AuthOrchestrationReadScope,
    );
    expect(circeRpcScopeExtension[WS_METHODS.circeVoiceLiveStart]).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(circeRpcScopeExtension[WS_METHODS.circeVoiceLiveRenew]).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it.effect("delegates live voice sessions on a preset that offers voice", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const liveVoice = {
        releaseSession: () => Effect.void,
        renewSession: () => Effect.void,
        sweepExpired: () => Effect.void,
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
      const result = yield* runCirceVoiceLiveStart(
        { sdpOffer: "v=0\r\ns=offer\r\n" },
        { presetOffersVoice: true, liveVoice },
      );
      expect(result.sessionId).toBe("live_1");
      expect(calls).toEqual(["create"]);

      const gated = yield* runCirceVoiceLiveStart(
        { sdpOffer: "v=0\r\ns=offer\r\n" },
        { presetOffersVoice: false, liveVoice },
      ).pipe(Effect.flip);
      expect(gated).toMatchObject({
        _tag: "CirceLiveVoiceUnavailableError",
        reason: "capability-unavailable",
      });
      expect(calls).toEqual(["create"]);
    }),
  );

  it("keeps internal live voice detail off the client-facing error", () => {
    const typed = new CirceLiveVoiceUnavailableError({
      reason: "not-configured",
      message: "Add an OpenAI API key on this node to use live voice.",
    });
    expect(toCirceVoiceLiveStartClientError(typed)).toBe(typed);

    const invalid = new CirceLiveVoiceInvalidInputError({ message: "empty offer" });
    expect(toCirceVoiceLiveStartClientError(invalid)).toBe(invalid);

    const leaked = toCirceVoiceLiveStartClientError(
      new Error("HTTP 401: invalid api key sk-secret at /home/user/settings.json"),
    );
    expect(leaked).toMatchObject({
      _tag: "CirceLiveVoiceRuntimeError",
      message: "Live voice could not start on this Circe node.",
    });
    expect(leaked.message).not.toContain("sk-secret");
    expect(leaked.message).not.toContain("settings.json");
  });

  it.effect("ships an unavailable live voice service until a node composes a runtime", () =>
    Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        const service = yield* CirceLiveVoice;
        return yield* service.createSession({ sdpOffer: "v=0\r\ns=offer\r\n" });
      }).pipe(Effect.provide(unavailableLiveVoiceLayer), Effect.flip);
      expect(result).toMatchObject({
        _tag: "CirceLiveVoiceUnavailableError",
        reason: "capability-unavailable",
      });
    }),
  );

  it("rejects client focus identities for another node or thread", () => {
    const nodeId = EnvironmentId.make("node-one");
    const threadId = ThreadId.make("thread-one");
    expect(
      validateCirceFocusTaskIdentity(
        {
          threadId,
          taskRef: { executionNodeId: nodeId, threadId: ThreadId.make("thread-other") },
        },
        nodeId,
      ),
    ).toMatchObject({ code: "node-mismatch" });
    expect(
      validateCirceFocusTaskIdentity(
        {
          threadId,
          taskRef: { executionNodeId: EnvironmentId.make("node-other"), threadId },
        },
        nodeId,
      ),
    ).toMatchObject({ code: "node-mismatch" });
    expect(
      validateCirceFocusTaskIdentity(
        { threadId, taskRef: { executionNodeId: nodeId, threadId } },
        nodeId,
      ),
    ).toBeNull();
  });

  it("keeps internal execute detail off the client-facing error", () => {
    // A persistence-shaped failure must not leak paths or SQL to controllers.
    const leaked = toCirceExecuteClientError(
      new Error("SQLITE_CORRUPT: database disk image is malformed at /data/state.sqlite"),
    );
    expect(leaked).toMatchObject({
      _tag: "CirceExecutionError",
      code: "dispatch-failed",
      message: "Circe could not start the requested task.",
    });
    expect(leaked.message).not.toContain("/data/state.sqlite");

    const interpretLeaked = toCirceInterpretClientError(new Error("provider blew up: secret=x"));
    expect(interpretLeaked).toMatchObject({
      _tag: "CirceExecutionError",
      code: "dispatch-failed",
      message: "Circe could not interpret that request.",
    });
    expect(interpretLeaked.message).not.toContain("secret=x");
  });

  it("grounds a proposed website launch in the source utterance", () => {
    const proposal = (website: string) => ({
      action: "open-website" as const,
      refs: [],
      model: null,
      effort: null,
      answer: null,
      website,
    });
    expect(groundCirceQuickActionProposal(proposal("YouTube"), "Open YouTube")).toMatchObject({
      action: "open-website",
      website: "YouTube",
    });
    expect(
      groundCirceQuickActionProposal(proposal("https://example.com"), "open https://example.com"),
    ).toMatchObject({ action: "open-website", website: "https://example.com" });
    // Regression: an ungrounded target never reaches a client launcher.
    expect(
      groundCirceQuickActionProposal(proposal("https://evil.example"), "Open YouTube"),
    ).toMatchObject({ action: "unsupported" });
  });

  it("downgrades a quick action that carries refs instead of dropping work", () => {
    const ref = {
      span: { start: 0, end: 7, text: "YouTube" },
      role: "destination" as const,
      value: "youtube",
    };
    expect(
      groundCirceQuickActionProposal(
        {
          action: "open-website" as const,
          refs: [ref],
          model: null,
          effort: null,
          answer: null,
          website: "YouTube",
        },
        "Open YouTube and find a video",
      ),
    ).toMatchObject({ action: "unsupported", refs: [] });
    expect(
      groundCirceQuickActionProposal(
        {
          action: "lookup" as const,
          refs: [ref],
          model: null,
          effort: null,
          answer: null,
          lookup: { kind: "weather" as const, location: "Ahmedabad", day: "now" as const },
        },
        "Weather in Ahmedabad and start the auth task",
      ),
    ).toMatchObject({ action: "unsupported", refs: [] });
  });

  it("recognizes typed errors that crossed a serialization boundary", () => {
    // Regression: instanceof misses decoded/JSON-round-tripped errors, which
    // misclassified them as dispatch-failed. Schema.is matches structurally.
    const typed = new CirceExecutionError({
      code: "execution-unavailable",
      message: "This Circe node is configured as a controller and cannot execute tasks.",
    });
    const roundTripped = JSON.parse(JSON.stringify(typed)) as unknown;
    expect(Object.getPrototypeOf(roundTripped)).not.toBe(CirceExecutionError.prototype);
    const mapped = toCirceExecuteClientError(roundTripped);
    expect(mapped).toMatchObject({
      _tag: "CirceExecutionError",
      code: "execution-unavailable",
    });
  });
});
