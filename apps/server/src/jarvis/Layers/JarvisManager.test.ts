import { describe, expect, it } from "@effect/vitest";
import {
  MessageId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { JarvisManager } from "../Services/JarvisManager.ts";
import { JarvisManagerLive } from "./JarvisManager.ts";

const project: OrchestrationProjectShell = {
  id: ProjectId.make("project-jarvis"),
  title: "Jarvis",
  workspaceRoot: "/workspace/jarvis",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
};

const codexProvider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  displayName: "Codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-08-12T00:00:00.000Z",
  models: [
    {
      slug: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      shortName: "Sol",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "low", label: "Low" },
              { id: "high", label: "High" },
            ],
          },
        ],
      },
    },
  ],
  slashCommands: [],
  skills: [],
};

const fableProvider: ServerProvider = {
  ...codexProvider,
  instanceId: ProviderInstanceId.make("fable"),
  driver: ProviderDriverKind.make("fable"),
  displayName: "Fable",
  models: [
    {
      slug: "fable-reviewer",
      name: "Fable Reviewer",
      shortName: "Reviewer",
      isCustom: false,
      capabilities: null,
    },
  ],
};

const sourceThread: OrchestrationThread = {
  id: ThreadId.make("thread-source"),
  projectId: project.id,
  title: "Codex implementation",
  modelSelection: { instanceId: codexProvider.instanceId, model: "gpt-5.6-sol" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:01:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [
    {
      id: MessageId.make("message-source-output"),
      role: "assistant",
      text: "Implemented presence with a five-second polling loop.",
      turnId: null,
      streaming: false,
      createdAt: "2026-08-12T00:01:00.000Z",
      updatedAt: "2026-08-12T00:01:00.000Z",
    },
  ],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

const testCryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(size),
    digest: (_algorithm, data) => Effect.succeed(data),
  }),
);

describe("JarvisManager", () => {
  it.effect("creates and starts a T3 thread through the selected provider", () => {
    const commands: Array<OrchestrationCommand> = [];
    const layer = JarvisManagerLive.pipe(
      Layer.provideMerge(
        Layer.mock(ProviderRegistry)({
          getProviders: Effect.succeed([codexProvider]),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShellById: (projectId) =>
            Effect.succeed(projectId === project.id ? Option.some(project) : Option.none()),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(OrchestrationEngineService)({
          dispatch: (command) =>
            Effect.sync(() => {
              commands.push(command);
              return { sequence: commands.length };
            }),
          readEvents: () => Stream.empty,
          streamDomainEvents: Stream.empty,
          latestSequence: Effect.succeed(0),
        }),
      ),
      Layer.provideMerge(testCryptoLayer),
    );

    return Effect.gen(function* () {
      const manager = yield* JarvisManager;
      const result = yield* manager.execute({
        utterance: "Jarvis, use Codex Sol high to implement device presence.",
        projectId: project.id,
      });

      expect(result.status).toBe("started");
      if (result.status !== "started") return;
      expect(result.objective).toBe("Implement device presence.");
      expect(result.modelSelection).toEqual({
        instanceId: "codex",
        model: "gpt-5.6-sol",
        options: [{ id: "reasoningEffort", value: "high" }],
      });
      expect(commands).toHaveLength(2);
      expect(commands[0]).toMatchObject({
        type: "thread.turn.start",
        threadId: result.threadId,
        message: {
          role: "user",
          text: "Implement device presence.",
          attachments: [],
        },
        modelSelection: result.modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        bootstrap: {
          createThread: {
            projectId: project.id,
            title: "Implement device presence",
            modelSelection: result.modelSelection,
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          },
        },
      });
      expect(commands[1]).toMatchObject({
        type: "thread.activity.append",
        threadId: result.threadId,
        activity: { kind: "jarvis.task.created" },
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses an explicit companion model selection for a plain voice objective", () => {
    const commands: Array<OrchestrationCommand> = [];
    const layer = JarvisManagerLive.pipe(
      Layer.provideMerge(
        Layer.mock(ProviderRegistry)({
          getProviders: Effect.succeed([codexProvider]),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShellById: () => Effect.succeed(Option.some(project)),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(OrchestrationEngineService)({
          dispatch: (command) =>
            Effect.sync(() => {
              commands.push(command);
              return { sequence: commands.length };
            }),
          readEvents: () => Stream.empty,
          streamDomainEvents: Stream.empty,
          latestSequence: Effect.succeed(0),
        }),
      ),
      Layer.provideMerge(testCryptoLayer),
    );

    return Effect.gen(function* () {
      const manager = yield* JarvisManager;
      const result = yield* manager.execute({
        utterance: "Implement device presence.",
        projectId: project.id,
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6-sol",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      });

      expect(result).toMatchObject({
        status: "started",
        objective: "Implement device presence.",
        modelSelection: {
          instanceId: "codex",
          model: "gpt-5.6-sol",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      });
      expect(commands[0]).toMatchObject({
        type: "thread.turn.start",
        message: { text: "Implement device presence." },
        modelSelection: {
          instanceId: "codex",
          model: "gpt-5.6-sol",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("links a contextual Codex output to a Fable review task", () => {
    const commands: Array<OrchestrationCommand> = [];
    const layer = JarvisManagerLive.pipe(
      Layer.provideMerge(
        Layer.mock(ProviderRegistry)({
          getProviders: Effect.succeed([codexProvider, fableProvider]),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShellById: () => Effect.succeed(Option.some(project)),
          getThreadDetailById: (threadId) =>
            Effect.succeed(
              threadId === sourceThread.id ? Option.some(sourceThread) : Option.none(),
            ),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(OrchestrationEngineService)({
          dispatch: (command) =>
            Effect.sync(() => {
              commands.push(command);
              return { sequence: commands.length };
            }),
          readEvents: () => Stream.empty,
          streamDomainEvents: Stream.empty,
          latestSequence: Effect.succeed(0),
        }),
      ),
      Layer.provideMerge(testCryptoLayer),
    );

    return Effect.gen(function* () {
      const manager = yield* JarvisManager;
      const result = yield* manager.execute({
        utterance: "Jarvis, use Fable to review this Codex output.",
        projectId: project.id,
        contextThreadId: sourceThread.id,
      });

      expect(result.status).toBe("started");
      if (result.status !== "started") return;
      expect(result.modelSelection).toEqual({
        instanceId: "fable",
        model: "fable-reviewer",
      });
      expect(commands).toHaveLength(3);
      expect(commands[0]).toMatchObject({
        type: "thread.turn.start",
        threadId: result.threadId,
        message: {
          text: expect.stringContaining("Implemented presence with a five-second polling loop."),
        },
      });
      expect(commands[1]).toMatchObject({
        type: "thread.activity.append",
        threadId: sourceThread.id,
        activity: {
          kind: "jarvis.review.requested",
          payload: { reviewThreadId: result.threadId },
        },
      });
      expect(commands[2]).toMatchObject({
        type: "thread.activity.append",
        threadId: result.threadId,
        activity: {
          kind: "jarvis.review.source",
          payload: { sourceThreadId: sourceThread.id },
        },
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("speaks a reply back into a pending worker question", () => {
    const commands: Array<OrchestrationCommand> = [];
    const pendingThread: OrchestrationThread = {
      ...sourceThread,
      activities: [
        {
          id: EventId.make("event-input-request"),
          tone: "info",
          kind: "user-input.requested",
          summary: "Continue?",
          payload: { requestId: "request-continue", questions: [{ id: "continue" }] },
          turnId: null,
          createdAt: "2026-08-12T00:01:00.000Z",
        },
      ],
    };
    const layer = JarvisManagerLive.pipe(
      Layer.provideMerge(
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([codexProvider]) }),
      ),
      Layer.provideMerge(
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShellById: () => Effect.succeed(Option.some(project)),
          getThreadDetailById: () => Effect.succeed(Option.some(pendingThread)),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(OrchestrationEngineService)({
          dispatch: (command) =>
            Effect.sync(() => {
              commands.push(command);
              return { sequence: commands.length };
            }),
          readEvents: () => Stream.empty,
          streamDomainEvents: Stream.empty,
          latestSequence: Effect.succeed(0),
        }),
      ),
      Layer.provideMerge(testCryptoLayer),
    );

    return Effect.gen(function* () {
      const manager = yield* JarvisManager;
      const result = yield* manager.execute({
        utterance: "Yes, continue to the next step.",
        projectId: project.id,
        contextThreadId: pendingThread.id,
      });

      expect(result.status).toBe("started");
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        type: "thread.user-input.respond",
        threadId: pendingThread.id,
        requestId: "request-continue",
        answers: { continue: "Yes, continue to the next step." },
      });
    }).pipe(Effect.provide(layer));
  });
});
