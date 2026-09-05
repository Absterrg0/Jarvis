import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_RUNTIME_MODE,
  AuthSessionId,
  EnvironmentId,
  MessageId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type JarvisPendingInteraction,
  type JarvisRequestMetadata,
  type JarvisTaskDeskState,
  type ModelSelection,
  type ServerProvider,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import * as ServerSettingsModule from "../../serverSettings.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { JarvisController, JarvisControllerInterpreter } from "../Services/JarvisController.ts";
import { JarvisProjectLexicon } from "../Services/JarvisProjectLexicon.ts";
import { JarvisFollowUpQueue } from "../Services/JarvisFollowUpQueue.ts";
import { JarvisTaskDesk } from "../Services/JarvisTaskDesk.ts";
import {
  makeJarvisControllerInterpreterLive,
  makeJarvisControllerLive,
} from "./JarvisController.ts";
import {
  interpretJarvisCommand,
  JarvisSemanticIntent,
  prepareJarvisSemanticTurn,
} from "@t3tools/jarvis-core/command";

const project: OrchestrationProjectShell = {
  id: ProjectId.make("project-jarvis"),
  title: "Jarvis",
  workspaceRoot: "/workspace/jarvis",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
};

const sessionId = AuthSessionId.make("controller-test-session");

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

const testFollowUpQueueLayer = Layer.mock(JarvisFollowUpQueue)({
  enqueue: () => Effect.void,
  claimNext: () => Effect.succeed(Option.none()),
  markDispatched: () => Effect.void,
  release: () => Effect.void,
  resetRunning: () => Effect.void,
  statusOf: () => Effect.succeed(Option.none()),
  cancelPending: () => Effect.succeed(0),
  listPendingThreadIds: () => Effect.succeed([]),
  pendingCount: () => Effect.succeed(0),
});

/**
 * Minimal honest queue: enqueue persists, claimNext atomically takes the
 * oldest pending row, and the dispatcher helper drives immediate dispatch
 * through it. Tests that expect "started the next step" need this instead of
 * the claim-nothing stub above.
 */
const makeImmediateFollowUpQueueLayer = (hooks?: {
  readonly onEnqueue?: (input: {
    threadId: ThreadId;
    requestMetadata?: JarvisRequestMetadata;
  }) => void;
  readonly onCancel?: (threadId: ThreadId) => number;
}) => {
  type Row = {
    queueId: string;
    threadId: ThreadId;
    instruction: string;
    requestMetadata?: JarvisRequestMetadata;
    status: "pending" | "running" | "dispatched";
  };
  const rows: Array<Row> = [];
  return Layer.mock(JarvisFollowUpQueue)({
    enqueue: (input) =>
      Effect.sync(() => {
        rows.push({
          queueId: input.queueId,
          threadId: input.threadId,
          instruction: input.instruction,
          ...(input.requestMetadata === undefined
            ? {}
            : { requestMetadata: input.requestMetadata }),
          status: "pending",
        });
        hooks?.onEnqueue?.(input);
      }),
    claimNext: (threadId) =>
      Effect.sync(() => {
        const row = rows.find(
          (candidate) => candidate.threadId === threadId && candidate.status === "pending",
        );
        if (row === undefined) return Option.none();
        row.status = "running";
        return Option.some({
          queueId: row.queueId,
          threadId: row.threadId,
          instruction: row.instruction,
          ...(row.requestMetadata === undefined ? {} : { requestMetadata: row.requestMetadata }),
          position: 0,
        });
      }),
    markDispatched: (queueId) =>
      Effect.sync(() => {
        const row = rows.find((candidate) => candidate.queueId === queueId);
        if (row !== undefined) row.status = "dispatched";
      }),
    release: (queueId) =>
      Effect.sync(() => {
        const row = rows.find((candidate) => candidate.queueId === queueId);
        if (row !== undefined && row.status === "running") row.status = "pending";
      }),
    resetRunning: () => Effect.void,
    statusOf: (queueId) =>
      Effect.succeed(
        (() => {
          const row = rows.find((candidate) => candidate.queueId === queueId);
          return row === undefined ? Option.none() : Option.some(row.status);
        })(),
      ),
    cancelPending: (threadId) => Effect.sync(() => hooks?.onCancel?.(threadId) ?? 0),
    listPendingThreadIds: () => Effect.succeed([]),
    pendingCount: (threadId) =>
      Effect.succeed(
        rows.filter((row) => row.threadId === threadId && row.status === "pending").length,
      ),
  });
};

const testTaskDeskLayer = Layer.mock(JarvisTaskDesk)({
  get: () =>
    Effect.succeed({
      focusedTask: null,
      recentTasks: [],
      pendingInteraction: null,
      updatedAt: null,
    }),
  focus: () =>
    Effect.succeed({
      focusedTask: null,
      recentTasks: [],
      pendingInteraction: null,
      updatedAt: null,
    }),
  setPendingInteraction: () =>
    Effect.succeed({
      focusedTask: null,
      recentTasks: [],
      pendingInteraction: null,
      updatedAt: null,
    }),
  consumePendingInteraction: () => Effect.succeed(null),
  clearPendingInteraction: () =>
    Effect.succeed({
      focusedTask: null,
      recentTasks: [],
      pendingInteraction: null,
      updatedAt: null,
    }),
});

const makeTaskDeskLayer = (
  initial: JarvisTaskDeskState,
  onChange?: (state: JarvisTaskDeskState) => void,
) => {
  let state = initial;
  return Layer.mock(JarvisTaskDesk)({
    get: () => Effect.succeed(state),
    focus: ({ task }) =>
      Effect.sync(() => {
        const focusedTask =
          "projectRef" in task
            ? task
            : (state.recentTasks.find((candidate) => candidate.threadId === task.threadId) ?? null);
        state = {
          ...state,
          focusedTask,
        };
        onChange?.(state);
        return state;
      }),
    setPendingInteraction: ({ interaction }: { interaction: JarvisPendingInteraction }) =>
      Effect.sync(() => {
        state = { ...state, pendingInteraction: interaction };
        onChange?.(state);
        return state;
      }),
    consumePendingInteraction: ({ expectedFrameId }: { readonly expectedFrameId?: string }) =>
      Effect.sync(() => {
        const pending = state.pendingInteraction;
        if (
          pending !== null &&
          expectedFrameId !== undefined &&
          pending.frame.frameId !== expectedFrameId
        ) {
          return null;
        }
        state = { ...state, pendingInteraction: null };
        onChange?.(state);
        return pending;
      }),
    clearPendingInteraction: ({ expectedFrameId }: { readonly expectedFrameId?: string }) =>
      Effect.sync(() => {
        if (
          expectedFrameId !== undefined &&
          state.pendingInteraction?.frame.frameId !== expectedFrameId
        ) {
          return state;
        }
        state = { ...state, pendingInteraction: null };
        onChange?.(state);
        return state;
      }),
  });
};

function testSemanticIntent(prompt: string): JarvisSemanticIntent {
  const request = /^Request: (.*)$/mu.exec(prompt)?.[1]?.trim() ?? "";
  const continuing = /^Continue selected conversation: true$/mu.test(prompt);
  const proposal = (overrides: Partial<JarvisSemanticIntent>): JarvisSemanticIntent => {
    const action = overrides.action ?? "start";
    return {
      action,
      acknowledgement: ["start", "continue", "review", "reroute"].includes(action)
        ? "Working on it."
        : null,
      project: null,
      task: null,
      instruction: request.replace(/^Jarvis,\s*/iu, ""),
      provider: null,
      model: null,
      effort: null,
      answer: null,
      ...overrides,
    };
  };
  if (/what projects are there/iu.test(request)) return proposal({ action: "list-projects" });
  const focusedProject = /^Switch to (?:the )?(.+?) project[.!]?$/iu.exec(request)?.[1];
  if (focusedProject !== undefined)
    return proposal({ action: "focus-project", project: focusedProject, instruction: null });
  if (/actually use SQLite instead/iu.test(request))
    return proposal({ action: "steer", instruction: "use SQLite instead" });
  if (/authentication task.*use SQLite instead/iu.test(request))
    return proposal({
      action: "steer",
      task: "Authentication",
      instruction: "use SQLite instead",
    });
  if (/authentication task.*add release notes/iu.test(request))
    return proposal({
      action: "queue",
      task: "Authentication",
      instruction: "add release notes",
    });
  if (/in that Jarvis request/iu.test(request))
    return proposal({ action: "queue", instruction: "check if there are any PR's open" });
  if (/after that add release notes/iu.test(request))
    return proposal({ action: "queue", instruction: "add release notes" });
  if (/do that last run in the Fable project/iu.test(request))
    return proposal({ action: "reroute", project: "Fable", instruction: null });
  if (/move the authentication task to Fable/iu.test(request))
    return proposal({
      action: "reroute",
      task: "Authentication",
      project: "Fable",
      instruction: null,
    });
  if (/stop that task/iu.test(request)) return proposal({ action: "stop", instruction: null });
  if (/stop the authentication task/iu.test(request))
    return proposal({ action: "stop", task: "Authentication", instruction: null });
  if (/status of the authentication task/iu.test(request))
    return proposal({ action: "status", task: "Authentication", instruction: null });
  if (/use Fable to review this Codex output/iu.test(request))
    return proposal({
      action: "review",
      instruction: "Review this Codex output.",
      provider: "Fable",
      model: "Reviewer",
    });
  if (/use Codex Sol high to implement device presence/iu.test(request))
    return proposal({
      instruction: "Implement device presence.",
      provider: "Codex",
      model: "Sol",
      effort: "High",
    });
  if (continuing) return proposal({ action: "continue" });
  return proposal({});
}

const decodeTestSemanticIntent = Schema.decodeUnknownEffect(JarvisSemanticIntent);

const testTextGeneration = TextGeneration.of({
  generateCommitMessage: () => Effect.die("unused"),
  generatePrContent: () => Effect.die("unused"),
  generateBranchName: () => Effect.die("unused"),
  generateThreadTitle: () => Effect.die("unused"),
  generateStructured: (input) => {
    expect(input.cwd).not.toBe(project.workspaceRoot);
    expect(input.cwd).toContain("jarvis-semantic-");
    return decodeTestSemanticIntent(testSemanticIntent(input.prompt)).pipe(Effect.orDie);
  },
});

const testInterpreterLayer = makeJarvisControllerInterpreterLive(
  Layer.mock(ProviderRegistry)({
    getTextGenerationForInstance: () => Effect.succeed(testTextGeneration),
  }),
).pipe(Layer.provide(NodeServices.layer));
const TestJarvisControllerLive = makeJarvisControllerLive(testInterpreterLayer);

const JarvisControllerLive = TestJarvisControllerLive.pipe(
  Layer.provideMerge(testFollowUpQueueLayer),
  Layer.provideMerge(testTaskDeskLayer),
);

describe("JarvisController", () => {
  it.effect(
    "prefers the node Jarvis default over the project default without overriding speech",
    () => {
      const commands: Array<OrchestrationCommand> = [];
      const projectWithDefault = {
        ...project,
        defaultModelSelection: {
          instanceId: codexProvider.instanceId,
          model: "gpt-5.6-sol",
          options: [{ id: "reasoningEffort", value: "high" as const }],
        },
      };
      const layer = JarvisControllerLive.pipe(
        Layer.provideMerge(testLexiconLayer),
        Layer.provideMerge(
          ServerSettingsModule.ServerSettingsService.layerTest({
            jarvisDefaultModelSelection: {
              instanceId: fableProvider.instanceId,
              model: "fable-reviewer",
            },
          }),
        ),
        Layer.provideMerge(
          Layer.mock(ProviderRegistry)({
            getProviders: Effect.succeed([codexProvider, fableProvider]),
          }),
        ),
        Layer.provideMerge(
          Layer.mock(ProjectionSnapshotQuery)({
            getProjectShellById: () => Effect.succeed(Option.some(projectWithDefault)),
            getShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 1,
                projects: [projectWithDefault],
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
        const manager = yield* JarvisController;
        const nodeDefault = yield* manager.execute({
          sessionId,
          utterance: "Jarvis, implement device presence.",
          projectId: project.id,
        });
        expect(nodeDefault).toMatchObject({
          status: "started",
          acknowledgement: "Working on it.",
          modelSelection: { instanceId: "fable", model: "fable-reviewer" },
        });

        const spokenOverride = yield* manager.execute({
          sessionId,
          utterance: "Jarvis, use Codex Sol high to implement device presence.",
          projectId: project.id,
        });
        expect(spokenOverride).toMatchObject({
          status: "started",
          modelSelection: {
            instanceId: "codex",
            model: "gpt-5.6-sol",
            options: [{ id: "reasoningEffort", value: "high" }],
          },
        });
        expect(commands.filter((command) => command.type === "thread.create")).toHaveLength(2);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("does not normalize an invalid node default into a live option", () => {
    let dispatchCount = 0;
    const layer = JarvisControllerLive.pipe(
      Layer.provideMerge(testLexiconLayer),
      Layer.provideMerge(
        ServerSettingsModule.ServerSettingsService.layerTest({
          jarvisDefaultModelSelection: {
            instanceId: codexProvider.instanceId,
            model: "gpt-5.6-sol",
            options: [{ id: "reasoningEffort", value: "max" }],
          },
        }),
      ),
      Layer.provideMerge(
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([codexProvider]) }),
      ),
      Layer.provideMerge(
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShellById: () => Effect.die("Project discovery must not load current project"),
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 1,
              projects: [project],
              threads: [],
              updatedAt: "2026-08-12T00:02:00.000Z",
            }),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(OrchestrationEngineService)({
          dispatch: () =>
            Effect.sync(() => {
              dispatchCount += 1;
              return { sequence: dispatchCount };
            }),
          readEvents: () => Stream.empty,
          streamDomainEvents: Stream.empty,
          latestSequence: Effect.succeed(0),
        }),
      ),
      Layer.provideMerge(testCryptoLayer),
    );

    return Effect.gen(function* () {
      const manager = yield* JarvisController;
      const result = yield* manager.execute({
        sessionId,
        utterance: "Jarvis, fix the login issue.",
        projectId: project.id,
      });
      expect(result).toMatchObject({ status: "needs-input", reason: "selection-unavailable" });
      expect(dispatchCount).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("lists known T3 projects without dispatching a provider task", () => {
    const otherProject = {
      ...project,
      id: ProjectId.make("project-rivvl"),
      title: "Rivvl",
      workspaceRoot: "/workspace/rivvl",
    };
    const layer = JarvisControllerLive.pipe(
      Layer.provideMerge(testLexiconLayer),
      Layer.provideMerge(ServerSettingsModule.ServerSettingsService.layerTest()),
      Layer.provideMerge(
        Layer.mock(ProviderRegistry)({
          getProviders: Effect.succeed([codexProvider]),
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
      const manager = yield* JarvisController;
      const result = yield* manager.execute({
        sessionId,
        utterance: "Can you tell me what projects are there?",
        projectId: ProjectId.make("project-deleted"),
      });

      expect(result).toEqual({
        status: "acknowledged",
        action: "projects-listed",
        message: "You have 2 projects: Jarvis and Rivvl.",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("answers a general question without creating project work", () => {
    const interpreterLayer = Layer.succeed(JarvisControllerInterpreter, {
      interpret: () =>
        Effect.succeed({
          status: "command" as const,
          command: {
            type: "converse" as const,
            instruction: "What is new today?",
            answer: "Nothing new: no provider runs are active.",
          },
        }),
    });
    const layer = makeJarvisControllerLive(interpreterLayer).pipe(
      Layer.provideMerge(testFollowUpQueueLayer),
      Layer.provideMerge(testTaskDeskLayer),
      Layer.provideMerge(testLexiconLayer),
      Layer.provideMerge(ServerSettingsModule.ServerSettingsService.layerTest()),
      Layer.provideMerge(
        Layer.mock(ProviderRegistry)({
          getProviders: Effect.succeed([codexProvider]),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShellById: () => Effect.succeed(Option.some(project)),
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 1,
              projects: [project],
              threads: [],
              updatedAt: "2026-08-12T00:02:00.000Z",
            }),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(OrchestrationEngineService)({
          dispatch: () => Effect.die("A general answer must not dispatch a command"),
          readEvents: () => Stream.empty,
          streamDomainEvents: Stream.empty,
          latestSequence: Effect.succeed(0),
        }),
      ),
      Layer.provideMerge(testCryptoLayer),
    );

    return Effect.gen(function* () {
      const manager = yield* JarvisController;
      const result = yield* manager.converse({
        utterance: "What is new today?",
      });

      expect(result).toEqual({
        status: "acknowledged",
        action: "conversed",
        message: "Nothing new: no provider runs are active.",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("asks again on a lost converse response instead of replaying a receipt", () => {
    let interpretations = 0;
    const interpreterLayer = Layer.succeed(JarvisControllerInterpreter, {
      interpret: () =>
        Effect.sync(() => {
          interpretations += 1;
          return {
            status: "command" as const,
            command: {
              type: "converse" as const,
              instruction: "What is new today?",
              answer: "Nothing new: no provider runs are active.",
            },
          };
        }),
    });
    const layer = makeJarvisControllerLive(interpreterLayer).pipe(
      Layer.provideMerge(testFollowUpQueueLayer),
      Layer.provideMerge(testTaskDeskLayer),
      Layer.provideMerge(testLexiconLayer),
      Layer.provideMerge(ServerSettingsModule.ServerSettingsService.layerTest()),
      Layer.provideMerge(
        Layer.mock(ProviderRegistry)({
          getProviders: Effect.succeed([codexProvider]),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShellById: () => Effect.succeed(Option.some(project)),
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 1,
              projects: [project],
              threads: [],
              updatedAt: "2026-08-12T00:02:00.000Z",
            }),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(OrchestrationEngineService)({
          dispatch: () => Effect.die("A general answer must not dispatch a command"),
          readEvents: () => Stream.empty,
          streamDomainEvents: Stream.empty,
          latestSequence: Effect.succeed(0),
        }),
      ),
      Layer.provideMerge(testCryptoLayer),
    );

    return Effect.gen(function* () {
      const manager = yield* JarvisController;
      const first = yield* manager.converse({ utterance: "What is new today?" });
      const retry = yield* manager.converse({ utterance: "What is new today?" });

      expect(first).toEqual(retry);
      // Best-effort answers carry no receipt: a retry re-asks the model.
      expect(interpretations).toBe(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps a focused follow-up on the execute path with focused context", () => {
    // Server half of the mobile routing contract: a question-shaped
    // follow-up must arrive via execute (never project-free converse) so the
    // focused task reaches the semantic boundary. The interpreter below
    // stands in for the supervisor's documented contract (a question about
    // the focused task resolves against it); the test pins the wiring, not
    // the model's wording.
    const executionNodeId = EnvironmentId.make("node-controller");
    const focusedThread: OrchestrationThread = {
      ...sourceThread,
      id: ThreadId.make("thread-focused-auth"),
      title: "Authentication",
      latestTurn: {
        turnId: TurnId.make("turn-focused-auth"),
        state: "running",
        requestedAt: "2026-08-12T00:01:00.000Z",
        startedAt: "2026-08-12T00:01:01.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    };
    const deskTask = {
      threadId: focusedThread.id,
      taskRef: { executionNodeId, threadId: focusedThread.id },
      projectRef: { nodeId: executionNodeId, projectId: focusedThread.projectId },
    };
    const deskLayer = makeTaskDeskLayer({
      focusedTask: deskTask,
      recentTasks: [deskTask],
      pendingInteraction: null,
      updatedAt: DateTime.makeUnsafe("2026-08-12T00:02:00.000Z"),
    });
    let seenFocusedTask: { threadId: ThreadId } | undefined;
    const interpreterLayer = Layer.succeed(JarvisControllerInterpreter, {
      interpret: (context) =>
        Effect.sync(() => {
          seenFocusedTask = context.focusedTask;
          const prepared = prepareJarvisSemanticTurn(context);
          if (prepared.status === "needs-input") return prepared;
          return interpretJarvisCommand(
            context,
            prepared,
            testSemanticIntent(`Request: ${prepared.utterance}`),
          );
        }),
    });
    const commands: Array<OrchestrationCommand> = [];
    const layer = makeJarvisControllerLive(interpreterLayer).pipe(
      Layer.provideMerge(testFollowUpQueueLayer),
      Layer.provideMerge(deskLayer),
      Layer.provideMerge(testLexiconLayer),
      Layer.provideMerge(ServerSettingsModule.ServerSettingsService.layerTest()),
      Layer.provideMerge(
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([codexProvider]) }),
      ),
      Layer.provideMerge(
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShellById: () => Effect.succeed(Option.some(project)),
          getThreadDetailById: (threadId) =>
            Effect.succeed(
              threadId === focusedThread.id ? Option.some(focusedThread) : Option.none(),
            ),
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 1,
              projects: [project],
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
      const manager = yield* JarvisController;
      const result = yield* manager.execute({
        sessionId,
        utterance: "status of the authentication task",
        projectId: project.id,
      });

      // The desk focus reaches the semantic boundary through execute.
      expect(seenFocusedTask).toMatchObject({ threadId: focusedThread.id });
      // And the follow-up stays on the focused thread: status, not a
      // project-free answer and not new work.
      expect(result).toMatchObject({
        status: "acknowledged",
        action: "status",
        threadId: focusedThread.id,
      });
      expect(commands.filter((command) => command.type === "thread.create")).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("continues an exact task without coupling it to the current UI project", () => {
    const commands: Array<OrchestrationCommand> = [];
    const rivvlProject = {
      ...project,
      id: ProjectId.make("project-rivvl-exact-task"),
      title: "Rivvl",
      workspaceRoot: "/workspace/rivvl-exact-task",
    };
    const rivvlThread: OrchestrationThread = {
      ...sourceThread,
      id: ThreadId.make("thread-rivvl-auth"),
      projectId: rivvlProject.id,
      title: "Rivvl authentication",
    };
    const interpreterLayer = Layer.succeed(JarvisControllerInterpreter, {
      interpret: () =>
        Effect.succeed({
          status: "command" as const,
          command: {
            type: "continue" as const,
            task: { threadId: rivvlThread.id },
            instruction: "Run the integration tests.",
            mode: "continuation" as const,
            taskSelection: "explicit" as const,
          },
        }),
    });
    const layer = makeJarvisControllerLive(interpreterLayer).pipe(
      Layer.provideMerge(testFollowUpQueueLayer),
      Layer.provideMerge(testTaskDeskLayer),
      Layer.provideMerge(testLexiconLayer),
      Layer.provideMerge(ServerSettingsModule.ServerSettingsService.layerTest()),
      Layer.provideMerge(
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([codexProvider]) }),
      ),
      Layer.provideMerge(
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShellById: () =>
            Effect.die("An exact task continuation must not load the current project"),
          getThreadDetailById: (threadId) =>
            Effect.succeed(threadId === rivvlThread.id ? Option.some(rivvlThread) : Option.none()),
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
      const manager = yield* JarvisController;
      const result = yield* manager.execute({
        sessionId,
        utterance: "Continue the Rivvl authentication task and run the integration tests.",
        projectId: project.id,
      });

      expect(result).toMatchObject({
        status: "started",
        threadId: rivvlThread.id,
        projectId: rivvlProject.id,
      });
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        type: "thread.turn.start",
        threadId: rivvlThread.id,
        message: { role: "user", text: "Run the integration tests." },
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
    const layer = JarvisControllerLive.pipe(
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
      Layer.provideMerge(ServerSettingsModule.ServerSettingsService.layerTest()),
      Layer.provideMerge(
        Layer.mock(ProviderRegistry)({
          getProviders: Effect.succeed([codexProvider]),
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
      const manager = yield* JarvisController;
      const confirmed = yield* manager.execute({
        sessionId,
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
        sessionId,
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
    const cancelledThreadIds: Array<ThreadId> = [];
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
    const layer = TestJarvisControllerLive.pipe(
      Layer.provideMerge(
        makeImmediateFollowUpQueueLayer({
          onCancel: (threadId) => {
            cancelledThreadIds.push(threadId);
            return 1;
          },
        }),
      ),
      Layer.provideMerge(testTaskDeskLayer),
      Layer.provideMerge(testLexiconLayer),
      Layer.provideMerge(ServerSettingsModule.ServerSettingsService.layerTest()),
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
      const manager = yield* JarvisController;
      const steered = yield* manager.execute({
        sessionId,
        utterance: "actually use SQLite instead",
        projectId: project.id,
        referenceThreadId: focusedThread.id,
      });
      const queued = yield* manager.execute({
        sessionId,
        utterance: "in that Jarvis request, please check if there are any PR's open",
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
      expect(commands).toHaveLength(1);

      focusedThread = {
        ...focusedThread,
        latestTurn: {
          ...focusedThread.latestTurn!,
          state: "completed",
          completedAt: "2026-08-12T00:03:00.000Z",
        },
      };
      const immediate = yield* manager.execute({
        sessionId,
        utterance: "after that add release notes",
        projectId: project.id,
        referenceThreadId: focusedThread.id,
      });
      expect(immediate).toMatchObject({
        status: "acknowledged",
        action: "queued",
        message: expect.stringContaining("started the next step"),
      });
      // FIFO: the earlier queued follow-up waited while the task ran, so the
      // immediate claim attempt starts it first instead of jumping the queue.
      expect(commands[1]).toMatchObject({
        type: "thread.turn.start",
        threadId: focusedThread.id,
        message: { text: "check if there are any PR's open" },
      });

      focusedThread = {
        ...focusedThread,
        latestTurn: { ...focusedThread.latestTurn!, state: "running", completedAt: null },
      };
      availableProviders = [];
      const commandCount = commands.length;
      const unavailableReroute = yield* manager.execute({
        sessionId,
        utterance: "do that last run in the Fable project",
        projectId: project.id,
        referenceThreadId: focusedThread.id,
      });
      expect(unavailableReroute.status).toBe("needs-input");
      expect(commands).toHaveLength(commandCount);

      availableProviders = [codexProvider];
      const rerouteStart = commands.length;
      const rerouted = yield* manager.execute({
        sessionId,
        utterance: "do that last run in the Fable project",
        projectId: targetProject.id,
        contextThreadId: focusedThread.id,
        referenceThreadId: focusedThread.id,
        continueContext: true,
      });
      expect(rerouted).toMatchObject({ status: "started", objective: "Fix authentication" });
      // Origin markers precede the first turn so a fast result cannot arrive
      // before the task is recognized as managed.
      expect(commands.slice(rerouteStart).map((command) => command.type)).toEqual([
        "thread.create",
        "thread.turn.interrupt",
        "thread.activity.append",
        "thread.activity.append",
        "thread.turn.start",
      ]);
      expect(commands[rerouteStart]).toMatchObject({
        type: "thread.create",
        projectId: targetProject.id,
        modelSelection: focusedThread.modelSelection,
      });

      const stopped = yield* manager.execute({
        sessionId,
        utterance: "stop that task",
        projectId: project.id,
        referenceThreadId: focusedThread.id,
      });
      expect(stopped).toMatchObject({
        status: "acknowledged",
        action: "interrupted",
        message: "I've stopped that task and cancelled its queued follow-ups.",
      });
      expect(cancelledThreadIds).toEqual([focusedThread.id]);
      expect(commands.at(-1)).toMatchObject({
        type: "thread.turn.interrupt",
        threadId: focusedThread.id,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("controls the explicitly named recent task instead of the focused task", () => {
    const commands: Array<OrchestrationCommand> = [];
    const enqueued: Array<{ threadId: ThreadId; requestMetadata?: JarvisRequestMetadata }> = [];
    const executionNodeId = EnvironmentId.make("node-controller");
    const targetProject = {
      ...project,
      id: ProjectId.make("project-fable-explicit-task"),
      title: "Fable",
      workspaceRoot: "/workspace/fable-explicit-task",
    };
    let focusedThread: OrchestrationThread = {
      ...sourceThread,
      id: ThreadId.make("thread-focused"),
      title: "Jarvis refactor",
      latestTurn: {
        turnId: TurnId.make("turn-focused"),
        state: "running",
        requestedAt: "2026-08-12T00:01:00.000Z",
        startedAt: "2026-08-12T00:01:01.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    };
    const authenticationTurn = {
      turnId: TurnId.make("turn-authentication"),
      state: "running",
      requestedAt: "2026-08-12T00:01:00.000Z",
      startedAt: "2026-08-12T00:01:01.000Z",
      completedAt: null,
      assistantMessageId: null,
    } satisfies NonNullable<OrchestrationThread["latestTurn"]>;
    let authenticationThread: OrchestrationThread = {
      ...sourceThread,
      id: ThreadId.make("thread-authentication"),
      title: "Authentication",
      modelSelection: {
        instanceId: codexProvider.instanceId,
        model: "gpt-5.6-sol",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
      runtimeMode: "auto-accept-edits",
      interactionMode: "plan",
      latestTurn: authenticationTurn,
    };
    let simulateFreshCompletion = true;
    const deskTask = (thread: OrchestrationThread) => ({
      threadId: thread.id,
      taskRef: {
        executionNodeId,
        threadId: thread.id,
      },
      projectRef: { nodeId: executionNodeId, projectId: thread.projectId },
    });
    const deskLayer = makeTaskDeskLayer({
      focusedTask: deskTask(focusedThread),
      recentTasks: [deskTask(focusedThread), deskTask(authenticationThread)],
      pendingInteraction: null,
      updatedAt: DateTime.makeUnsafe("2026-08-12T00:02:00.000Z"),
    });
    const interpreterLayer = Layer.succeed(JarvisControllerInterpreter, {
      interpret: (context) =>
        Effect.sync(() => {
          const prepared = prepareJarvisSemanticTurn(context);
          if (prepared.status === "needs-input") return prepared;
          const result = interpretJarvisCommand(
            context,
            prepared,
            testSemanticIntent(`Request: ${prepared.utterance}`),
          );
          if (
            simulateFreshCompletion &&
            /(?:stop|status of) the authentication task/iu.test(context.utterance)
          ) {
            authenticationThread = {
              ...authenticationThread,
              latestTurn: {
                ...authenticationTurn,
                state: "completed",
                completedAt: "2026-08-12T00:04:00.000Z",
              },
            };
          }
          return result;
        }),
    });
    const layer = makeJarvisControllerLive(interpreterLayer).pipe(
      Layer.provideMerge(
        makeImmediateFollowUpQueueLayer({
          onEnqueue: (input) => {
            enqueued.push({
              threadId: input.threadId,
              ...(input.requestMetadata === undefined
                ? {}
                : { requestMetadata: input.requestMetadata }),
            });
          },
        }),
      ),
      Layer.provideMerge(deskLayer),
      Layer.provideMerge(testLexiconLayer),
      Layer.provideMerge(ServerSettingsModule.ServerSettingsService.layerTest()),
      Layer.provideMerge(
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([codexProvider]) }),
      ),
      Layer.provideMerge(
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShellById: (projectId) =>
            Effect.succeed(Option.some(projectId === targetProject.id ? targetProject : project)),
          getThreadDetailById: (threadId) =>
            Effect.succeed(
              Option.fromUndefinedOr(
                [focusedThread, authenticationThread].find((thread) => thread.id === threadId),
              ),
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
      const controller = yield* JarvisController;
      const result = yield* controller.execute({
        sessionId,
        executionNodeId,
        utterance: "Tell the authentication task to use SQLite instead",
        projectId: project.id,
      });

      expect(result).toMatchObject({
        status: "acknowledged",
        action: "steered",
        threadId: authenticationThread.id,
      });
      const deferred = yield* controller.execute({
        sessionId,
        executionNodeId,
        utterance: "After the authentication task add release notes",
        projectId: project.id,
        requestMetadata: {
          requestId: "queue-auth-release-notes",
          origin: { originInteractionId: "interaction-auth-release-notes" },
        },
      });
      expect(deferred).toMatchObject({
        status: "acknowledged",
        action: "queued",
        threadId: authenticationThread.id,
        projectId: authenticationThread.projectId,
      });
      expect(enqueued).toEqual([
        expect.objectContaining({
          threadId: authenticationThread.id,
          requestMetadata: {
            requestId: "queue-auth-release-notes",
            origin: { originInteractionId: "interaction-auth-release-notes" },
          },
        }),
      ]);
      expect(commands).not.toContainEqual(
        expect.objectContaining({
          type: "thread.activity.append",
          activity: expect.objectContaining({ kind: "jarvis.turn.origin" }),
        }),
      );
      expect(commands).toHaveLength(1);
      authenticationThread = {
        ...authenticationThread,
        latestTurn: {
          ...authenticationTurn,
          state: "completed",
          completedAt: "2026-08-12T00:03:00.000Z",
        },
      };
      const queued = yield* controller.execute({
        sessionId,
        executionNodeId,
        utterance: "After the authentication task add release notes",
        projectId: project.id,
      });
      expect(queued).toMatchObject({
        status: "acknowledged",
        action: "queued",
        threadId: authenticationThread.id,
      });
      // FIFO through the single claim owner: the deferred follow-up waited
      // while the task ran, so it starts first with its origin marker intact
      // (origin append precedes turn start), ahead of the just-enqueued row.
      const queuedTurn = expect.objectContaining({
        type: "thread.turn.start",
        threadId: authenticationThread.id,
        modelSelection: authenticationThread.modelSelection,
        runtimeMode: authenticationThread.runtimeMode,
        interactionMode: authenticationThread.interactionMode,
      });
      expect(commands).toEqual([
        expect.objectContaining({
          type: "thread.turn.start",
          threadId: authenticationThread.id,
          message: expect.objectContaining({ text: "use SQLite instead" }),
        }),
        expect.objectContaining({
          type: "thread.activity.append",
          threadId: authenticationThread.id,
          activity: expect.objectContaining({ kind: "jarvis.turn.origin" }),
        }),
        queuedTurn,
      ]);

      authenticationThread = {
        ...authenticationThread,
        latestTurn: {
          ...authenticationTurn,
          state: "running",
          completedAt: null,
        },
      };
      const rerouteStart = commands.length;
      const rerouted = yield* controller.execute({
        sessionId,
        executionNodeId,
        utterance: "Move the authentication task to Fable",
        projectId: project.id,
      });
      expect(rerouted).toMatchObject({
        status: "started",
        projectId: targetProject.id,
      });
      expect(commands[rerouteStart]).toMatchObject({
        type: "thread.create",
        projectId: targetProject.id,
        modelSelection: authenticationThread.modelSelection,
        runtimeMode: authenticationThread.runtimeMode,
        interactionMode: authenticationThread.interactionMode,
      });
      expect(commands[rerouteStart + 1]).toMatchObject({
        type: "thread.turn.interrupt",
        threadId: authenticationThread.id,
        turnId: authenticationThread.latestTurn?.turnId,
      });

      const stopStart = commands.length;
      const stopped = yield* controller.execute({
        sessionId,
        executionNodeId,
        utterance: "Stop the authentication task",
        projectId: project.id,
      });
      expect(stopped).toMatchObject({
        status: "acknowledged",
        action: "status",
        threadId: authenticationThread.id,
        message: expect.stringContaining("not running"),
      });
      expect(commands).toHaveLength(stopStart);

      authenticationThread = {
        ...authenticationThread,
        latestTurn: {
          ...authenticationTurn,
          state: "running",
          completedAt: null,
        },
      };
      const status = yield* controller.execute({
        sessionId,
        executionNodeId,
        utterance: "Give me the status of the authentication task",
        projectId: project.id,
      });
      expect(status).toMatchObject({
        status: "acknowledged",
        action: "status",
        threadId: authenticationThread.id,
        message: expect.stringContaining("has finished"),
      });

      focusedThread = { ...focusedThread, title: "Authentication" };
      authenticationThread = {
        ...authenticationThread,
        latestTurn: authenticationTurn,
      };
      const clarification = yield* controller.execute({
        sessionId,
        executionNodeId,
        utterance: "Tell the authentication task to use SQLite instead",
        projectId: project.id,
      });
      expect(clarification).toMatchObject({
        status: "needs-input",
        taskClarification: { candidates: [{}, {}] },
      });

      const commandCount = commands.length;
      const clarifiedSteer = yield* controller.execute({
        sessionId,
        executionNodeId,
        utterance: "the second one",
        projectId: project.id,
      });
      expect(clarifiedSteer).toMatchObject({
        status: "acknowledged",
        action: "steered",
        threadId: authenticationThread.id,
      });
      expect(commands[commandCount]).toMatchObject({
        type: "thread.turn.start",
        threadId: authenticationThread.id,
      });

      const ambiguousQueue = yield* controller.execute({
        sessionId,
        executionNodeId,
        utterance: "After the authentication task add release notes",
        projectId: project.id,
      });
      expect(ambiguousQueue).toMatchObject({ status: "needs-input" });
      const queuedAfterChoice = yield* controller.execute({
        sessionId,
        executionNodeId,
        utterance: "the first one",
        projectId: project.id,
      });
      expect(queuedAfterChoice).toMatchObject({
        status: "acknowledged",
        action: "queued",
        threadId: authenticationThread.id,
      });
      expect(enqueued.at(-1)).toMatchObject({ threadId: authenticationThread.id });

      const ambiguousStatus = yield* controller.execute({
        sessionId,
        executionNodeId,
        utterance: "Give me the status of the authentication task",
        projectId: project.id,
      });
      expect(ambiguousStatus).toMatchObject({ status: "needs-input" });
      const statusAfterChoice = yield* controller.execute({
        sessionId,
        executionNodeId,
        utterance: "the first one",
        projectId: project.id,
      });
      expect(statusAfterChoice).toMatchObject({
        status: "acknowledged",
        action: "status",
        threadId: authenticationThread.id,
      });

      simulateFreshCompletion = false;
      authenticationThread = {
        ...authenticationThread,
        latestTurn: authenticationTurn,
        activities: [
          ...authenticationThread.activities,
          {
            id: EventId.make("approval-authentication"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Approval requested",
            payload: { requestId: "request-authentication" },
            turnId: authenticationTurn.turnId,
            createdAt: "2026-08-12T00:02:00.000Z",
          },
        ],
      };
      const ambiguousStop = yield* controller.execute({
        sessionId,
        executionNodeId,
        utterance: "Stop the authentication task",
        projectId: project.id,
      });
      expect(ambiguousStop).toMatchObject({ status: "needs-input" });
      const stopCommandCount = commands.length;
      const stoppedAfterChoice = yield* controller.execute({
        sessionId,
        executionNodeId,
        utterance: "the first one",
        projectId: project.id,
      });
      expect(stoppedAfterChoice).toMatchObject({
        status: "acknowledged",
        action: "interrupted",
        threadId: authenticationThread.id,
      });
      expect(commands[stopCommandCount]).toMatchObject({
        type: "thread.turn.interrupt",
        threadId: authenticationThread.id,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("creates and starts a T3 thread through the selected provider", () => {
    const commands: Array<OrchestrationCommand> = [];
    const createdThreadIds = new Set<ThreadId>();
    const layer = JarvisControllerLive.pipe(
      Layer.provideMerge(testLexiconLayer),
      Layer.provideMerge(ServerSettingsModule.ServerSettingsService.layerTest()),
      Layer.provideMerge(
        Layer.mock(ProviderRegistry)({
          getProviders: Effect.succeed([codexProvider]),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShellById: (projectId) =>
            Effect.succeed(projectId === project.id ? Option.some(project) : Option.none()),
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 1,
              projects: [project],
              threads: [],
              updatedAt: "2026-08-12T00:02:00.000Z",
            }),
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
      const manager = yield* JarvisController;
      const result = yield* manager.execute({
        sessionId,
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
        "thread.activity.append",
        "thread.turn.start",
      ]);
      expect(commands[0]).toMatchObject({
        type: "thread.create",
        threadId: result.threadId,
        projectId: project.id,
        title: "Implement device presence",
        modelSelection: result.modelSelection,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      expect(commands[1]).toMatchObject({
        type: "thread.activity.append",
        threadId: result.threadId,
        activity: { kind: "jarvis.task.created" },
      });
      expect(commands[2]).toMatchObject({
        type: "thread.turn.start",
        threadId: result.threadId,
        message: {
          role: "user",
          text: "Implement device presence.",
          attachments: [],
        },
        modelSelection: result.modelSelection,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: "default",
      });
      expect(commands[2]).not.toHaveProperty("bootstrap");
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps the accepted task when desk focus maintenance fails", () => {
    const commands: Array<OrchestrationCommand> = [];
    const createdThreadIds = new Set<ThreadId>();
    const emptyDesk = {
      focusedTask: null,
      recentTasks: [],
      pendingInteraction: null,
      updatedAt: null,
    };
    const layer = JarvisControllerLive.pipe(
      Layer.provideMerge(
        Layer.mock(JarvisTaskDesk)({
          get: () => Effect.succeed(emptyDesk),
          focus: () => Effect.die(new Error("desk unavailable")),
          setPendingInteraction: () => Effect.succeed(emptyDesk),
          consumePendingInteraction: () => Effect.succeed(null),
          clearPendingInteraction: () => Effect.succeed(emptyDesk),
        }),
      ),
      Layer.provideMerge(testFollowUpQueueLayer),
      Layer.provideMerge(testLexiconLayer),
      Layer.provideMerge(ServerSettingsModule.ServerSettingsService.layerTest()),
      Layer.provideMerge(
        Layer.mock(ProviderRegistry)({
          getProviders: Effect.succeed([codexProvider]),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShellById: (projectId) =>
            Effect.succeed(projectId === project.id ? Option.some(project) : Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 1,
              projects: [project],
              threads: [],
              updatedAt: "2026-08-12T00:02:00.000Z",
            }),
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
      const manager = yield* JarvisController;
      const result = yield* manager.execute({
        sessionId,
        utterance: "Jarvis, use Codex Sol high to implement device presence.",
        projectId: project.id,
      });

      // The accepted turn dispatch is the outcome: origin first, then the
      // turn, and a desk failure afterwards cannot fail the request.
      expect(result.status).toBe("started");
      expect(commands.map((command) => command.type)).toEqual([
        "thread.create",
        "thread.activity.append",
        "thread.turn.start",
      ]);
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
    const layer = JarvisControllerLive.pipe(
      Layer.provideMerge(testLexiconLayer),
      Layer.provideMerge(ServerSettingsModule.ServerSettingsService.layerTest()),
      Layer.provideMerge(
        Layer.mock(ProviderRegistry)({
          getProviders: Effect.succeed([codexProvider]),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShellById: () => Effect.succeed(Option.some(project)),
          getThreadDetailById: () => Effect.succeed(existingThread),
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 1,
              projects: [project],
              threads: [],
              updatedAt: "2026-08-12T00:02:00.000Z",
            }),
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
      const manager = yield* JarvisController;
      const input = {
        sessionId,
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
          threadId: first.status === "started" ? first.threadId : undefined,
        },
        requestMetadata,
      });
      expect(second).toEqual(first);
      expect(commands.map((command) => command.type)).toEqual([
        "thread.create",
        "thread.activity.append",
        "thread.turn.start",
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
            summary: "Started by the T3 Jarvis controller",
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
      // Retries identified only through requestMetadata reconcile the same way.
      const derivedConflict = yield* manager
        .execute({
          ...input,
          acceptanceKey: undefined,
          utterance: "Implement a different task.",
        })
        .pipe(Effect.result);
      expect(derivedConflict._tag).toBe("Failure");
      if (derivedConflict._tag === "Failure") {
        expect(derivedConflict.failure._tag).toBe("JarvisRequestConflictError");
      }
      expect(commands).toHaveLength(3);
    }).pipe(Effect.provide(layer));
  });

  it.effect("confirms and compiles a grounded spoken project before starting the task", () => {
    const commands: Array<OrchestrationCommand> = [];
    const rivvlProject = {
      ...project,
      id: ProjectId.make("project-rivvl"),
      title: "Rivvl",
      workspaceRoot: "/workspace/rivvl",
    };
    const alertifyProject = {
      ...project,
      id: ProjectId.make("project-alertify"),
      title: "Alertify",
      workspaceRoot: "/workspace/Alertify",
    };
    const rivvlAttentionThread: OrchestrationThread = {
      ...sourceThread,
      id: ThreadId.make("thread-rivvl-attention"),
      projectId: rivvlProject.id,
      title: "Rivvl task",
    };
    const layer = JarvisControllerLive.pipe(
      Layer.provideMerge(testLexiconLayer),
      Layer.provideMerge(ServerSettingsModule.ServerSettingsService.layerTest()),
      Layer.provideMerge(
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([codexProvider]) }),
      ),
      Layer.provideMerge(
        Layer.mock(ProjectionSnapshotQuery)({
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 1,
              projects: [rivvlProject, alertifyProject],
              threads: [],
              updatedAt: "2026-08-12T00:02:00.000Z",
            }),
          getProjectShellById: (projectId) =>
            Effect.succeed(
              Option.some(projectId === alertifyProject.id ? alertifyProject : rivvlProject),
            ),
          getThreadDetailById: (threadId) =>
            Effect.succeed(
              threadId === rivvlAttentionThread.id
                ? Option.some(rivvlAttentionThread)
                : Option.none(),
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
      const manager = yield* JarvisController;
      const input = {
        sessionId,
        utterance: "I need you to check out Zivil.",
        projectId: alertifyProject.id,
        contextThreadId: rivvlAttentionThread.id,
        referenceThreadId: rivvlAttentionThread.id,
        requestMetadata: {
          requestId: "voice-rivvl",
          inputMode: "voice" as const,
          sourceUtterance: "I need you to check out Zivil.",
        },
        modelSelection: {
          instanceId: codexProvider.instanceId,
          model: "gpt-5.6-sol",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      };
      const clarification = yield* manager.execute(input);
      expect(clarification).toMatchObject({
        status: "needs-input",
        prompt: "Did you mean Rivvl?",
        choices: ["Rivvl"],
      });
      expect(commands).toEqual([]);

      const result = yield* manager.execute({
        ...input,
        confirmedProjectId: rivvlProject.id,
        confirmedProjectAlias: "zivil",
      });

      expect(result).toMatchObject({
        status: "started",
        projectId: rivvlProject.id,
        objective: "I need you to check out Rivvl.",
      });
      expect(commands[0]).toMatchObject({
        type: "thread.create",
        projectId: rivvlProject.id,
        runtimeMode: "full-access",
      });
      expect(commands[1]).toMatchObject({
        type: "thread.activity.append",
        activity: { kind: "jarvis.task.created" },
      });
      expect(commands[2]).toMatchObject({
        type: "thread.turn.start",
        message: { text: "I need you to check out Rivvl." },
        runtimeMode: "full-access",
      });
      expect(
        commands.find(
          (command) =>
            command.type === "thread.activity.append" &&
            command.activity.kind === "jarvis.task.created",
        ),
      ).toMatchObject({
        activity: {
          summary: "Codex is starting in Rivvl",
          payload: {
            objective: "I need you to check out Rivvl.",
            requestMetadata: {
              sourceUtterance: "I need you to check out Zivil.",
            },
          },
        },
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses an explicit request model selection for a plain voice objective", () => {
    const commands: Array<OrchestrationCommand> = [];
    const layer = JarvisControllerLive.pipe(
      Layer.provideMerge(testLexiconLayer),
      Layer.provideMerge(ServerSettingsModule.ServerSettingsService.layerTest()),
      Layer.provideMerge(
        Layer.mock(ProviderRegistry)({
          getProviders: Effect.succeed([codexProvider]),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShellById: () => Effect.succeed(Option.some(project)),
          getThreadDetailById: () => Effect.succeed(Option.none()),
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 1,
              projects: [project],
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
      const manager = yield* JarvisController;
      const result = yield* manager.execute({
        sessionId,
        utterance: "Implement device presence.",
        projectId: project.id,
        requestMetadata: { requestId: "voice-request-1", inputMode: "voice" },
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
        type: "thread.activity.append",
        activity: { kind: "jarvis.task.created" },
      });
      expect(commands[2]).toMatchObject({
        type: "thread.turn.start",
        message: {
          text: "Implement device presence.",
        },
        modelSelection: {
          instanceId: "codex",
          model: "gpt-5.6-sol",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      });
      expect(commands[2]).toMatchObject({
        message: { text: "Implement device presence." },
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
    const layer = JarvisControllerLive.pipe(
      Layer.provideMerge(testLexiconLayer),
      Layer.provideMerge(ServerSettingsModule.ServerSettingsService.layerTest()),
      Layer.provideMerge(
        Layer.mock(ProviderRegistry)({
          getProviders: Effect.succeed([providerWithDefaults]),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShellById: () => Effect.succeed(Option.some(projectWithDefault)),
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 1,
              projects: [projectWithDefault],
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
      const manager = yield* JarvisController;
      const result = yield* manager.execute({
        sessionId,
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
        "thread.activity.append",
        "thread.turn.start",
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
    const layer = JarvisControllerLive.pipe(
      Layer.provideMerge(testLexiconLayer),
      Layer.provideMerge(ServerSettingsModule.ServerSettingsService.layerTest()),
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
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 1,
              projects: [project],
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
      const manager = yield* JarvisController;
      const result = yield* manager.execute({
        sessionId,
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
        "thread.activity.append",
        "thread.activity.append",
        "thread.turn.start",
      ]);
      expect(commands[0]).toMatchObject({
        type: "thread.create",
        threadId: result.threadId,
        modelSelection: result.modelSelection,
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
          payload: {
            sourceThreadId: sourceThread.id,
            objective: "Review this Codex output.",
          },
        },
      });
      expect(commands[3]).toMatchObject({
        type: "thread.turn.start",
        threadId: result.threadId,
        message: {
          text: expect.stringContaining("Implemented presence with a five-second polling loop."),
        },
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("continues the chosen conversation for any new voice instruction", () => {
    const commands: Array<OrchestrationCommand> = [];
    const freshSelection: ModelSelection = {
      instanceId: codexProvider.instanceId,
      model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    };
    let liveThread = sourceThread;
    let clearPendingAfterNextRead = false;
    const interpreterLayer = Layer.succeed(JarvisControllerInterpreter, {
      interpret: (context) =>
        Effect.sync(() => {
          const prepared = prepareJarvisSemanticTurn(context);
          if (prepared.status === "needs-input") return prepared;
          const result = interpretJarvisCommand(
            context,
            prepared,
            testSemanticIntent(`Request: ${prepared.utterance}`),
          );
          liveThread = {
            ...liveThread,
            modelSelection: freshSelection,
            runtimeMode: "auto-accept-edits",
            interactionMode: "plan",
            ...(/already resolved/iu.test(context.utterance) ? { activities: [] } : {}),
          };
          return result;
        }),
    });
    const layer = makeJarvisControllerLive(interpreterLayer).pipe(
      Layer.provideMerge(testFollowUpQueueLayer),
      Layer.provideMerge(testTaskDeskLayer),
      Layer.provideMerge(testLexiconLayer),
      Layer.provideMerge(ServerSettingsModule.ServerSettingsService.layerTest()),
      Layer.provideMerge(
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([codexProvider]) }),
      ),
      Layer.provideMerge(
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShellById: () => Effect.succeed(Option.some(project)),
          getThreadDetailById: () =>
            Effect.sync(() => {
              const current = liveThread;
              if (clearPendingAfterNextRead) {
                clearPendingAfterNextRead = false;
                liveThread = { ...liveThread, activities: [] };
              }
              return Option.some(current);
            }),
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 1,
              projects: [project],
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
      const manager = yield* JarvisController;
      const result = yield* manager.execute({
        sessionId,
        utterance: "Add an integration test for the new path.",
        projectId: project.id,
        contextThreadId: sourceThread.id,
        continueContext: true,
      });

      expect(result).toMatchObject({
        status: "started",
        threadId: sourceThread.id,
        objective: "Add an integration test for the new path.",
        modelSelection: freshSelection,
      });
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        type: "thread.turn.start",
        threadId: sourceThread.id,
        message: { role: "user", text: "Add an integration test for the new path." },
        modelSelection: freshSelection,
        runtimeMode: "auto-accept-edits",
        interactionMode: "plan",
      });

      liveThread = {
        ...sourceThread,
        activities: [
          {
            id: EventId.make("stale-input-request"),
            tone: "info",
            kind: "user-input.requested",
            summary: "Continue?",
            payload: { requestId: "stale-request", questions: [{ id: "continue" }] },
            turnId: null,
            createdAt: "2026-08-12T00:01:00.000Z",
          },
        ],
      };
      clearPendingAfterNextRead = true;
      const commandCount = commands.length;
      const staleAnswer = yield* manager.execute({
        sessionId,
        utterance: "That question was already resolved.",
        projectId: project.id,
        contextThreadId: sourceThread.id,
        continueContext: true,
      });
      expect(staleAnswer).toMatchObject({
        status: "needs-input",
        reason: "source-output-unavailable",
      });
      expect(commands).toHaveLength(commandCount);
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
    const layer = JarvisControllerLive.pipe(
      Layer.provideMerge(testLexiconLayer),
      Layer.provideMerge(ServerSettingsModule.ServerSettingsService.layerTest()),
      Layer.provideMerge(
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([codexProvider]) }),
      ),
      Layer.provideMerge(
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShellById: () => Effect.succeed(Option.some(selectedProject)),
          getThreadDetailById: () => Effect.succeed(Option.some(sourceThread)),
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 1,
              projects: [selectedProject],
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
      const manager = yield* JarvisController;
      const result = yield* manager.execute({
        sessionId,
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
    const layer = JarvisControllerLive.pipe(
      Layer.provideMerge(testLexiconLayer),
      Layer.provideMerge(ServerSettingsModule.ServerSettingsService.layerTest()),
      Layer.provideMerge(
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([codexProvider]) }),
      ),
      Layer.provideMerge(
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShellById: () => Effect.succeed(Option.some(project)),
          getThreadDetailById: () => Effect.succeed(Option.none()),
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 1,
              projects: [project],
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
      const manager = yield* JarvisController;
      const result = yield* manager.execute({
        sessionId,
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
    const pendingReplyInterpreter = Layer.succeed(JarvisControllerInterpreter, {
      interpret: () => Effect.die("Pending replies must not invoke semantic generation."),
    });
    const layer = makeJarvisControllerLive(pendingReplyInterpreter).pipe(
      Layer.provideMerge(testFollowUpQueueLayer),
      Layer.provideMerge(testTaskDeskLayer),
      Layer.provideMerge(testLexiconLayer),
      Layer.provideMerge(ServerSettingsModule.ServerSettingsService.layerTest()),
      Layer.provideMerge(
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([codexProvider]) }),
      ),
      Layer.provideMerge(
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShellById: () => Effect.succeed(Option.some(project)),
          getThreadDetailById: () => Effect.succeed(Option.some(pendingThread)),
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 1,
              projects: [project],
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
      const manager = yield* JarvisController;
      const result = yield* manager.execute({
        sessionId,
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

  it.effect(
    "keeps project clarification and its follow-up inside one controller turn owner",
    () => {
      const commands: Array<OrchestrationCommand> = [];
      const rivvlProject = {
        ...project,
        id: ProjectId.make("project-rivvl-controller"),
        title: "Rivvl",
        workspaceRoot: "/workspace/rivvl-controller",
      };
      let deskState: JarvisTaskDeskState = {
        focusedTask: null,
        recentTasks: [],
        pendingInteraction: null,
        updatedAt: null,
      };
      let shellReads = 0;
      let interpretationCount = 0;
      const deskLayer = makeTaskDeskLayer(deskState, (next) => {
        deskState = next;
      });
      const interpreterLayer = Layer.succeed(JarvisControllerInterpreter, {
        interpret: (context) => {
          interpretationCount += 1;
          const prepared = prepareJarvisSemanticTurn(context);
          return Effect.succeed(
            prepared.status === "needs-input"
              ? prepared
              : interpretJarvisCommand(
                  context,
                  prepared,
                  testSemanticIntent(`Request: ${prepared.utterance}`),
                ),
          );
        },
      });
      const layer = makeJarvisControllerLive(interpreterLayer).pipe(
        Layer.provideMerge(testFollowUpQueueLayer),
        Layer.provideMerge(testLexiconLayer),
        Layer.provideMerge(deskLayer),
        Layer.provideMerge(
          ServerSettingsModule.ServerSettingsService.layerTest({
            jarvisDefaultModelSelection: null,
          }),
        ),
        Layer.provideMerge(
          Layer.mock(ProviderRegistry)({
            getProviders: Effect.succeed([codexProvider]),
          }),
        ),
        Layer.provideMerge(
          Layer.mock(ProjectionSnapshotQuery)({
            getProjectShellById: (projectId) =>
              Effect.succeed(Option.some(projectId === rivvlProject.id ? rivvlProject : project)),
            getShellSnapshot: () =>
              Effect.sync(() => {
                shellReads += 1;
                return {
                  snapshotSequence: shellReads,
                  projects: [project, rivvlProject],
                  threads: [],
                  updatedAt: "2026-08-12T00:02:00.000Z",
                };
              }),
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
        const controller = yield* JarvisController;
        const input = {
          sessionId,
          utterance: "I need you to check out Zivil.",
          projectId: project.id,
          executionNodeId: EnvironmentId.make("node-controller"),
          modelSelection: {
            instanceId: codexProvider.instanceId,
            model: "gpt-5.6-sol",
            options: [{ id: "reasoningEffort", value: "high" as const }],
          },
          requestMetadata: {
            requestId: "controller-clarification",
            inputMode: "voice" as const,
            sourceUtterance: "I need you to check out Zivil.",
          },
        };
        const clarification = yield* controller.execute(input);
        expect(clarification).toMatchObject({
          status: "needs-input",
          prompt: "Did you mean Rivvl?",
          choices: ["Rivvl"],
        });
        expect(deskState.pendingInteraction?.kind).toBe("project");
        expect(commands).toHaveLength(0);
        expect(shellReads).toBe(1);
        expect(interpretationCount).toBe(1);

        const result = yield* controller.execute({ ...input, utterance: "yes" });
        expect(result).toMatchObject({ status: "started", projectId: rivvlProject.id });
        expect(deskState.pendingInteraction).toBeNull();
        expect(deskState.focusedTask?.projectRef?.projectId).toBe(rivvlProject.id);
        expect(commands.map((command) => command.type)).toEqual([
          "thread.create",
          "thread.activity.append",
          "thread.turn.start",
        ]);
        expect(shellReads).toBe(2);
        expect(interpretationCount).toBe(2);
      }).pipe(Effect.provide(layer));
    },
  );
});
