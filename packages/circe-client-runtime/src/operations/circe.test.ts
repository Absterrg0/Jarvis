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
import * as Stream from "effect/Stream";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import * as EnvironmentSupervisor from "@t3tools/client-runtime/connection";
import type { WsRpcProtocolClient, RpcSession } from "@t3tools/client-runtime/rpc";
import {
  cancelCirceRequest,
  executeCirceInstruction,
  interpretCirceInstruction,
  getCirceProjectVocabulary,
  getCirceTaskDesk,
  manageCirceProjectAlias,
  focusCirceTask,
} from "./circe.ts";

describe("Circe operations", () => {
  it.effect("routes an instruction through the active environment", () =>
    Effect.gen(function* () {
      const inputs: unknown[] = [];
      const client = {
        [WS_METHODS.circeExecute]: (input: unknown) =>
          Effect.sync(() => {
            inputs.push(input);
            return {
              status: "started" as const,
              threadId: ThreadId.make("thread-circe"),
              objective: "Review the current changes.",
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-5.6-sol",
              },
            };
          }),
      } as unknown as WsRpcProtocolClient;
      const target = new PrimaryConnectionTarget({
        environmentId: EnvironmentId.make("environment-circe"),
        label: "Circe laptop",
        httpBaseUrl: "http://127.0.0.1:3002",
        wsBaseUrl: "ws://127.0.0.1:3002",
      });
      const session: RpcSession = {
        client,
        initialConfig: Effect.never,
        subscribeServerConfig: () => Stream.empty,
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

      const result = yield* executeCirceInstruction({
        kind: "control",
        projectId: ProjectId.make("project-beacon"),
        utterance: "Circe, use Codex Sol to review the current changes.",
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(result.status).toBe("started");
      expect(inputs).toEqual([
        {
          kind: "control",
          projectId: "project-beacon",
          utterance: "Circe, use Codex Sol to review the current changes.",
        },
      ]);
    }),
  );

  it.effect("proposes one typed inference with untrusted evidence and no dispatch", () =>
    Effect.gen(function* () {
      const inputs: unknown[] = [];
      const client = {
        [WS_METHODS.circeInterpret]: (input: unknown) =>
          Effect.sync(() => {
            inputs.push(input);
            return { action: "start", refs: [], model: null, effort: null, answer: null };
          }),
      } as unknown as WsRpcProtocolClient;
      const target = new PrimaryConnectionTarget({
        environmentId: EnvironmentId.make("environment-circe-interpret"),
        label: "Circe laptop",
        httpBaseUrl: "http://127.0.0.1:3002",
        wsBaseUrl: "ws://127.0.0.1:3002",
      });
      const session: RpcSession = {
        client,
        initialConfig: Effect.never,
        subscribeServerConfig: () => Stream.empty,
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

      const result = yield* interpretCirceInstruction({
        utterance: "Check PRs in Rivvl",
        projects: [{ title: "Rivvl", names: ["Rivvl"] }],
        tasks: [],
        providers: [{ name: "Codex" }],
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(result).toMatchObject({ action: "start" });
      expect(inputs).toEqual([
        {
          utterance: "Check PRs in Rivvl",
          projects: [{ title: "Rivvl", names: ["Rivvl"] }],
          tasks: [],
          providers: [{ name: "Codex" }],
        },
      ]);
    }),
  );

  it.effect("cancels one request by its exact identity without touching execution", () =>
    Effect.gen(function* () {
      const inputs: unknown[] = [];
      const client = {
        [WS_METHODS.circeCancelRequest]: (input: unknown) =>
          Effect.sync(() => {
            inputs.push(input);
            return { status: "cancelled" as const, requestId: "request-cancel-1" };
          }),
      } as unknown as WsRpcProtocolClient;
      const target = new PrimaryConnectionTarget({
        environmentId: EnvironmentId.make("environment-circe-cancel"),
        label: "Circe laptop",
        httpBaseUrl: "http://127.0.0.1:3002",
        wsBaseUrl: "ws://127.0.0.1:3002",
      });
      const session: RpcSession = {
        client,
        initialConfig: Effect.never,
        subscribeServerConfig: () => Stream.empty,
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

      const result = yield* cancelCirceRequest({
        requestId: "request-cancel-1",
        origin: {
          originNodeId: EnvironmentId.make("environment-circe-cancel"),
          originInteractionId: "interaction-1",
        },
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(result).toEqual({ status: "cancelled", requestId: "request-cancel-1" });
      expect(inputs).toEqual([
        {
          requestId: "request-cancel-1",
          origin: {
            originNodeId: "environment-circe-cancel",
            originInteractionId: "interaction-1",
          },
        },
      ]);
    }),
  );

  it.effect("reads and navigates the authenticated device task desk", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly method: string; readonly input: unknown }> = [];
      const desk = {
        focusedTask: { threadId: ThreadId.make("thread-circe") },
        recentTasks: [],
        pendingInteraction: null,
        updatedAt: null,
      } as const;
      const client = {
        [WS_METHODS.circeGetTaskDesk]: (input: unknown) =>
          Effect.sync(() => {
            calls.push({ method: WS_METHODS.circeGetTaskDesk, input });
            return desk;
          }),
        [WS_METHODS.circeFocusTask]: (input: unknown) =>
          Effect.sync(() => {
            calls.push({ method: WS_METHODS.circeFocusTask, input });
            return desk;
          }),
        [WS_METHODS.circeGetProjectVocabulary]: (input: unknown) =>
          Effect.sync(() => {
            calls.push({ method: WS_METHODS.circeGetProjectVocabulary, input });
            return [
              {
                projectId: ProjectId.make("project-beacon"),
                title: "Circe",
                workspaceRoot: "/work/circe",
                repositoryNames: ["circe"],
                aliases: ["jervis"],
                aliasDetails: [{ alias: "jervis", kind: "user-defined" as const }],
              },
            ];
          }),
        [WS_METHODS.circeManageProjectAlias]: (input: unknown) =>
          Effect.sync(() => {
            calls.push({ method: WS_METHODS.circeManageProjectAlias, input });
            return { changed: true };
          }),
      } as unknown as WsRpcProtocolClient;
      const target = new PrimaryConnectionTarget({
        environmentId: EnvironmentId.make("environment-circe-desk"),
        label: "Circe phone",
        httpBaseUrl: "http://127.0.0.1:3002",
        wsBaseUrl: "ws://127.0.0.1:3002",
      });
      const session: RpcSession = {
        client,
        initialConfig: Effect.never,
        subscribeServerConfig: () => Stream.empty,
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
        getCirceTaskDesk(),
        focusCirceTask({
          threadId: ThreadId.make("thread-one"),
          taskRef: {
            executionNodeId: EnvironmentId.make("environment-circe"),
            threadId: ThreadId.make("thread-one"),
          },
        }),
        getCirceProjectVocabulary(),
        manageCirceProjectAlias({
          action: "set",
          projectId: ProjectId.make("project-beacon"),
          alias: "jervis",
          kind: "user-defined",
        }),
      ]).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(result[0].focusedTask).toEqual(desk.focusedTask);
      expect(result[1].focusedTask).toEqual(desk.focusedTask);
      expect(result[2][0]?.aliases).toEqual(["jervis"]);
      expect(result[3].changed).toBe(true);
      expect(calls).toEqual([
        { method: WS_METHODS.circeGetTaskDesk, input: {} },
        {
          method: WS_METHODS.circeFocusTask,
          input: {
            threadId: "thread-one",
            taskRef: {
              executionNodeId: "environment-circe",
              threadId: "thread-one",
            },
          },
        },
        { method: WS_METHODS.circeGetProjectVocabulary, input: {} },
        {
          method: WS_METHODS.circeManageProjectAlias,
          input: {
            action: "set",
            projectId: "project-beacon",
            alias: "jervis",
            kind: "user-defined",
          },
        },
      ]);
    }),
  );
});
