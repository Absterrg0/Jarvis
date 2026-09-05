import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  JarvisVoiceSynthesizeInput,
  JarvisVoiceTranscribeInput,
  jarvisNodeCapabilitiesForPreset,
  JarvisWsRpcGroup,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  jarvisRpcScopeExtension,
  runJarvisVoiceSynthesis,
  runJarvisVoiceTranscription,
  validateJarvisFocusTaskIdentity,
} from "./JarvisWsRpc.ts";
import { JarvisVoiceCompute, unavailableLayer } from "../Services/JarvisVoiceCompute.ts";

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
    expect(jarvisRpcScopeExtension[WS_METHODS.jarvisVoiceTranscribe]).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(jarvisRpcScopeExtension[WS_METHODS.jarvisVoiceSynthesize]).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it.effect("delegates authenticated voice operations only on a voice-capable node", () =>
    Effect.gen(function* () {
      const descriptor: ExecutionEnvironmentDescriptor = {
        environmentId: EnvironmentId.make("voice-node"),
        label: "Voice node",
        platform: { os: "linux", arch: "x64" },
        serverVersion: "0.0.47",
        capabilities: {
          repositoryIdentity: true,
          jarvisNode: jarvisNodeCapabilitiesForPreset("controller"),
        },
      };
      const transcribeInput: JarvisVoiceTranscribeInput = {
        format: "pcm-s16le",
        audioBase64: "AAA=",
        sampleRate: 16_000,
        channels: 1,
      };
      const synthesizeInput: JarvisVoiceSynthesizeInput = { text: "Task finished." };
      const calls: string[] = [];
      const dependencies = {
        getDescriptor: Effect.succeed(descriptor),
        voiceCompute: {
          transcribe: () => {
            calls.push("transcribe");
            return Effect.succeed({ text: "open the project" });
          },
          synthesize: () => {
            calls.push("synthesize");
            return Effect.succeed({ wavBase64: "AAAA" });
          },
        },
      };

      expect(yield* runJarvisVoiceTranscription(transcribeInput, dependencies)).toEqual({
        text: "open the project",
      });
      expect(yield* runJarvisVoiceSynthesis(synthesizeInput, dependencies)).toEqual({
        wavBase64: "AAAA",
      });
      expect(calls).toEqual(["transcribe", "synthesize"]);

      const unavailable = yield* runJarvisVoiceSynthesis(synthesizeInput, {
        ...dependencies,
        getDescriptor: Effect.succeed({
          ...descriptor,
          // Headless nodes execute work but offer no voice compute, so the
          // voiceCompute gate (not just the jarvisNode presence) is exercised.
          capabilities: {
            repositoryIdentity: true,
            jarvisNode: jarvisNodeCapabilitiesForPreset("headless"),
          },
        }),
      }).pipe(Effect.flip);
      expect(unavailable).toMatchObject({
        _tag: "JarvisVoiceUnavailableError",
        operation: "synthesize",
      });
    }),
  );

  it.effect("ships an unavailable service until a node composes a real runtime", () =>
    Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        const service = yield* JarvisVoiceCompute;
        return yield* service.synthesize({ text: "hello" });
      }).pipe(Effect.provide(unavailableLayer), Effect.flip);
      expect(result).toMatchObject({
        _tag: "JarvisVoiceUnavailableError",
        operation: "synthesize",
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
});
