import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
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
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { JarvisManager } from "../Services/JarvisManager.ts";
import { JarvisProjectLexicon } from "../Services/JarvisProjectLexicon.ts";
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

const testLexiconLayer = Layer.mock(JarvisProjectLexicon)({
  list: () => Effect.succeed([]),
  learn: (input) =>
    Effect.succeed({
      ...input,
      updatedAt: DateTime.makeUnsafe("2026-08-12T00:02:00.000Z"),
    }),
  forget: () => Effect.succeed(false),
});

describe("JarvisManager", () => {
  it.effect("lists known T3 projects without dispatching a provider task", () => {
    const otherProject = {
      ...project,
      id: ProjectId.make("project-rivvl"),
      title: "Rivvl",
      workspaceRoot: "/workspace/rivvl",
    };
    const layer = JarvisManagerLive.pipe(
      Layer.provideMerge(testLexiconLayer),
      Layer.provideMerge(
        Layer.mock(ProviderRegistry)({
          getProviders: Effect.die("Project discovery must not inspect providers"),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShellById: () => Effect.succeed(Option.some(project)),
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 1,
              projects: [project, otherProject],
              threads: [],
              updatedAt: "2026-08-12T00:02:00.000Z",
            }),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(OrchestrationEngineService)({
          dispatch: () => Effect.die("Project discovery must not dispatch a command"),
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
        utterance: "Can you tell me what projects are there?",
        projectId: project.id,
      });

      expect(result).toEqual({
        status: "acknowledged",
        action: "projects-listed",
        message: "You have 2 projects: Jarvis and Rivvl.",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("focuses the real project matched from grounded project identity", () => {
    let aliases: ReadonlyArray<import("@t3tools/contracts").JarvisProjectAlias> = [];
    const rivvlProject = {
      ...project,
      id: ProjectId.make("project-rivvl"),
      title: "Rivvl",
      workspaceRoot: "/workspace/rivvl",
      repositoryIdentity: {
        canonicalKey: "github:acme/rivvl",
        locator: {
          source: "git-remote" as const,
          remoteName: "origin",
          remoteUrl: "https://github.com/acme/rivvl.git",
        },
        name: "rivvl",
      },
    };
    const layer = JarvisManagerLive.pipe(
      Layer.provideMerge(
        Layer.mock(JarvisProjectLexicon)({
          list: () => Effect.succeed(aliases),
          learn: (input) =>
            Effect.sync(() => {
              const learned = {
                ...input,
                updatedAt: DateTime.makeUnsafe("2026-08-12T00:02:00.000Z"),
              };
              aliases = [learned];
              return learned;
            }),
          forget: () => Effect.succeed(false),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(ProviderRegistry)({
          getProviders: Effect.die("Project focus must not inspect providers"),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShellById: (projectId) =>
            Effect.succeed(Option.some(projectId === rivvlProject.id ? rivvlProject : project)),
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 1,
              projects: [project, rivvlProject],
              threads: [],
              updatedAt: "2026-08-12T00:02:00.000Z",
            }),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(OrchestrationEngineService)({
          dispatch: () => Effect.die("Project focus must not dispatch a command"),
          readEvents: () => Stream.empty,
          streamDomainEvents: Stream.empty,
          latestSequence: Effect.succeed(0),
        }),
      ),
      Layer.provideMerge(testCryptoLayer),
    );

    return Effect.gen(function* () {
      const manager = yield* JarvisManager;
      const confirmed = yield* manager.execute({
        utterance: "Switch to the Ripple project",
        projectId: project.id,
        confirmedProjectId: rivvlProject.id,
        confirmedProjectAlias: "ripple",
      });
      expect(confirmed).toEqual({
        status: "acknowledged",
        action: "focused",
        projectId: rivvlProject.id,
        message: "I'll use Rivvl for new tasks.",
      });
      const remembered = yield* manager.execute({
        utterance: "Switch to the Ripple project",
        projectId: project.id,
      });
      expect(remembered).toEqual({
        status: "acknowledged",
        action: "focused",
        projectId: rivvlProject.id,
        message: "I'll use Rivvl for new tasks.",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("steers and queues work against the exact referenced task", () => {
    const commands: Array<OrchestrationCommand> = [];
    let availableProviders: ReadonlyArray<ServerProvider> = [codexProvider];
    const targetProject = {
      ...project,
      id: ProjectId.make("project-fable"),
      title: "Fable",
      workspaceRoot: "/workspace/fable",
    };
    let focusedThread: OrchestrationThread = {
      ...sourceThread,
      modelSelection: {
        ...sourceThread.modelSelection,
        options: [{ id: "reasoningEffort", value: "high" }],
      },
      latestTurn: {
        turnId: TurnId.make("turn-running"),
        state: "running",
        requestedAt: "2026-08-12T00:01:00.000Z",
        startedAt: "2026-08-12T00:01:01.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
      activities: [
        {
          id: EventId.make("jarvis-created"),
          tone: "info",
          kind: "jarvis.task.created",
          summary: "Started by Jarvis",
          payload: { objective: "Fix authentication" },
          turnId: null,
          createdAt: "2026-08-12T00:00:00.000Z",
        },
      ],
    };
    const layer = JarvisManagerLive.pipe(
      Layer.provideMerge(testLexiconLayer),
      Layer.provideMerge(
        Layer.mock(ProviderRegistry)({ getProviders: Effect.sync(() => availableProviders) }),
      ),
      Layer.provideMerge(
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShellById: (projectId) =>
            Effect.succeed(
              projectId === targetProject.id ? Option.some(targetProject) : Option.some(project),
            ),
          getThreadDetailById: (threadId) =>
            Effect.succeed(
              threadId === focusedThread.id ? Option.some(focusedThread) : Option.none(),
            ),
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 1,
              projects: [project, targetProject],
              threads: [],
              updatedAt: "2026-08-12T00:02:00.000Z",
            }),
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
      const steered = yield* manager.execute({
        utterance: "actually use SQLite instead",
        projectId: project.id,
        referenceThreadId: focusedThread.id,
      });
      const queued = yield* manager.execute({
        utterance: "after that update the docs",
        projectId: project.id,
        referenceThreadId: focusedThread.id,
      });

      expect(steered).toMatchObject({ status: "acknowledged", action: "steered" });
      expect(queued).toMatchObject({ status: "acknowledged", action: "queued" });
      expect(commands[0]).toMatchObject({
        type: "thread.turn.start",
        threadId: focusedThread.id,
        message: { text: "use SQLite instead" },
      });
      expect(commands[1]).toMatchObject({
        type: "thread.activity.append",
        threadId: focusedThread.id,
        activity: { kind: "jarvis.followup.queued", summary: "update the docs" },
      });

      focusedThread = {
        ...focusedThread,
        latestTurn: {
          ...focusedThread.latestTurn!,
          state: "completed",
          completedAt: "2026-08-12T00:03:00.000Z",
        },
      };
      const immediate = yield* manager.execute({
        utterance: "after that add release notes",
        projectId: project.id,
        referenceThreadId: focusedThread.id,
      });
      expect(immediate).toMatchObject({
        status: "acknowledged",
        action: "queued",
        message: expect.stringContaining("started the next step"),
      });
      expect(commands[2]).toMatchObject({
        type: "thread.turn.start",
        threadId: focusedThread.id,
        message: { text: "add release notes" },
      });

      focusedThread = {
        ...focusedThread,
        latestTurn: { ...focusedThread.latestTurn!, state: "running", completedAt: null },
      };
      availableProviders = [];
      const commandCount = commands.length;
      const unavailableReroute = yield* manager.execute({
        utterance: "do that last run in the Fable project",
        projectId: project.id,
        referenceThreadId: focusedThread.id,
      });
      expect(unavailableReroute.status).toBe("needs-input");
      expect(commands).toHaveLength(commandCount);

      availableProviders = [codexProvider];
      const rerouteStart = commands.length;
      const rerouted = yield* manager.execute({
        utterance: "do that last run in the Fable project",
        projectId: targetProject.id,
        contextThreadId: focusedThread.id,
        referenceThreadId: focusedThread.id,
        continueContext: true,
      });
      expect(rerouted).toMatchObject({ status: "started", objective: "Fix authentication" });
      expect(commands.slice(rerouteStart).map((command) => command.type)).toEqual([
        "thread.create",
        "thread.turn.interrupt",
        "thread.turn.start",
        "thread.activity.append",
        "thread.activity.append",
      ]);
      expect(commands[rerouteStart]).toMatchObject({
        type: "thread.create",
        projectId: targetProject.id,
        modelSelection: focusedThread.modelSelection,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("creates and starts a T3 thread through the selected provider", () => {
    const commands: Array<OrchestrationCommand> = [];
    const createdThreadIds = new Set<ThreadId>();
    const layer = JarvisManagerLive.pipe(
      Layer.provideMerge(testLexiconLayer),
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
              if (command.type === "thread.turn.start" && !createdThreadIds.has(command.threadId)) {
                throw new Error(`Thread '${command.threadId}' does not exist.`);
              }
              if (command.type === "thread.create") {
                createdThreadIds.add(command.threadId);
              }
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
      expect(commands).toHaveLength(3);
      expect(commands.map((command) => command.type)).toEqual([
        "thread.create",
        "thread.turn.start",
        "thread.activity.append",
      ]);
      expect(commands[0]).toMatchObject({
        type: "thread.create",
        threadId: result.threadId,
        projectId: project.id,
        title: "Implement device presence",
        modelSelection: result.modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      expect(commands[1]).toMatchObject({
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
      });
      expect(commands[1]).not.toHaveProperty("bootstrap");
      expect(commands[2]).toMatchObject({
        type: "thread.activity.append",
        threadId: result.threadId,
        activity: { kind: "jarvis.task.created" },
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("returns a stable routed task reference and deduplicates request retries", () => {
    const commands: Array<OrchestrationCommand> = [];
    const acceptedCommands = new Set<CommandId>();
    let existingThread: Option.Option<OrchestrationThread> = Option.none();
    const executionNodeId = EnvironmentId.make("environment-desktop");
    const requestMetadata = {
      requestId: "request-routed-1",
      origin: {
        originNodeId: EnvironmentId.make("environment-laptop"),
        originInteractionId: "interaction-1",
      },
    };
    const layer = JarvisManagerLive.pipe(
      Layer.provideMerge(testLexiconLayer),
      Layer.provideMerge(
        Layer.mock(ProviderRegistry)({
          getProviders: Effect.succeed([codexProvider]),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShellById: () => Effect.succeed(Option.some(project)),
          getThreadDetailById: () => Effect.succeed(existingThread),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(OrchestrationEngineService)({
          dispatch: (command) =>
            Effect.sync(() => {
              if (!acceptedCommands.has(command.commandId)) {
                acceptedCommands.add(command.commandId);
                commands.push(command);
              }
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
      const input = {
        utterance: "Implement device presence.",
        projectId: project.id,
        modelSelection: {
          instanceId: codexProvider.instanceId,
          model: "gpt-5.6-sol",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
        executionNodeId,
        requestMetadata,
        acceptanceKey: "session-laptop:request-routed-1",
      };
      const first = yield* manager.execute(input);
      const second = yield* manager.execute(input);

      expect(first).toMatchObject({
        status: "started",
        taskRef: {
          executionNodeId,
          projectId: project.id,
          remoteThreadId: first.status === "started" ? first.threadId : undefined,
          providerId: codexProvider.instanceId,
        },
        requestMetadata,
      });
      expect(second).toEqual(first);
      expect(commands.map((command) => command.type)).toEqual([
        "thread.create",
        "thread.turn.start",
        "thread.activity.append",
      ]);
      const taskCreated = commands.find(
        (command) =>
          command.type === "thread.activity.append" &&
          command.activity.kind === "jarvis.task.created",
      );
      expect(taskCreated).toMatchObject({
        type: "thread.activity.append",
        activity: {
          payload: {
            requestMetadata,
            taskRef: first.status === "started" ? first.taskRef : undefined,
          },
        },
      });

      if (first.status !== "started") return;
      existingThread = Option.some({
        ...sourceThread,
        id: first.threadId,
        projectId: project.id,
        title: "Implement device presence",
        modelSelection: {
          ...first.modelSelection,
          options: (first.modelSelection.options ?? []).toReversed(),
        },
        activities: [
          {
            id: EventId.make("routed-task-created"),
            tone: "info",
            kind: "jarvis.task.created",
            summary: "Started by the T3 Jarvis manager",
            payload: {
              objective: first.objective,
              requestMetadata: {
                requestId: requestMetadata.requestId,
                origin: {
                  originInteractionId: requestMetadata.origin.originInteractionId,
                  originNodeId: requestMetadata.origin.originNodeId,
                },
              },
            },
            turnId: null,
            createdAt: "2026-08-12T00:02:00.000Z",
          },
        ],
      });
      const equivalent = yield* manager.execute(input);
      expect(equivalent).toEqual(first);
      const conflict = yield* manager
        .execute({ ...input, utterance: "Implement a different task." })
        .pipe(Effect.result);
      expect(conflict._tag).toBe("Failure");
      if (conflict._tag === "Failure") {
        expect(conflict.failure._tag).toBe("JarvisRequestConflictError");
      }
      expect(commands).toHaveLength(3);
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses an explicit companion model selection for a plain voice objective", () => {
    const commands: Array<OrchestrationCommand> = [];
    const layer = JarvisManagerLive.pipe(
      Layer.provideMerge(testLexiconLayer),
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
        type: "thread.create",
        modelSelection: {
          instanceId: "codex",
          model: "gpt-5.6-sol",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      });
      expect(commands[1]).toMatchObject({
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

  it.effect("uses the project's T3 default model for a plain local voice objective", () => {
    const commands: Array<OrchestrationCommand> = [];
    const providerWithDefaults = {
      ...codexProvider,
      models: codexProvider.models.map((model) => ({
        ...model,
        capabilities: {
          optionDescriptors: model.capabilities!.optionDescriptors!.map((descriptor) =>
            descriptor.type === "select"
              ? {
                  ...descriptor,
                  options: descriptor.options.map((option) =>
                    option.id === "high" ? { ...option, isDefault: true } : option,
                  ),
                }
              : descriptor,
          ),
        },
      })),
    };
    const projectWithDefault = {
      ...project,
      defaultModelSelection: {
        instanceId: codexProvider.instanceId,
        model: "gpt-5.6-sol",
      },
    };
    const layer = JarvisManagerLive.pipe(
      Layer.provideMerge(testLexiconLayer),
      Layer.provideMerge(
        Layer.mock(ProviderRegistry)({
          getProviders: Effect.succeed([providerWithDefaults]),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShellById: () => Effect.succeed(Option.some(projectWithDefault)),
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
        utterance: "Create a short greeting.",
        projectId: project.id,
      });

      expect(result).toMatchObject({
        status: "started",
        objective: "Create a short greeting.",
        modelSelection: {
          ...projectWithDefault.defaultModelSelection,
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      });
      expect(commands.map((command) => command.type)).toEqual([
        "thread.create",
        "thread.turn.start",
        "thread.activity.append",
      ]);
      expect(commands[0]).toMatchObject({
        type: "thread.create",
        projectId: project.id,
        modelSelection: {
          ...projectWithDefault.defaultModelSelection,
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("links a contextual Codex output to a Fable review task", () => {
    const commands: Array<OrchestrationCommand> = [];
    const layer = JarvisManagerLive.pipe(
      Layer.provideMerge(testLexiconLayer),
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
      expect(commands).toHaveLength(4);
      expect(commands.map((command) => command.type)).toEqual([
        "thread.create",
        "thread.turn.start",
        "thread.activity.append",
        "thread.activity.append",
      ]);
      expect(commands[0]).toMatchObject({
        type: "thread.create",
        threadId: result.threadId,
        modelSelection: result.modelSelection,
      });
      expect(commands[1]).toMatchObject({
        type: "thread.turn.start",
        threadId: result.threadId,
        message: {
          text: expect.stringContaining("Implemented presence with a five-second polling loop."),
        },
      });
      expect(commands[2]).toMatchObject({
        type: "thread.activity.append",
        threadId: sourceThread.id,
        activity: {
          kind: "jarvis.review.requested",
          payload: { reviewThreadId: result.threadId },
        },
      });
      expect(commands[3]).toMatchObject({
        type: "thread.activity.append",
        threadId: result.threadId,
        activity: {
          kind: "jarvis.review.source",
          payload: {
            sourceThreadId: sourceThread.id,
            objective: "Review this Codex output.",
          },
        },
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("continues the chosen conversation for any new voice instruction", () => {
    const commands: Array<OrchestrationCommand> = [];
    const layer = JarvisManagerLive.pipe(
      Layer.provideMerge(testLexiconLayer),
      Layer.provideMerge(
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([codexProvider]) }),
      ),
      Layer.provideMerge(
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShellById: () => Effect.succeed(Option.some(project)),
          getThreadDetailById: () => Effect.succeed(Option.some(sourceThread)),
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
        utterance: "Add an integration test for the new path.",
        projectId: project.id,
        contextThreadId: sourceThread.id,
        continueContext: true,
      });

      expect(result).toMatchObject({
        status: "started",
        threadId: sourceThread.id,
        objective: "Add an integration test for the new path.",
        modelSelection: sourceThread.modelSelection,
      });
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        type: "thread.turn.start",
        threadId: sourceThread.id,
        message: { role: "user", text: "Add an integration test for the new path." },
        modelSelection: sourceThread.modelSelection,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses to continue a thread through a different project target", () => {
    const commands: Array<OrchestrationCommand> = [];
    const selectedProject = {
      ...project,
      id: ProjectId.make("project-other"),
      title: "Other project",
      workspaceRoot: "/workspace/other",
    };
    const layer = JarvisManagerLive.pipe(
      Layer.provideMerge(testLexiconLayer),
      Layer.provideMerge(
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([codexProvider]) }),
      ),
      Layer.provideMerge(
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShellById: () => Effect.succeed(Option.some(selectedProject)),
          getThreadDetailById: () => Effect.succeed(Option.some(sourceThread)),
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
        utterance: "Continue the work.",
        projectId: selectedProject.id,
        contextThreadId: sourceThread.id,
        continueContext: true,
      });

      expect(result).toMatchObject({
        status: "needs-input",
        reason: "context-project-mismatch",
      });
      expect(commands).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not turn a stale continuation target into a brand-new task", () => {
    const commands: Array<OrchestrationCommand> = [];
    const layer = JarvisManagerLive.pipe(
      Layer.provideMerge(testLexiconLayer),
      Layer.provideMerge(
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([codexProvider]) }),
      ),
      Layer.provideMerge(
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShellById: () => Effect.succeed(Option.some(project)),
          getThreadDetailById: () => Effect.succeed(Option.none()),
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
        utterance: "Continue the work.",
        projectId: project.id,
        contextThreadId: ThreadId.make("thread-deleted"),
        continueContext: true,
        modelSelection: sourceThread.modelSelection,
      });

      expect(result).toMatchObject({
        status: "needs-input",
        reason: "context-thread-required",
      });
      expect(commands).toHaveLength(0);
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
      Layer.provideMerge(testLexiconLayer),
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
