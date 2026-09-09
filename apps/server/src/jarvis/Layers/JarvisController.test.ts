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
import * as Fiber from "effect/Fiber";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Crypto from "effect/Crypto";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationCommandInvariantError } from "../../orchestration/Errors.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import * as ServerSettingsModule from "../../serverSettings.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { JarvisController, JarvisControllerInterpreter } from "../Services/JarvisController.ts";
import { JarvisProjectLexicon } from "../Services/JarvisProjectLexicon.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { JarvisFollowUpDispatcher } from "../Services/JarvisFollowUpDispatcher.ts";
import { JarvisFollowUpQueue } from "../Services/JarvisFollowUpQueue.ts";
import { JarvisTaskDesk } from "../Services/JarvisTaskDesk.ts";
import {
  makeJarvisControllerInterpreterLive,
  makeJarvisControllerLive as makeControllerLive,
} from "./JarvisController.ts";
import {
  interpretJarvisCommand,
  JarvisSemanticProposal,
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
  reconcileAccepted: () => Effect.void,
  release: () => Effect.void,
  resetRunning: () => Effect.void,
  statusOf: () => Effect.succeed(Option.none()),
  cancelPending: () => Effect.succeed(0),
  listPendingThreadIds: () => Effect.succeed([]),
  pendingCount: () => Effect.succeed(0),
});

/**
 * Minimal honest queue: enqueue persists, claimNext atomically takes the
 * oldest pending row, and the shared dispatcher worker starts its turn.
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
    enqueuedAt: string;
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
          enqueuedAt: input.enqueuedAt,
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
          enqueuedAt: row.enqueuedAt,
        });
      }),
    reconcileAccepted: () => Effect.void,
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
    consumePendingInteraction: ({ expectedFrameId, focusTask }) =>
      Effect.sync(() => {
        const pending = state.pendingInteraction;
        if (
          pending !== null &&
          expectedFrameId !== undefined &&
          pending.frame.frameId !== expectedFrameId
        ) {
          return null;
        }
        state = {
          ...state,
          pendingInteraction: null,
          ...(focusTask === undefined ? {} : { focusedTask: focusTask }),
        };
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

function testSemanticIntent(prompt: string): JarvisSemanticProposal {
  const request = /^Request: (.*)$/mu.exec(prompt)?.[1] ?? "";
  const source = /^Original transcript: (.*)$/mu.exec(prompt)?.[1] ?? request;
  const continuing = /^Continue selected conversation: true$/mu.test(prompt);
  const spanFor = (needle: string) => {
    const exact = source.indexOf(needle);
    if (exact >= 0) {
      return {
        start: exact,
        end: exact + needle.length,
        text: source.slice(exact, exact + needle.length),
      };
    }
    const lowered = source.toLocaleLowerCase("en-US").indexOf(needle.toLocaleLowerCase("en-US"));
    if (lowered < 0) return undefined;
    return {
      start: lowered,
      end: lowered + needle.length,
      text: source.slice(lowered, lowered + needle.length),
    };
  };
  const taskRef = (name: string) => {
    const span = spanFor(name);
    return span === undefined ? [] : [{ span, role: "task" as const, value: name }];
  };
  const destinationRef = (name: string) => {
    const span = spanFor(name);
    return span === undefined ? [] : [{ span, role: "destination" as const, value: name }];
  };
  const providerRef = (name: string) => {
    const span = spanFor(name);
    return span === undefined ? [] : [{ span, role: "provider" as const, value: name }];
  };
  const proposal = (input: {
    readonly action: JarvisSemanticProposal["action"];
    readonly refs?: JarvisSemanticProposal["refs"];
    readonly model?: string | null;
    readonly effort?: string | null;
    readonly answer?: string | null;
  }): JarvisSemanticProposal => ({
    action: input.action,
    refs: input.refs ?? [],
    model: input.model ?? null,
    effort: input.effort ?? null,
    answer: input.answer ?? null,
  });
  if (/what projects are there/iu.test(request)) return proposal({ action: "list-projects" });
  // Compound controls join two independent tasks with then: the supervisor
  // must refuse as one turn so the lead fragment never dispatches.
  if (/fix auth then add release notes/iu.test(request)) return proposal({ action: "unsupported" });
  // A bare negated control names no actionable work: a correct model
  // refuses instead of proposing a stop the transcript ruled out.
  if (/don't stop task/iu.test(request)) return proposal({ action: "unsupported" });
  const focusedProject = /^Switch to (?:the )?(.+?) project[.!]?$/iu.exec(request)?.[1];
  if (focusedProject !== undefined) {
    const name = focusedProject.trim();
    return proposal({ action: "focus-project", refs: destinationRef(name) });
  }
  if (/authentication task.*use SQLite instead/iu.test(request))
    return proposal({ action: "steer", refs: taskRef("Authentication") });
  if (/actually use SQLite instead/iu.test(request)) return proposal({ action: "steer" });
  if (/authentication task.*add release notes/iu.test(request))
    return proposal({ action: "queue", refs: taskRef("Authentication") });
  if (/in that Jarvis request/iu.test(request)) return proposal({ action: "queue" });
  if (/after that add release notes/iu.test(request)) return proposal({ action: "queue" });
  if (/do that last run in the Fable project/iu.test(request))
    return proposal({ action: "reroute", refs: destinationRef("Fable") });
  if (/move the authentication task to Fable/iu.test(request))
    return proposal({
      action: "reroute",
      refs: [...taskRef("Authentication"), ...destinationRef("Fable")],
    });
  if (/stop the authentication task/iu.test(request))
    return proposal({ action: "stop", refs: taskRef("Authentication") });
  if (/stop that task/iu.test(request)) return proposal({ action: "stop" });
  if (/status of the authentication task/iu.test(request))
    return proposal({ action: "status", refs: taskRef("Authentication") });
  if (/status of the legacy billing flow/iu.test(request))
    return proposal({ action: "status", refs: taskRef("legacy billing flow") });
  if (/use Fable to review this Codex output/iu.test(request))
    return proposal({ action: "review", refs: providerRef("Fable"), model: "Reviewer" });
  if (/use Codex Sol high to implement device presence/iu.test(request))
    return proposal({ action: "start", refs: providerRef("Codex"), model: "Sol", effort: "High" });
  if (/already resolved/iu.test(request)) return proposal({ action: "continue" });
  if (continuing) return proposal({ action: "continue" });
  return proposal({ action: "start" });
}

const decodeTestSemanticIntent = Schema.decodeUnknownEffect(JarvisSemanticProposal);

// The supervisor classifies direction only: replies below are proposed as
// continuations, and the deterministic validator authorizes which live
// request (if any) each answers. The model never invents request identity.
const continueReplyInterpreter = (instruction: string) =>
  Layer.succeed(JarvisControllerInterpreter, {
    interpret: (context) => {
      const prepared = prepareJarvisSemanticTurn(context);
      if (prepared.status === "needs-input") return Effect.succeed(prepared);
      return Effect.succeed(
        interpretJarvisCommand(context, prepared, {
          action: "continue",
          refs: [],
          model: null,
          effort: null,
          answer: null,
        }),
      );
    },
    propose: (input) =>
      Effect.succeed({
        action: "continue" as const,
        refs: [],
        model: null,
        effort: null,
        answer: null,
      }),
  });

// A directed proposal for explicit controls: proves the deterministic prepass
// defers the utterance instead of authorizing anything itself.
const stopIntentInterpreter = Layer.succeed(JarvisControllerInterpreter, {
  interpret: (context) => {
    const prepared = prepareJarvisSemanticTurn(context);
    if (prepared.status === "needs-input") return Effect.succeed(prepared);
    return Effect.succeed(
      interpretJarvisCommand(context, prepared, {
        action: "stop",
        refs: [],
        model: null,
        effort: null,
        answer: null,
      }),
    );
  },
});

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
const makeJarvisControllerLive = <R>(
  interpreter: Layer.Layer<JarvisControllerInterpreter, never, R>,
) =>
  makeControllerLive(interpreter).pipe(
    Layer.provide(
      Layer.mock(ProjectionTurnRepository)({
        getPendingTurnStartByThreadId: () => Effect.succeed(Option.none()),
      }),
    ),
  );
const TestJarvisControllerLive = makeJarvisControllerLive(testInterpreterLayer);

const JarvisControllerLive = TestJarvisControllerLive.pipe(
  Layer.provideMerge(testFollowUpQueueLayer),
  Layer.provideMerge(testTaskDeskLayer),
);

describe("JarvisController", () => {
  it.effect("starts a task without hydrating every recent thread first", () => {
    const commands: Array<OrchestrationCommand> = [];
    const executionNodeId = EnvironmentId.make("node-controller-shell");
    const recentTasks = Array.from({ length: 20 }, (_, index) => {
      const threadId = ThreadId.make(`thread-recent-${index}`);
      return {
        threadId,
        taskRef: { executionNodeId, threadId },
        projectRef: { nodeId: executionNodeId, projectId: project.id },
      };
    });
    const shellThreads = recentTasks.map((task, index) => ({
      id: task.threadId,
      projectId: project.id,
      title: `Recent task ${index}`,
      modelSelection: { instanceId: codexProvider.instanceId, model: "gpt-5.6-sol" },
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: "default" as const,
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:01:00.000Z",
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      session: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    }));
    let detailCalls = 0;
    // Build on the raw constructor: JarvisControllerLive pre-merges the
    // empty-desk layer, which would silently win over a custom desk here.
    const layer = makeJarvisControllerLive(testInterpreterLayer).pipe(
      Layer.provideMerge(testFollowUpQueueLayer),
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
        makeTaskDeskLayer({
          focusedTask: null,
          recentTasks,
          pendingInteraction: null,
          updatedAt: null,
        }),
      ),
      Layer.provideMerge(
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShellById: () => Effect.succeed(Option.some(project)),
          getThreadDetailById: () =>
            Effect.sync(() => {
              detailCalls += 1;
              return Option.none();
            }),
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 1,
              projects: [project],
              threads: shellThreads,
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
        executionNodeId,
        utterance: "Jarvis, implement device presence.",
        projectId: project.id,
      });
      expect(result).toMatchObject({ status: "started" });
      // Navigation runs on the shell snapshot: starting new work with 20
      // catalogued recent tasks hydrates detail only for the 8 the
      // supervisor can name, not all 20 plus context and reference.
      expect(detailCalls).toBe(8);
      expect(commands.filter((command) => command.type === "thread.create")).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("still matches a renamed task by its original objective", () => {
    const executionNodeId = EnvironmentId.make("node-controller-objective");
    const renamedId = ThreadId.make("thread-renamed");
    // Renamed after creation: the shell title no longer contains the words
    // the user quotes, but the first user message still does.
    const renamedThread: OrchestrationThread = {
      ...sourceThread,
      id: renamedId,
      title: "Billing overhaul",
      messages: [
        {
          id: MessageId.make("message-renamed-objective"),
          role: "user",
          text: "Legacy billing flow",
          turnId: null,
          streaming: false,
          createdAt: "2026-08-12T00:01:00.000Z",
          updatedAt: "2026-08-12T00:01:00.000Z",
        },
      ],
    };
    const shellThread = {
      id: renamedId,
      projectId: project.id,
      title: "Billing overhaul",
      modelSelection: { instanceId: codexProvider.instanceId, model: "gpt-5.6-sol" },
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: "default" as const,
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:01:00.000Z",
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      session: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    };
    // Build on the raw constructor (see above): the shared live layer would
    // silently keep its empty-desk layer over this custom desk.
    const layer = makeJarvisControllerLive(testInterpreterLayer).pipe(
      Layer.provideMerge(testFollowUpQueueLayer),
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
        makeTaskDeskLayer({
          focusedTask: null,
          recentTasks: [
            {
              threadId: renamedId,
              taskRef: { executionNodeId, threadId: renamedId },
              projectRef: { nodeId: executionNodeId, projectId: project.id },
            },
          ],
          pendingInteraction: null,
          updatedAt: null,
        }),
      ),
      Layer.provideMerge(
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShellById: () => Effect.succeed(Option.some(project)),
          getThreadDetailById: (threadId) =>
            Effect.succeed(threadId === renamedId ? Option.some(renamedThread) : Option.none()),
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 1,
              projects: [project],
              threads: [shellThread],
              updatedAt: "2026-08-12T00:02:00.000Z",
            }),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(OrchestrationEngineService)({
          dispatch: () => Effect.succeed({ sequence: 1 }),
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
        executionNodeId,
        utterance: "What is the status of the legacy billing flow",
        projectId: project.id,
      });
      // Title-only matching would miss this task and ask which task was
      // meant; the original objective still resolves it directly.
      expect(result).toMatchObject({
        status: "acknowledged",
        action: "status",
        threadId: renamedId,
      });
    }).pipe(Effect.provide(layer));
  });

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
          acknowledgement: "Request accepted for Jarvis.",
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

  it.effect(
    "clarifies mesh focus-project without target evidence instead of ambient (dev-asr-01)",
    () => {
      const rivvlProject = {
        ...project,
        id: ProjectId.make("project-rivvl-mesh-guard"),
        title: "Rivvl",
        workspaceRoot: "/workspace/rivvl-mesh-guard",
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
            dispatch: () => Effect.die("Focus without evidence must not dispatch"),
            readEvents: () => Stream.empty,
            streamDomainEvents: Stream.empty,
            latestSequence: Effect.succeed(0),
          }),
        ),
        Layer.provideMerge(testCryptoLayer),
      );

      return Effect.gen(function* () {
        const manager = yield* JarvisController;
        const source = "Switch to the Rivvil project.";
        // Live wrong-accept shape: model omitted the destination ref, so the
        // mesh proposal carries no positive target evidence. The host must
        // clarify with the verbatim source preserved, never focus ambient.
        const clarified = yield* manager.execute({
          sessionId,
          utterance: source,
          projectId: project.id,
          sourceUtterance: source,
          semanticProposal: {
            action: "focus-project",
            refs: [],
            model: null,
            effort: null,
            answer: null,
          },
        });
        expect(clarified).toMatchObject({
          status: "needs-input",
          reason: "control-target-required",
        });
        expect(clarified).not.toMatchObject({
          status: "acknowledged",
          action: "focused",
        });

        // Exact evidence on the same mesh path still focuses the named project.
        const exactSource = "Switch to Rivvl.";
        const at = exactSource.indexOf("Rivvl");
        const focused = yield* manager.execute({
          sessionId,
          utterance: exactSource,
          projectId: project.id,
          sourceUtterance: exactSource,
          semanticProposal: {
            action: "focus-project",
            refs: [
              {
                span: { start: at, end: at + "Rivvl".length, text: "Rivvl" },
                role: "destination",
                value: "Rivvl",
              },
            ],
            model: null,
            effort: null,
            answer: null,
          },
        });
        expect(focused).toMatchObject({
          status: "acknowledged",
          action: "focused",
          projectId: rivvlProject.id,
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("returns the exact task identity when switch-focus targets a task", () => {
    const executionNodeId = EnvironmentId.make("node-controller-focus-task");
    const focusThread: OrchestrationThread = {
      ...sourceThread,
      id: ThreadId.make("thread-focus-target"),
      title: "Authentication",
    };
    const focusShellThread = {
      id: focusThread.id,
      projectId: project.id,
      title: "Authentication",
      modelSelection: { instanceId: codexProvider.instanceId, model: "gpt-5.6-sol" },
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: "default" as const,
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:01:00.000Z",
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      session: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    };
    const deskTask = {
      threadId: focusThread.id,
      taskRef: { executionNodeId, threadId: focusThread.id },
      projectRef: { nodeId: executionNodeId, projectId: focusThread.projectId },
    };
    const interpreterLayer = Layer.succeed(JarvisControllerInterpreter, {
      interpret: (context) =>
        Effect.sync(() => {
          const prepared = prepareJarvisSemanticTurn(context);
          if (prepared.status === "needs-input") return prepared;
          const source = prepared.sourceUtterance;
          // Schema-exact span: find the heard text case-insensitively but
          // cite the source slice byte-for-byte so value echoes its span.
          const at = source.toLocaleLowerCase("en-US").indexOf("authentication");
          return interpretJarvisCommand(context, prepared, {
            action: "focus-task",
            refs:
              at < 0
                ? []
                : [
                    {
                      span: {
                        start: at,
                        end: at + "Authentication".length,
                        text: source.slice(at, at + "Authentication".length),
                      },
                      role: "task",
                      value: "Authentication",
                    },
                  ],
            model: null,
            effort: null,
            answer: null,
          });
        }),
    });
    const layer = makeJarvisControllerLive(interpreterLayer).pipe(
      Layer.provideMerge(makeImmediateFollowUpQueueLayer()),
      Layer.provideMerge(
        makeTaskDeskLayer({
          focusedTask: null,
          recentTasks: [deskTask],
          pendingInteraction: null,
          updatedAt: DateTime.makeUnsafe("2026-08-12T00:02:00.000Z"),
        }),
      ),
      Layer.provideMerge(testLexiconLayer),
      Layer.provideMerge(ServerSettingsModule.ServerSettingsService.layerTest()),
      Layer.provideMerge(
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([codexProvider]) }),
      ),
      Layer.provideMerge(
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShellById: (projectId) =>
            Effect.succeed(projectId === project.id ? Option.some(project) : Option.none()),
          getThreadDetailById: (threadId) =>
            Effect.succeed(
              Option.fromUndefinedOr(threadId === focusThread.id ? focusThread : undefined),
            ),
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 1,
              projects: [project],
              threads: [focusShellThread],
              updatedAt: "2026-08-12T00:02:00.000Z",
            }),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(OrchestrationEngineService)({
          dispatch: () => Effect.die("Task focus must not dispatch a command"),
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
        executionNodeId,
        utterance: "Focus the authentication task",
        projectId: project.id,
      });
      expect(result).toEqual({
        status: "acknowledged",
        action: "focused",
        projectId: project.id,
        taskRef: { executionNodeId, threadId: focusThread.id },
        message: `Focused ${focusThread.id}.`,
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
      yield* (yield* JarvisFollowUpDispatcher).drain;
      expect(queued).toMatchObject({ status: "acknowledged", action: "queued" });
      expect(commands[0]).toMatchObject({
        type: "thread.turn.start",
        threadId: focusedThread.id,
        message: { text: "actually use SQLite instead" },
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
      yield* (yield* JarvisFollowUpDispatcher).drain;
      expect(immediate).toMatchObject({
        status: "acknowledged",
        action: "queued",
        message: "I'll do that next: after that add release notes",
      });
      // The shared worker starts the oldest pending instruction first.
      expect(commands[1]).toMatchObject({
        type: "thread.turn.start",
        threadId: focusedThread.id,
        message: { text: "in that Jarvis request, please check if there are any PR's open" },
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

  it.effect("steers running work when the snapshot predates its turn", () => {
    // Snapshot lag race: the bulk detail read misses the thread, so the
    // Director sees only the stale shell (ready) and plans a continuation;
    // the dispatch-time single read finds it running. The live thread wins:
    // direction joins the running turn instead of opening a second one.
    const commands: Array<OrchestrationCommand> = [];
    const executionNodeId = EnvironmentId.make("node-stale-snapshot");
    const staleThreadId = ThreadId.make("thread-stale-snapshot");
    const liveThread: OrchestrationThread = {
      ...sourceThread,
      id: staleThreadId,
      title: "Stale snapshot task",
      latestTurn: {
        turnId: TurnId.make("turn-stale-running"),
        state: "running",
        requestedAt: "2026-08-12T00:01:00.000Z",
        startedAt: "2026-08-12T00:01:01.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    };
    const shellThread = {
      id: staleThreadId,
      projectId: project.id,
      title: "Stale snapshot task",
      modelSelection: sourceThread.modelSelection,
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: "default" as const,
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:01:00.000Z",
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      session: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    };
    let detailReads = 0;
    const layer = TestJarvisControllerLive.pipe(
      Layer.provideMerge(testFollowUpQueueLayer),
      Layer.provideMerge(
        makeTaskDeskLayer({
          focusedTask: null,
          recentTasks: [
            {
              threadId: staleThreadId,
              taskRef: { executionNodeId, threadId: staleThreadId },
              projectRef: { nodeId: executionNodeId, projectId: project.id },
            },
          ],
          pendingInteraction: null,
          updatedAt: null,
        }),
      ),
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
              detailReads += 1;
              // Bulk snapshot read misses; the dispatch-time read hits.
              return detailReads === 1 ? Option.none() : Option.some(liveThread);
            }),
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 1,
              projects: [project],
              threads: [shellThread],
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
      const source = "Add a follow-up note to Stale snapshot task";
      const taskAt = source.indexOf("Stale snapshot task");
      const result = yield* manager.execute({
        sessionId,
        utterance: source,
        projectId: project.id,
        sourceUtterance: source,
        semanticProposal: {
          action: "continue",
          refs: [
            {
              span: {
                start: taskAt,
                end: taskAt + "Stale snapshot task".length,
                text: "Stale snapshot task",
              },
              role: "task",
              value: "Stale snapshot task",
            },
          ],
          model: null,
          effort: null,
          answer: null,
        },
      });
      expect(result).toMatchObject({ status: "acknowledged", action: "steered" });
      expect(commands.map((command) => command.type)).toEqual(["thread.turn.start"]);
      expect(commands[0]).toMatchObject({
        type: "thread.turn.start",
        threadId: staleThreadId,
        message: { text: source },
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
      yield* (yield* JarvisFollowUpDispatcher).drain;
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
      yield* (yield* JarvisFollowUpDispatcher).drain;
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
          message: expect.objectContaining({
            text: "Tell the authentication task to use SQLite instead",
          }),
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
      expect(result.objective).toBe("Jarvis, use Codex Sol high to implement device presence.");
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
        title: "Jarvis, use Codex Sol high to implement device presence",
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
          text: "Jarvis, use Codex Sol high to implement device presence.",
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
        // The deterministic route owns project identity; the object noun is
        // not a destination wrapper, so dispatch keeps the original.
        objective: "I need you to check out Zivil.",
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
        message: { text: "I need you to check out Zivil." },
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
            objective: "I need you to check out Zivil.",
            requestMetadata: {
              sourceUtterance: "I need you to check out Zivil.",
            },
          },
        },
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses the lead fragment of a compound voice request", () => {
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
        utterance: "Fix auth then add release notes",
        projectId: project.id,
        requestMetadata: { requestId: "voice-compound", inputMode: "voice" },
      });

      // One action per turn: the lead fragment must never dispatch.
      expect(result).toMatchObject({ status: "needs-input", reason: "unsupported-command" });
      expect(commands).toEqual([]);
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
            objective: "Jarvis, use Fable to review this Codex output.",
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
      // The deterministic prepass defers worker questions to classification,
      // the proposal answers the live request, and dispatch rejects it
      // because the request cleared between reads: no stale answer dispatches.
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
    const pendingReplyInterpreter = continueReplyInterpreter("Yes, continue to the next step.");
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

  it.effect("asks instead of answering when two distinct requests wait", () => {
    const commands: Array<OrchestrationCommand> = [];
    const ambiguousThread: OrchestrationThread = {
      ...sourceThread,
      activities: [
        {
          id: EventId.make("event-approval-request"),
          tone: "approval",
          kind: "approval.requested",
          summary: "Approval requested",
          payload: { requestId: "request-approval" },
          turnId: null,
          createdAt: "2026-08-12T00:01:00.000Z",
        },
        {
          id: EventId.make("event-input-request"),
          tone: "info",
          kind: "user-input.requested",
          summary: "Continue?",
          payload: { requestId: "request-input", questions: [{ id: "continue" }] },
          turnId: null,
          createdAt: "2026-08-12T00:01:01.000Z",
        },
      ],
    };
    const pendingReplyInterpreter = Layer.succeed(JarvisControllerInterpreter, {
      interpret: () =>
        Effect.die("Ambiguous prepass verdicts must not invoke semantic generation."),
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
          getThreadDetailById: () => Effect.succeed(Option.some(ambiguousThread)),
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
        utterance: "Allow it.",
        projectId: project.id,
        contextThreadId: ambiguousThread.id,
      });

      expect(result).toMatchObject({
        status: "needs-input",
        reason: "source-output-unavailable",
      });
      expect(commands).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects a pinned answer when its request closed before a new one opened", () => {
    const commands: Array<OrchestrationCommand> = [];
    const replacedThread: OrchestrationThread = {
      ...sourceThread,
      activities: [
        {
          id: EventId.make("event-approval-a"),
          tone: "approval",
          kind: "approval.requested",
          summary: "First approval",
          payload: { requestId: "request-a" },
          turnId: null,
          createdAt: "2026-08-12T00:01:00.000Z",
        },
        {
          id: EventId.make("event-approval-a-resolved"),
          tone: "info",
          kind: "approval.resolved",
          summary: "First approval resolved",
          payload: { requestId: "request-a" },
          turnId: null,
          createdAt: "2026-08-12T00:01:01.000Z",
        },
        {
          id: EventId.make("event-approval-b"),
          tone: "approval",
          kind: "approval.requested",
          summary: "Second approval",
          payload: { requestId: "request-b" },
          turnId: null,
          createdAt: "2026-08-12T00:01:02.000Z",
        },
      ],
    };
    const pendingReplyInterpreter = Layer.succeed(JarvisControllerInterpreter, {
      interpret: () => Effect.die("Pinned prepass verdicts must not invoke semantic generation."),
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
          getThreadDetailById: () => Effect.succeed(Option.some(replacedThread)),
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
      const stale = yield* manager.execute({
        sessionId,
        utterance: "Allow it.",
        projectId: project.id,
        contextThreadId: replacedThread.id,
        expectedReply: { kind: "approval", requestId: "request-a" },
      });

      expect(stale).toMatchObject({
        status: "needs-input",
        reason: "source-output-unavailable",
      });
      expect(commands).toHaveLength(0);

      const current = yield* manager.execute({
        sessionId,
        utterance: "Allow it.",
        projectId: project.id,
        contextThreadId: replacedThread.id,
        expectedReply: { kind: "approval", requestId: "request-b" },
      });

      expect(current.status).toBe("started");
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        type: "thread.approval.respond",
        threadId: replacedThread.id,
        requestId: "request-b",
        decision: "accept",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects a bare answer when a null snapshot meets a new request", () => {
    const commands: Array<OrchestrationCommand> = [];
    const freshPendingThread: OrchestrationThread = {
      ...sourceThread,
      activities: [
        {
          id: EventId.make("event-approval-new"),
          tone: "approval",
          kind: "approval.requested",
          summary: "Approval requested",
          payload: { requestId: "request-new" },
          turnId: null,
          createdAt: "2026-08-12T00:01:00.000Z",
        },
      ],
    };
    const pendingReplyInterpreter = Layer.succeed(JarvisControllerInterpreter, {
      interpret: () =>
        Effect.die("Null-pinned prepass verdicts must not invoke semantic generation."),
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
          getThreadDetailById: () => Effect.succeed(Option.some(freshPendingThread)),
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
        utterance: "Allow it.",
        projectId: project.id,
        contextThreadId: freshPendingThread.id,
        expectedReply: null,
      });

      expect(result).toMatchObject({
        status: "needs-input",
        reason: "source-output-unavailable",
      });
      expect(commands).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps explicit controls working while an approval waits", () => {
    const commands: Array<OrchestrationCommand> = [];
    const executionNodeId = EnvironmentId.make("node-controls");
    const approvalThread: OrchestrationThread = {
      ...sourceThread,
      id: ThreadId.make("thread-approval-controls"),
      title: "Authentication",
      latestTurn: {
        turnId: TurnId.make("turn-running-controls"),
        state: "running",
        requestedAt: "2026-08-12T00:01:00.000Z",
        startedAt: "2026-08-12T00:01:01.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
      activities: [
        {
          id: EventId.make("event-approval-controls"),
          tone: "approval",
          kind: "approval.requested",
          summary: "Approval requested",
          payload: { requestId: "request-controls" },
          turnId: TurnId.make("turn-running-controls"),
          createdAt: "2026-08-12T00:01:02.000Z",
        },
      ],
    };
    const deskTask = {
      threadId: approvalThread.id,
      taskRef: { executionNodeId, threadId: approvalThread.id },
      projectRef: { nodeId: executionNodeId, projectId: project.id },
    };
    const layer = makeJarvisControllerLive(testInterpreterLayer).pipe(
      Layer.provideMerge(testFollowUpQueueLayer),
      Layer.provideMerge(
        makeTaskDeskLayer({
          focusedTask: deskTask,
          recentTasks: [deskTask],
          pendingInteraction: null,
          updatedAt: null,
        }),
      ),
      Layer.provideMerge(testLexiconLayer),
      Layer.provideMerge(ServerSettingsModule.ServerSettingsService.layerTest()),
      Layer.provideMerge(
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([codexProvider]) }),
      ),
      Layer.provideMerge(
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShellById: () => Effect.succeed(Option.some(project)),
          getThreadDetailById: () => Effect.succeed(Option.some(approvalThread)),
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
      const context = {
        sessionId,
        projectId: project.id,
        executionNodeId,
        contextThreadId: approvalThread.id,
        referenceThreadId: approvalThread.id,
      };

      const stopped = yield* manager.execute({ ...context, utterance: "Stop that task" });
      expect(stopped).toMatchObject({ status: "acknowledged", action: "interrupted" });
      expect(commands.at(-1)).toMatchObject({
        type: "thread.turn.interrupt",
        threadId: approvalThread.id,
      });

      const status = yield* manager.execute({
        ...context,
        utterance: "Give me the status of the authentication task",
      });
      expect(status).toMatchObject({ status: "acknowledged", action: "status" });

      const queued = yield* manager.execute({
        ...context,
        utterance: "after that add release notes",
      });
      expect(queued).toMatchObject({ status: "acknowledged", action: "queued" });

      // A stale answer pin must not block the same controls.
      const staleStop = yield* manager.execute({
        ...context,
        utterance: "Stop that task",
        expectedReply: { kind: "approval", requestId: "request-stale" },
      });
      expect(staleStop).toMatchObject({ status: "acknowledged", action: "interrupted" });
      const staleStatus = yield* manager.execute({
        ...context,
        utterance: "Give me the status of the authentication task",
        expectedReply: { kind: "approval", requestId: "request-stale" },
      });
      expect(staleStatus).toMatchObject({ status: "acknowledged", action: "status" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not swallow an explicit stop as a worker-input answer", () => {
    const commands: Array<OrchestrationCommand> = [];
    const executionNodeId = EnvironmentId.make("node-input-controls");
    const inputThread: OrchestrationThread = {
      ...sourceThread,
      id: ThreadId.make("thread-input-controls"),
      title: "Authentication",
      latestTurn: {
        turnId: TurnId.make("turn-running-input"),
        state: "running",
        requestedAt: "2026-08-12T00:01:00.000Z",
        startedAt: "2026-08-12T00:01:01.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
      activities: [
        {
          id: EventId.make("event-input-controls"),
          tone: "info",
          kind: "user-input.requested",
          summary: "Continue?",
          payload: { requestId: "request-input", questions: [{ id: "continue" }] },
          turnId: null,
          createdAt: "2026-08-12T00:01:02.000Z",
        },
      ],
    };
    const deskTask = {
      threadId: inputThread.id,
      taskRef: { executionNodeId, threadId: inputThread.id },
      projectRef: { nodeId: executionNodeId, projectId: project.id },
    };
    const layer = makeJarvisControllerLive(testInterpreterLayer).pipe(
      Layer.provideMerge(testFollowUpQueueLayer),
      Layer.provideMerge(
        makeTaskDeskLayer({
          focusedTask: deskTask,
          recentTasks: [deskTask],
          pendingInteraction: null,
          updatedAt: null,
        }),
      ),
      Layer.provideMerge(testLexiconLayer),
      Layer.provideMerge(ServerSettingsModule.ServerSettingsService.layerTest()),
      Layer.provideMerge(
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([codexProvider]) }),
      ),
      Layer.provideMerge(
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShellById: () => Effect.succeed(Option.some(project)),
          getThreadDetailById: () => Effect.succeed(Option.some(inputThread)),
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
      const stopped = yield* manager.execute({
        sessionId,
        utterance: "Stop that task",
        projectId: project.id,
        executionNodeId,
        contextThreadId: inputThread.id,
        referenceThreadId: inputThread.id,
      });

      expect(stopped).toMatchObject({ status: "acknowledged", action: "interrupted" });
      expect(commands.some((command) => command.type === "thread.user-input.respond")).toBe(false);
      expect(commands.at(-1)).toMatchObject({
        type: "thread.turn.interrupt",
        threadId: inputThread.id,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("dispatches pinned allow and deny without semantic generation", () => {
    const commands: Array<OrchestrationCommand> = [];
    const approvalThread: OrchestrationThread = {
      ...sourceThread,
      activities: [
        {
          id: EventId.make("event-approval-direct"),
          tone: "approval",
          kind: "approval.requested",
          summary: "Approval requested",
          payload: { requestId: "request-direct" },
          turnId: null,
          createdAt: "2026-08-12T00:01:00.000Z",
        },
      ],
    };
    const layer = makeJarvisControllerLive(
      Layer.succeed(JarvisControllerInterpreter, {
        interpret: () => Effect.die("Bare approval verdicts must not invoke semantic generation."),
      }),
    ).pipe(
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
          getThreadDetailById: () => Effect.succeed(Option.some(approvalThread)),
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
      const context = {
        sessionId,
        projectId: project.id,
        contextThreadId: approvalThread.id,
        expectedReply: { kind: "approval", requestId: "request-direct" },
      } as const;

      const allowed = yield* manager.execute({ ...context, utterance: "Allow it." });
      expect(allowed.status).toBe("started");
      const denied = yield* manager.execute({ ...context, utterance: "Deny it." });
      expect(denied.status).toBe("started");
      expect(commands.map((command) => command.type)).toEqual([
        "thread.approval.respond",
        "thread.approval.respond",
      ]);
      expect(commands[0]).toMatchObject({ requestId: "request-direct", decision: "accept" });
      expect(commands[1]).toMatchObject({ requestId: "request-direct", decision: "decline" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("never authorizes an approval from a broad negation phrase", () => {
    const commands: Array<OrchestrationCommand> = [];
    const executionNodeId = EnvironmentId.make("node-negative");
    const approvalThread: OrchestrationThread = {
      ...sourceThread,
      id: ThreadId.make("thread-negative"),
      title: "Authentication",
      latestTurn: {
        turnId: TurnId.make("turn-running-negative"),
        state: "running",
        requestedAt: "2026-08-12T00:01:00.000Z",
        startedAt: "2026-08-12T00:01:01.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
      activities: [
        {
          id: EventId.make("event-approval-negative"),
          tone: "approval",
          kind: "approval.requested",
          summary: "Approval requested",
          payload: { requestId: "request-negative" },
          turnId: TurnId.make("turn-running-negative"),
          createdAt: "2026-08-12T00:01:02.000Z",
        },
      ],
    };
    const deskTask = {
      threadId: approvalThread.id,
      taskRef: { executionNodeId, threadId: approvalThread.id },
      projectRef: { nodeId: executionNodeId, projectId: project.id },
    };
    // Utterance-aware interpreter: a correct model refuses the bare
    // negation as unsupported, so nothing authorizes the waiting approval.
    const layer = makeJarvisControllerLive(testInterpreterLayer).pipe(
      Layer.provideMerge(testFollowUpQueueLayer),
      Layer.provideMerge(
        makeTaskDeskLayer({
          focusedTask: deskTask,
          recentTasks: [deskTask],
          pendingInteraction: null,
          updatedAt: null,
        }),
      ),
      Layer.provideMerge(testLexiconLayer),
      Layer.provideMerge(ServerSettingsModule.ServerSettingsService.layerTest()),
      Layer.provideMerge(
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([codexProvider]) }),
      ),
      Layer.provideMerge(
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShellById: () => Effect.succeed(Option.some(project)),
          getThreadDetailById: () => Effect.succeed(Option.some(approvalThread)),
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
      // The prepass must defer: "don't stop task" is not a bare verdict.
      // Classification says stop, but the transcript explicitly negates it,
      // so the validator rejects the contradiction instead of dispatching:
      // no approval answer, no interrupt, nothing at all.
      const stopped = yield* manager.execute({
        sessionId,
        utterance: "don't stop task",
        projectId: project.id,
        executionNodeId,
        contextThreadId: approvalThread.id,
        referenceThreadId: approvalThread.id,
      });

      expect(stopped).toMatchObject({ status: "needs-input", reason: "unsupported-command" });
      expect(commands.some((command) => command.type === "thread.approval.respond")).toBe(false);
      expect(commands.some((command) => command.type === "thread.turn.interrupt")).toBe(false);
      expect(commands).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("binds frame answers to the exact saved frame id", () => {
    const commands: Array<OrchestrationCommand> = [];
    const rivvlProject = {
      ...project,
      id: ProjectId.make("project-rivvl-frame"),
      title: "Rivvl",
      workspaceRoot: "/workspace/rivvl-frame",
    };
    let deskState: JarvisTaskDeskState = {
      focusedTask: null,
      recentTasks: [],
      pendingInteraction: null,
      updatedAt: null,
    };
    const deskLayer = makeTaskDeskLayer(deskState, (next) => {
      deskState = next;
    });
    const interpreterLayer = Layer.succeed(JarvisControllerInterpreter, {
      interpret: (context) => {
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
            Effect.succeed({
              snapshotSequence: 1,
              projects: [project, rivvlProject],
              threads: [],
              updatedAt: "2026-08-12T00:02:00.000Z",
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
        executionNodeId: EnvironmentId.make("node-frame"),
        modelSelection: {
          instanceId: codexProvider.instanceId,
          model: "gpt-5.6-sol",
          options: [{ id: "reasoningEffort", value: "high" as const }],
        },
        requestMetadata: {
          requestId: "controller-frame",
          inputMode: "voice" as const,
          sourceUtterance: "I need you to check out Zivil.",
        },
      };
      const clarification = yield* controller.execute(input);
      expect(clarification).toMatchObject({
        status: "needs-input",
        prompt: "Did you mean Rivvl?",
      });
      expect(commands).toHaveLength(0);
      if (
        clarification.status !== "needs-input" ||
        clarification.clarificationFrameId === undefined
      ) {
        throw new Error("Expected a frame-bound clarification.");
      }
      const frameId = clarification.clarificationFrameId;

      const wrongFrame = yield* controller.execute({
        ...input,
        utterance: "yes",
        clarificationFrameId: "frame-wrong",
      });
      expect(wrongFrame).toMatchObject({
        status: "needs-input",
        reason: "source-output-unavailable",
      });
      expect(commands).toHaveLength(0);
      expect(deskState.pendingInteraction?.frame.frameId).toBe(frameId);

      const result = yield* controller.execute({
        ...input,
        utterance: "yes",
        clarificationFrameId: frameId,
      });
      expect(result).toMatchObject({ status: "started", projectId: rivvlProject.id });
      expect(deskState.pendingInteraction).toBeNull();
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

  it.effect("cancels a pre-accept request without dispatching any provider work", () => {
    const executionNodeId = EnvironmentId.make("node-controller-cancel");
    const commands: Array<OrchestrationCommand> = [];
    const gatedInterpreter = Layer.succeed(JarvisControllerInterpreter, {
      interpret: () => Effect.never,
    });
    const layer = makeJarvisControllerLive(gatedInterpreter).pipe(
      Layer.provideMerge(testFollowUpQueueLayer),
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
        makeTaskDeskLayer({
          focusedTask: null,
          recentTasks: [],
          pendingInteraction: null,
          updatedAt: null,
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
      const requestMetadata = {
        requestId: "controller-cancel-1",
        origin: { originNodeId: executionNodeId, originInteractionId: "interaction-cancel-1" },
      };
      const fiber = yield* Effect.forkChild(
        manager.execute({
          sessionId,
          executionNodeId,
          utterance: "Jarvis, implement device presence.",
          projectId: project.id,
          requestMetadata,
        }),
      );
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      const decision = yield* manager.cancelRequest({
        requestId: requestMetadata.requestId,
        origin: requestMetadata.origin,
        executionNodeId,
      });
      expect(decision).toEqual({ status: "cancelled", requestId: "controller-cancel-1" });
      expect(yield* Fiber.join(fiber)).toEqual({
        status: "cancelled",
        requestId: "controller-cancel-1",
      });
      expect(commands).toEqual([]);
      // The cancel is sticky: a repeated cancel answers identically, and an
      // unknown identity stays unknown instead of inventing work.
      expect(
        yield* manager.cancelRequest({
          requestId: requestMetadata.requestId,
          origin: requestMetadata.origin,
          executionNodeId,
        }),
      ).toEqual({ status: "cancelled", requestId: "controller-cancel-1" });
      expect(
        yield* manager.cancelRequest({
          requestId: "controller-never-seen",
          origin: requestMetadata.origin,
          executionNodeId,
        }),
      ).toEqual({ status: "unknown", requestId: "controller-never-seen" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("answers unknown for legacy requests without request metadata", () => {
    const executionNodeId = EnvironmentId.make("node-controller-legacy");
    const commands: Array<OrchestrationCommand> = [];
    const layer = makeJarvisControllerLive(testInterpreterLayer).pipe(
      Layer.provideMerge(testFollowUpQueueLayer),
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
        makeTaskDeskLayer({
          focusedTask: null,
          recentTasks: [],
          pendingInteraction: null,
          updatedAt: null,
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
        executionNodeId,
        utterance: "Jarvis, implement device presence.",
        projectId: project.id,
      });
      expect(result).toMatchObject({ status: "started" });
      expect(
        yield* manager.cancelRequest({ requestId: "legacy-without-metadata", executionNodeId }),
      ).toEqual({ status: "unknown", requestId: "legacy-without-metadata" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("never reports acceptance for a clarification that dispatched nothing", () => {
    const executionNodeId = EnvironmentId.make("node-controller-clarify-cancel");
    const commands: Array<OrchestrationCommand> = [];
    const requestMetadata = {
      requestId: "controller-clarify-cancel-1",
      origin: { originNodeId: executionNodeId, originInteractionId: "interaction-clarify-1" },
    };
    const layer = makeJarvisControllerLive(continueReplyInterpreter("do the thing")).pipe(
      Layer.provideMerge(testFollowUpQueueLayer),
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
        makeTaskDeskLayer({
          focusedTask: null,
          recentTasks: [],
          pendingInteraction: null,
          updatedAt: null,
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
      // A continue with no live conversation answers needs-input and
      // dispatches no provider work.
      const result = yield* manager.execute({
        sessionId,
        executionNodeId,
        utterance: "Do the thing.",
        projectId: project.id,
        requestMetadata,
      });
      expect(result).toMatchObject({ status: "needs-input" });
      expect(commands).toEqual([]);
      expect(
        yield* manager.cancelRequest({
          requestId: requestMetadata.requestId,
          origin: requestMetadata.origin,
          executionNodeId,
        }),
      ).toEqual({ status: "unknown", requestId: "controller-clarify-cancel-1" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("answers unknown when the commit dispatch fails instead of claiming acceptance", () => {
    const executionNodeId = EnvironmentId.make("node-controller-failed-commit");
    const commands: Array<OrchestrationCommand> = [];
    const requestMetadata = {
      requestId: "controller-failed-commit-1",
      origin: { originNodeId: executionNodeId, originInteractionId: "interaction-failed-1" },
    };
    const layer = makeJarvisControllerLive(testInterpreterLayer).pipe(
      Layer.provideMerge(testFollowUpQueueLayer),
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
        makeTaskDeskLayer({
          focusedTask: null,
          recentTasks: [],
          pendingInteraction: null,
          updatedAt: null,
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
            Effect.gen(function* () {
              commands.push(command);
              return yield* new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: "injected dispatch failure",
              });
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
      const failure = yield* manager
        .execute({
          sessionId,
          executionNodeId,
          utterance: "Jarvis, implement device presence.",
          projectId: project.id,
          requestMetadata,
        })
        .pipe(Effect.flip);
      expect(failure).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
      expect(
        yield* manager.cancelRequest({
          requestId: requestMetadata.requestId,
          origin: requestMetadata.origin,
          executionNodeId,
        }),
      ).toEqual({ status: "unknown", requestId: "controller-failed-commit-1" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("records a receipt for an accepted stop instead of answering unknown", () => {
    const commands: Array<OrchestrationCommand> = [];
    const executionNodeId = EnvironmentId.make("node-stop-receipt");
    const requestMetadata = {
      requestId: "controller-stop-receipt-1",
      origin: { originNodeId: executionNodeId, originInteractionId: "interaction-stop-1" },
    };
    const stopThread: OrchestrationThread = {
      ...sourceThread,
      id: ThreadId.make("thread-stop-receipt"),
      title: "Authentication",
      latestTurn: {
        turnId: TurnId.make("turn-running-stop"),
        state: "running",
        requestedAt: "2026-08-12T00:01:00.000Z",
        startedAt: "2026-08-12T00:01:01.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    };
    const deskTask = {
      threadId: stopThread.id,
      taskRef: { executionNodeId, threadId: stopThread.id },
      projectRef: { nodeId: executionNodeId, projectId: project.id },
    };
    const layer = makeJarvisControllerLive(stopIntentInterpreter).pipe(
      Layer.provideMerge(testFollowUpQueueLayer),
      Layer.provideMerge(
        makeTaskDeskLayer({
          focusedTask: deskTask,
          recentTasks: [deskTask],
          pendingInteraction: null,
          updatedAt: null,
        }),
      ),
      Layer.provideMerge(testLexiconLayer),
      Layer.provideMerge(ServerSettingsModule.ServerSettingsService.layerTest()),
      Layer.provideMerge(
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([codexProvider]) }),
      ),
      Layer.provideMerge(
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShellById: () => Effect.succeed(Option.some(project)),
          getThreadDetailById: () => Effect.succeed(Option.some(stopThread)),
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
      const stopped = yield* manager.execute({
        sessionId,
        utterance: "Stop that task.",
        projectId: project.id,
        executionNodeId,
        contextThreadId: stopThread.id,
        referenceThreadId: stopThread.id,
        requestMetadata,
      });
      expect(stopped).toMatchObject({ status: "acknowledged" });
      expect(
        yield* manager.cancelRequest({
          requestId: requestMetadata.requestId,
          origin: requestMetadata.origin,
          executionNodeId,
        }),
      ).toMatchObject({
        status: "already-accepted",
        requestId: "controller-stop-receipt-1",
        threadId: stopThread.id,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("records a receipt for an accepted task focus instead of answering unknown", () => {
    const executionNodeId = EnvironmentId.make("node-focus-receipt");
    const requestMetadata = {
      requestId: "controller-focus-receipt-1",
      origin: { originNodeId: executionNodeId, originInteractionId: "interaction-focus-1" },
    };
    const focusThread: OrchestrationThread = {
      ...sourceThread,
      id: ThreadId.make("thread-focus-receipt"),
      title: "Authentication",
    };
    const focusShellThread = {
      id: focusThread.id,
      projectId: project.id,
      title: "Authentication",
      modelSelection: { instanceId: codexProvider.instanceId, model: "gpt-5.6-sol" },
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: "default" as const,
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:01:00.000Z",
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      session: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    };
    const deskTask = {
      threadId: focusThread.id,
      taskRef: { executionNodeId, threadId: focusThread.id },
      projectRef: { nodeId: executionNodeId, projectId: focusThread.projectId },
    };
    const interpreterLayer = Layer.succeed(JarvisControllerInterpreter, {
      interpret: (context) =>
        Effect.sync(() => {
          const prepared = prepareJarvisSemanticTurn(context);
          if (prepared.status === "needs-input") return prepared;
          const source = prepared.sourceUtterance;
          // Schema-exact span: find the heard text case-insensitively but
          // cite the source slice byte-for-byte so value echoes its span.
          const at = source.toLocaleLowerCase("en-US").indexOf("authentication");
          return interpretJarvisCommand(context, prepared, {
            action: "focus-task",
            refs:
              at < 0
                ? []
                : [
                    {
                      span: {
                        start: at,
                        end: at + "Authentication".length,
                        text: source.slice(at, at + "Authentication".length),
                      },
                      role: "task",
                      value: "Authentication",
                    },
                  ],
            model: null,
            effort: null,
            answer: null,
          });
        }),
    });
    const layer = makeJarvisControllerLive(interpreterLayer).pipe(
      Layer.provideMerge(testFollowUpQueueLayer),
      Layer.provideMerge(
        makeTaskDeskLayer({
          focusedTask: null,
          recentTasks: [deskTask],
          pendingInteraction: null,
          updatedAt: null,
        }),
      ),
      Layer.provideMerge(testLexiconLayer),
      Layer.provideMerge(ServerSettingsModule.ServerSettingsService.layerTest()),
      Layer.provideMerge(
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([codexProvider]) }),
      ),
      Layer.provideMerge(
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShellById: (projectId) =>
            Effect.succeed(projectId === project.id ? Option.some(project) : Option.none()),
          getThreadDetailById: (threadId) =>
            Effect.succeed(
              Option.fromUndefinedOr(threadId === focusThread.id ? focusThread : undefined),
            ),
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 1,
              projects: [project],
              threads: [focusShellThread],
              updatedAt: "2026-08-12T00:02:00.000Z",
            }),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(OrchestrationEngineService)({
          dispatch: () => Effect.die("Task focus must not dispatch a command"),
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
        executionNodeId,
        utterance: "Focus the authentication task",
        projectId: project.id,
        requestMetadata,
      });
      expect(result).toMatchObject({ status: "acknowledged", action: "focused" });
      expect(
        yield* manager.cancelRequest({
          requestId: requestMetadata.requestId,
          origin: requestMetadata.origin,
          executionNodeId,
        }),
      ).toMatchObject({
        status: "already-accepted",
        requestId: "controller-focus-receipt-1",
        threadId: focusThread.id,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps clarification frame identity stable across an identical retry", () => {
    const executionNodeId = EnvironmentId.make("node-frame-stable");
    const requestMetadata = {
      requestId: "controller-frame-stable-1",
      origin: { originNodeId: executionNodeId, originInteractionId: "interaction-frame-1" },
    };
    const frameInterpreter = Layer.succeed(JarvisControllerInterpreter, {
      interpret: () =>
        Effect.succeed({
          status: "needs-input" as const,
          reason: "control-target-required" as const,
          prompt: "Which project did you mean?",
          choices: ["Jarvis"],
          projectClarification: {
            candidates: [{ projectId: project.id, label: "Jarvis" }],
          },
        }),
    });
    const layer = makeJarvisControllerLive(frameInterpreter).pipe(
      Layer.provideMerge(testFollowUpQueueLayer),
      Layer.provideMerge(
        makeTaskDeskLayer({
          focusedTask: null,
          recentTasks: [],
          pendingInteraction: null,
          updatedAt: null,
        }),
      ),
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
          dispatch: () => Effect.die("Clarification must not dispatch a command"),
          readEvents: () => Stream.empty,
          streamDomainEvents: Stream.empty,
          latestSequence: Effect.succeed(0),
        }),
      ),
      Layer.provideMerge(testCryptoLayer),
    );
    const input = {
      sessionId,
      executionNodeId,
      utterance: "Run that in the other project.",
      projectId: project.id,
      requestMetadata,
    };

    return Effect.gen(function* () {
      const manager = yield* JarvisController;
      const first = yield* manager.execute(input);
      const second = yield* manager.execute(input);
      expect(first).toMatchObject({ status: "needs-input" });
      expect(second).toMatchObject({ status: "needs-input" });
      expect(first).toMatchObject({
        clarificationFrameId: (second as { clarificationFrameId?: string }).clarificationFrameId,
      });
      expect((first as { clarificationFrameId?: string }).clarificationFrameId).toMatch(
        /^jarvis\.clarification-frame\./u,
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("gates a deterministic approval dispatch behind the commit boundary", () => {
    const commands: Array<OrchestrationCommand> = [];
    const executionNodeId = EnvironmentId.make("node-deterministic-commit");
    const requestMetadata = {
      requestId: "controller-deterministic-commit-1",
      origin: { originNodeId: executionNodeId, originInteractionId: "interaction-det-1" },
    };
    const approvalThread: OrchestrationThread = {
      ...sourceThread,
      id: ThreadId.make("thread-deterministic-commit"),
      title: "Authentication",
      activities: [
        {
          id: EventId.make("event-approval-deterministic"),
          tone: "approval",
          kind: "approval.requested",
          summary: "Approval requested",
          payload: { requestId: "request-deterministic" },
          turnId: null,
          createdAt: "2026-08-12T00:01:00.000Z",
        },
      ],
    };
    const layer = makeJarvisControllerLive(
      Layer.succeed(JarvisControllerInterpreter, {
        interpret: () => Effect.die("Bare approval verdicts must not invoke semantic generation."),
      }),
    ).pipe(
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
          getThreadDetailById: () => Effect.succeed(Option.some(approvalThread)),
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
      const allowed = yield* manager.execute({
        sessionId,
        utterance: "Allow it.",
        projectId: project.id,
        executionNodeId,
        contextThreadId: approvalThread.id,
        expectedReply: { kind: "approval", requestId: "request-deterministic" },
        requestMetadata,
      });
      expect(allowed.status).toBe("started");
      expect(commands.map((command) => command.type)).toContain("thread.approval.respond");
      expect(
        yield* manager.cancelRequest({
          requestId: requestMetadata.requestId,
          origin: requestMetadata.origin,
          executionNodeId,
        }),
      ).toMatchObject({
        status: "already-accepted",
        requestId: "controller-deterministic-commit-1",
        threadId: approvalThread.id,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("shares one started receipt across simultaneous same-key executes", () => {
    const executionNodeId = EnvironmentId.make("node-outer-dedup");
    const requestMetadata = {
      requestId: "controller-outer-dedup-1",
      origin: {
        originNodeId: EnvironmentId.make("node-outer-origin"),
        originInteractionId: "interaction-outer-1",
      },
    };
    const input = {
      sessionId,
      executionNodeId,
      utterance: "Implement device presence.",
      projectId: project.id,
      requestMetadata,
    };
    const commands: Array<OrchestrationCommand> = [];
    let interpretations = 0;

    return Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const interpreterLayer = Layer.succeed(JarvisControllerInterpreter, {
        interpret: () =>
          Effect.gen(function* () {
            interpretations += 1;
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(gate);
            return {
              status: "command" as const,
              command: {
                type: "start" as const,
                projectId: project.id,
                objective: "Implement device presence.",
                modelSelection: {
                  instanceId: codexProvider.instanceId,
                  model: "gpt-5.6-sol",
                  options: [{ id: "reasoningEffort", value: "high" as const }],
                },
                runtimeMode: DEFAULT_RUNTIME_MODE,
                interactionMode: "default" as const,
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
      const manager = yield* JarvisController.pipe(Effect.provide(layer));
      const ownerFiber = yield* Effect.forkChild(manager.execute(input));
      yield* Deferred.await(entered);
      const duplicateFiber = yield* Effect.forkChild(manager.execute(input));
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Deferred.succeed(gate, undefined);
      const owner = yield* Fiber.join(ownerFiber);
      const duplicate = yield* Fiber.join(duplicateFiber);
      // Outer in-flight dedup shares the complete result: exact receipt,
      // never a cancelled placeholder for the loser.
      expect(duplicate).toEqual(owner);
      expect(owner).toMatchObject({ status: "started", objective: "Implement device presence." });
      expect(interpretations).toBe(1);
      expect(commands.map((command) => command.type)).toEqual([
        "thread.create",
        "thread.activity.append",
        "thread.turn.start",
      ]);
    });
  });

  it.effect("rejects an altered payload while the same key executes", () => {
    const executionNodeId = EnvironmentId.make("node-outer-conflict");
    const requestMetadata = {
      requestId: "controller-outer-conflict-1",
      origin: {
        originNodeId: EnvironmentId.make("node-outer-origin"),
        originInteractionId: "interaction-outer-conflict-1",
      },
    };
    const input = {
      sessionId,
      executionNodeId,
      utterance: "Implement device presence.",
      projectId: project.id,
      requestMetadata,
    };
    const commands: Array<OrchestrationCommand> = [];
    let interpretations = 0;

    return Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const interpreterLayer = Layer.succeed(JarvisControllerInterpreter, {
        interpret: () =>
          Effect.gen(function* () {
            interpretations += 1;
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(gate);
            return {
              status: "command" as const,
              command: {
                type: "start" as const,
                projectId: project.id,
                objective: "Implement device presence.",
                modelSelection: {
                  instanceId: codexProvider.instanceId,
                  model: "gpt-5.6-sol",
                  options: [{ id: "reasoningEffort", value: "high" as const }],
                },
                runtimeMode: DEFAULT_RUNTIME_MODE,
                interactionMode: "default" as const,
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
      const manager = yield* JarvisController.pipe(Effect.provide(layer));
      const ownerFiber = yield* Effect.forkChild(manager.execute(input));
      yield* Deferred.await(entered);
      const conflict = yield* manager
        .execute({ ...input, utterance: "Implement a different task." })
        .pipe(Effect.result);
      expect(conflict._tag).toBe("Failure");
      if (conflict._tag === "Failure") {
        expect(conflict.failure._tag).toBe("JarvisRequestConflictError");
      }
      yield* Deferred.succeed(gate, undefined);
      const owner = yield* Fiber.join(ownerFiber);
      expect(owner).toMatchObject({ status: "started", objective: "Implement device presence." });
      expect(interpretations).toBe(1);
      expect(commands.filter((command) => command.type === "thread.turn.start")).toHaveLength(1);
    });
  });

  it.effect("keeps the owner commit when a duplicate waiter is interrupted", () => {
    const executionNodeId = EnvironmentId.make("node-outer-owner");
    const requestMetadata = {
      requestId: "controller-outer-owner-1",
      origin: {
        originNodeId: EnvironmentId.make("node-outer-origin"),
        originInteractionId: "interaction-outer-owner-1",
      },
    };
    const input = {
      sessionId,
      executionNodeId,
      utterance: "Implement device presence.",
      projectId: project.id,
      requestMetadata,
    };
    const commands: Array<OrchestrationCommand> = [];
    let interpretations = 0;

    return Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const interpreterLayer = Layer.succeed(JarvisControllerInterpreter, {
        interpret: () =>
          Effect.gen(function* () {
            interpretations += 1;
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(gate);
            return {
              status: "command" as const,
              command: {
                type: "start" as const,
                projectId: project.id,
                objective: "Implement device presence.",
                modelSelection: {
                  instanceId: codexProvider.instanceId,
                  model: "gpt-5.6-sol",
                  options: [{ id: "reasoningEffort", value: "high" as const }],
                },
                runtimeMode: DEFAULT_RUNTIME_MODE,
                interactionMode: "default" as const,
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
      const manager = yield* JarvisController.pipe(Effect.provide(layer));
      const ownerFiber = yield* Effect.forkChild(manager.execute(input));
      yield* Deferred.await(entered);
      const duplicateFiber = yield* Effect.forkChild(manager.execute(input));
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      // Duplicate holds no lease: interrupting the waiter must not remove
      // the owner entry or its commit.
      yield* Fiber.interrupt(duplicateFiber);
      const lateFiber = yield* Effect.forkChild(manager.execute(input));
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Deferred.succeed(gate, undefined);
      const owner = yield* Fiber.join(ownerFiber);
      const late = yield* Fiber.join(lateFiber);
      expect(late).toEqual(owner);
      expect(owner).toMatchObject({ status: "started", objective: "Implement device presence." });
      expect(interpretations).toBe(1);
      expect(commands.filter((command) => command.type === "thread.turn.start")).toHaveLength(1);
      expect(
        yield* manager.cancelRequest({
          requestId: requestMetadata.requestId,
          origin: requestMetadata.origin,
          executionNodeId,
        }),
      ).toMatchObject({
        status: "already-accepted",
        requestId: "controller-outer-owner-1",
      });
    });
  });
});
