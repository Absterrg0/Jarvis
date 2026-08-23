import {
  CommandId,
  CheckpointRef,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProviderInstanceId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Scope from "effect/Scope";
import { afterEach, describe, expect, it } from "vite-plus/test";

import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../orchestration/ThreadPlanProgress.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ServerConfig } from "../../config.ts";
import { JarvisCompletionReactorLive } from "./JarvisCompletionReactor.ts";
import { JarvisCompletionReactor } from "../Services/JarvisCompletionReactor.ts";

const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const createdAt = "2026-01-01T00:00:00.000Z";

type Runtime = ManagedRuntime.ManagedRuntime<
  OrchestrationEngineService | ProjectionSnapshotQuery | JarvisCompletionReactor,
  unknown
>;

type JarvisMarkerKind = "jarvis.task.created" | "jarvis.review.source";

function commandId(value: string): CommandId {
  return CommandId.make(`test:${value}`);
}

function eventId(value: string): EventId {
  return EventId.make(`test:${value}`);
}

function turnId(value: string): TurnId {
  return TurnId.make(value);
}

function makeOrchestrationLayer() {
  return OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
  );
}

function makeProjectionLayer() {
  return OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
  );
}

function makeRuntime(): Runtime {
  const config = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-jarvis-completion-reactor-test-",
  });
  const layer = JarvisCompletionReactorLive.pipe(
    Layer.provideMerge(makeOrchestrationLayer()),
    Layer.provideMerge(makeProjectionLayer()),
    Layer.provideMerge(config),
    Layer.provideMerge(NodeServices.layer),
  );
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- The reactor owns a scoped live stream; this harness must explicitly bracket its runtime and scope.
  return ManagedRuntime.make(layer);
}

async function dispatch(engine: OrchestrationEngineShape, command: OrchestrationCommand) {
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- Commands are dispatched through the harness runtime so each case can inspect the persisted projection.
  await Effect.runPromise(engine.dispatch(command));
}

async function createThread(
  engine: OrchestrationEngineShape,
  workspaceRoot = "/tmp/jarvis-test-workspace",
) {
  await dispatch(engine, {
    type: "project.create",
    commandId: commandId("project-create"),
    projectId,
    title: "Test Project",
    workspaceRoot,
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    createdAt,
  });
  await dispatch(engine, {
    type: "thread.create",
    commandId: commandId("thread-create"),
    threadId,
    projectId,
    title: "Test Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "approval-required",
    branch: null,
    worktreePath: null,
    createdAt,
  });
}

async function appendActivity(
  engine: OrchestrationEngineShape,
  input: {
    readonly id: string;
    readonly kind:
      | JarvisMarkerKind
      | "provider.turn.result-finalized"
      | "checkpoint.capture.failed";
    readonly payload: unknown;
    readonly turnId: TurnId | null;
    readonly tone?: "info" | "error";
  },
) {
  await dispatch(engine, {
    type: "thread.activity.append",
    commandId: commandId(`activity-${input.id}`),
    threadId,
    activity: {
      id: eventId(input.id),
      tone: input.tone ?? "info",
      kind: input.kind,
      summary: input.kind,
      payload: input.payload,
      turnId: input.turnId,
      createdAt,
    },
    createdAt,
  });
}

async function appendMarker(engine: OrchestrationEngineShape, kind: JarvisMarkerKind) {
  await appendActivity(engine, {
    id: kind.replaceAll(".", "-"),
    kind,
    payload:
      kind === "jarvis.task.created"
        ? { objective: "Test completion delivery." }
        : { sourceThreadId: "source-thread" },
    turnId: null,
  });
}

async function appendResult(
  engine: OrchestrationEngineShape,
  input: { readonly id: string; readonly turnId: TurnId; readonly assistantMessageId: MessageId },
) {
  await appendActivity(engine, {
    id: input.id,
    kind: "provider.turn.result-finalized",
    payload: {
      turnId: input.turnId,
      assistantMessageId: input.assistantMessageId,
      state: "completed",
    },
    turnId: input.turnId,
  });
}

async function appendDiff(
  engine: OrchestrationEngineShape,
  input: {
    readonly turnId: TurnId;
    readonly assistantMessageId: MessageId;
    readonly status?: "ready" | "missing" | "error";
  },
) {
  await dispatch(engine, {
    type: "thread.turn.diff.complete",
    commandId: commandId(`diff-${input.turnId}`),
    threadId,
    turnId: input.turnId,
    completedAt: createdAt,
    checkpointRef: CheckpointRef.make(`refs/test/${input.turnId}`),
    status: input.status ?? "ready",
    files: [],
    assistantMessageId: input.assistantMessageId,
    checkpointTurnCount: 1,
    createdAt,
  });
}

async function readThread(query: ProjectionSnapshotQueryShape) {
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- Read the projection after the drain completes.
  const snapshot = await Effect.runPromise(query.getSnapshot());
  return snapshot.threads.find((thread) => thread.id === threadId);
}

function completionCount(thread: Awaited<ReturnType<typeof readThread>>) {
  return (
    thread?.activities.filter((activity) => activity.kind === "jarvis.turn.completion-ready")
      .length ?? 0
  );
}

describe("JarvisCompletionReactor", () => {
  let runtime: Runtime | null = null;
  let scope: Scope.Closeable | null = null;

  afterEach(async () => {
    if (scope !== null) {
      // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- Scope teardown is the explicit lifecycle boundary for the live reactor stream.
      await Effect.runPromise(Scope.close(scope, Exit.void));
      scope = null;
    }
    if (runtime !== null) {
      await runtime.dispose();
      runtime = null;
    }
  });

  async function harness(options?: {
    readonly startReactor?: boolean;
    readonly workspaceRoot?: string;
  }) {
    runtime = makeRuntime();
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const query = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const reactor = await runtime.runPromise(Effect.service(JarvisCompletionReactor));
    // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- The reactor API requires a caller-owned scope.
    scope = await Effect.runPromise(Scope.make("sequential"));
    await createThread(engine, options?.workspaceRoot);
    // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- Start is deliberately exposed as a promise to exercise startup replay and restart.
    const start = () => Effect.runPromise(reactor.start().pipe(Scope.provide(scope!)));
    if (options?.startReactor ?? true) await start();
    return {
      engine,
      query,
      // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- Drain is the deterministic synchronization point for the queue worker.
      drain: () => Effect.runPromise(reactor.drain),
      start,
    };
  }

  it("delivers a non-git completion without a checkpoint", async () => {
    const h = await harness({ workspaceRoot: "/tmp/jarvis-non-git-workspace" });
    const id = turnId("turn-non-git");
    await appendMarker(h.engine, "jarvis.task.created");
    await appendResult(h.engine, {
      id: "result-non-git",
      turnId: id,
      assistantMessageId: MessageId.make("assistant-non-git"),
    });
    await h.drain();
    expect(completionCount(await readThread(h.query))).toBe(1);
  });

  it("treats the terminal provider result as authoritative before a diff", async () => {
    const h = await harness();
    const id = turnId("turn-result-first");
    const assistantMessageId = MessageId.make("assistant-result-first");
    await appendMarker(h.engine, "jarvis.task.created");
    await appendResult(h.engine, { id: "result-first", turnId: id, assistantMessageId });
    await h.drain();
    expect(completionCount(await readThread(h.query))).toBe(1);
  });

  it("accepts a diff before the result and deduplicates the completion", async () => {
    const h = await harness();
    const id = turnId("turn-diff-first");
    const assistantMessageId = MessageId.make("assistant-diff-first");
    await appendMarker(h.engine, "jarvis.task.created");
    await appendDiff(h.engine, { turnId: id, assistantMessageId });
    await h.drain();
    await appendResult(h.engine, { id: "result-diff-first", turnId: id, assistantMessageId });
    await h.drain();
    await appendResult(h.engine, {
      id: "result-diff-first-duplicate",
      turnId: id,
      assistantMessageId,
    });
    await h.drain();
    expect(completionCount(await readThread(h.query))).toBe(1);
  });

  it("does not suppress delivery when persisted checkpoint failure activity exists", async () => {
    const h = await harness();
    const id = turnId("turn-checkpoint-failure");
    const assistantMessageId = MessageId.make("assistant-checkpoint-failure");
    await appendMarker(h.engine, "jarvis.task.created");
    await appendActivity(h.engine, {
      id: "checkpoint-failure",
      kind: "checkpoint.capture.failed",
      payload: { detail: "checkpoint capture failed" },
      turnId: id,
      tone: "error",
    });
    await appendDiff(h.engine, { turnId: id, assistantMessageId, status: "error" });
    await appendResult(h.engine, {
      id: "result-checkpoint-failure",
      turnId: id,
      assistantMessageId,
    });
    await h.drain();
    const thread = await readThread(h.query);
    expect(completionCount(thread)).toBe(1);
    expect(
      thread?.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
    ).toBe(true);
  });

  it("delivers when the workspace is unavailable", async () => {
    const h = await harness({ workspaceRoot: "/tmp/jarvis-missing-workspace" });
    const id = turnId("turn-missing-workspace");
    await appendMarker(h.engine, "jarvis.task.created");
    await appendResult(h.engine, {
      id: "result-missing-workspace",
      turnId: id,
      assistantMessageId: MessageId.make("assistant-missing-workspace"),
    });
    await h.drain();
    expect(completionCount(await readThread(h.query))).toBe(1);
  });

  it("repairs persisted results on startup exactly once", async () => {
    const h = await harness({ startReactor: false });
    const id = turnId("turn-startup-repair");
    await appendMarker(h.engine, "jarvis.task.created");
    await appendResult(h.engine, {
      id: "result-startup-repair",
      turnId: id,
      assistantMessageId: MessageId.make("assistant-startup-repair"),
    });
    await h.start();
    await h.drain();
    await h.start();
    await h.drain();
    expect(completionCount(await readThread(h.query))).toBe(1);
  });

  it("repairs a result that finalized before the Jarvis marker", async () => {
    const h = await harness();
    const id = turnId("turn-marker-after-result");
    await appendResult(h.engine, {
      id: "result-before-marker",
      turnId: id,
      assistantMessageId: MessageId.make("assistant-before-marker"),
    });
    await h.drain();
    expect(completionCount(await readThread(h.query))).toBe(0);
    await appendMarker(h.engine, "jarvis.task.created");
    await h.drain();
    expect(completionCount(await readThread(h.query))).toBe(1);
  });

  it("recognizes a Jarvis review marker", async () => {
    const h = await harness();
    const id = turnId("turn-review");
    await appendMarker(h.engine, "jarvis.review.source");
    await appendResult(h.engine, {
      id: "result-review",
      turnId: id,
      assistantMessageId: MessageId.make("assistant-review"),
    });
    await h.drain();
    expect(completionCount(await readThread(h.query))).toBe(1);
  });

  it("keeps ordinary T3 work out of Jarvis completion reports", async () => {
    const h = await harness();
    await appendResult(h.engine, {
      id: "result-ordinary-t3",
      turnId: turnId("turn-ordinary-t3"),
      assistantMessageId: MessageId.make("assistant-ordinary-t3"),
    });
    await h.drain();
    expect(completionCount(await readThread(h.query))).toBe(0);
  });
});
