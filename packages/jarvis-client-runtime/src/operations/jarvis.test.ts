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
  acknowledgeJarvisVoiceReport,
  confirmJarvisReportSpoken,
  executeJarvisInstruction,
  getJarvisProjectVocabulary,
  getJarvisTaskDesk,
  manageJarvisProjectAlias,
  navigateJarvisTaskDesk,
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

  it.effect("reads and navigates the authenticated device task desk", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly method: string; readonly input: unknown }> = [];
      const desk = {
        focusedThreadId: ThreadId.make("thread-jarvis"),
        attentionThreadId: null,
        backStack: [],
        forwardStack: [],
        recentTasks: [],
        newConversationArmed: false,
        pendingFrame: null,
        pendingProjectFrame: null,
        updatedAt: null,
      } as const;
      const client = {
        [WS_METHODS.jarvisGetTaskDesk]: (input: unknown) =>
          Effect.sync(() => {
            calls.push({ method: WS_METHODS.jarvisGetTaskDesk, input });
            return desk;
          }),
        [WS_METHODS.jarvisNavigateTaskDesk]: (input: unknown) =>
          Effect.sync(() => {
            calls.push({ method: WS_METHODS.jarvisNavigateTaskDesk, input });
            return { ...desk, newConversationArmed: true };
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
        [WS_METHODS.jarvisAcknowledgeReport]: (input: unknown) =>
          Effect.sync(() => {
            calls.push({ method: WS_METHODS.jarvisAcknowledgeReport, input });
            return { acknowledgedThrough: 12 };
          }),
        [WS_METHODS.jarvisConfirmReportSpoken]: (input: unknown) =>
          Effect.sync(() => {
            calls.push({ method: WS_METHODS.jarvisConfirmReportSpoken, input });
            return { confirmed: true, state: "confirmed" as const };
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
        navigateJarvisTaskDesk({ action: "new-conversation" }),
        getJarvisProjectVocabulary(),
        manageJarvisProjectAlias({
          action: "set",
          projectId: ProjectId.make("project-jarvis"),
          alias: "jervis",
          kind: "user-defined",
        }),
        acknowledgeJarvisVoiceReport({ throughSequence: 12 }),
        confirmJarvisReportSpoken({ reportId: "report-12", deviceId: "device-desktop" }),
      ]).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(result[0].focusedThreadId).toBe(desk.focusedThreadId);
      expect(result[1].newConversationArmed).toBe(true);
      expect(result[2][0]?.aliases).toEqual(["jervis"]);
      expect(result[3].changed).toBe(true);
      expect(result[4].acknowledgedThrough).toBe(12);
      expect(result[5].confirmed).toBe(true);
      expect(calls).toEqual([
        { method: WS_METHODS.jarvisGetTaskDesk, input: {} },
        { method: WS_METHODS.jarvisNavigateTaskDesk, input: { action: "new-conversation" } },
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
        {
          method: WS_METHODS.jarvisAcknowledgeReport,
          input: { throughSequence: 12 },
        },
        {
          method: WS_METHODS.jarvisConfirmReportSpoken,
          input: { reportId: "report-12", deviceId: "device-desktop" },
        },
      ]);
    }),
  );
});
