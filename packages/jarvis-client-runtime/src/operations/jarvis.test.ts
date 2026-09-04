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
} from "@t3tools/client-runtime/connection";
import * as EnvironmentSupervisor from "@t3tools/client-runtime/connection";
import type { WsRpcProtocolClient, RpcSession } from "@t3tools/client-runtime/rpc";
import {
  executeJarvisInstruction,
  getJarvisProjectVocabulary,
  getJarvisTaskDesk,
  manageJarvisProjectAlias,
  focusJarvisTask,
} from "./jarvis.ts";

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
        kind: "control",
        projectId: ProjectId.make("project-jarvis"),
        utterance: "Jarvis, use Codex Sol to review the current changes.",
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(result.status).toBe("started");
      expect(inputs).toEqual([
        {
          kind: "control",
          projectId: "project-jarvis",
          utterance: "Jarvis, use Codex Sol to review the current changes.",
        },
      ]);
    }),
  );

  it.effect("reads and navigates the authenticated device task desk", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly method: string; readonly input: unknown }> = [];
      const desk = {
        focusedTask: { threadId: ThreadId.make("thread-jarvis") },
        recentTasks: [],
        pendingInteraction: null,
        updatedAt: null,
      } as const;
      const client = {
        [WS_METHODS.jarvisGetTaskDesk]: (input: unknown) =>
          Effect.sync(() => {
            calls.push({ method: WS_METHODS.jarvisGetTaskDesk, input });
            return desk;
          }),
        [WS_METHODS.jarvisFocusTask]: (input: unknown) =>
          Effect.sync(() => {
            calls.push({ method: WS_METHODS.jarvisFocusTask, input });
            return desk;
          }),
        [WS_METHODS.jarvisGetProjectVocabulary]: (input: unknown) =>
          Effect.sync(() => {
            calls.push({ method: WS_METHODS.jarvisGetProjectVocabulary, input });
            return [
              {
                projectId: ProjectId.make("project-jarvis"),
                title: "Jarvis",
                workspaceRoot: "/work/jarvis",
                repositoryNames: ["jarvis"],
                aliases: ["jervis"],
                aliasDetails: [{ alias: "jervis", kind: "user-defined" as const }],
              },
            ];
          }),
        [WS_METHODS.jarvisManageProjectAlias]: (input: unknown) =>
          Effect.sync(() => {
            calls.push({ method: WS_METHODS.jarvisManageProjectAlias, input });
            return { changed: true };
          }),
      } as unknown as WsRpcProtocolClient;
      const target = new PrimaryConnectionTarget({
        environmentId: EnvironmentId.make("environment-jarvis-desk"),
        label: "Jarvis phone",
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

      const result = yield* Effect.all([
        getJarvisTaskDesk(),
        focusJarvisTask({
          threadId: ThreadId.make("thread-one"),
          taskRef: {
            executionNodeId: EnvironmentId.make("environment-jarvis"),
            threadId: ThreadId.make("thread-one"),
          },
        }),
        getJarvisProjectVocabulary(),
        manageJarvisProjectAlias({
          action: "set",
          projectId: ProjectId.make("project-jarvis"),
          alias: "jervis",
          kind: "user-defined",
        }),
      ]).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(result[0].focusedTask).toEqual(desk.focusedTask);
      expect(result[1].focusedTask).toEqual(desk.focusedTask);
      expect(result[2][0]?.aliases).toEqual(["jervis"]);
      expect(result[3].changed).toBe(true);
      expect(calls).toEqual([
        { method: WS_METHODS.jarvisGetTaskDesk, input: {} },
        {
          method: WS_METHODS.jarvisFocusTask,
          input: {
            threadId: "thread-one",
            taskRef: {
              executionNodeId: "environment-jarvis",
              threadId: "thread-one",
            },
          },
        },
        { method: WS_METHODS.jarvisGetProjectVocabulary, input: {} },
        {
          method: WS_METHODS.jarvisManageProjectAlias,
          input: {
            action: "set",
            projectId: "project-jarvis",
            alias: "jervis",
            kind: "user-defined",
          },
        },
      ]);
    }),
  );
});
