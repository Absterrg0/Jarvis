import type { CirceMeshCatalog } from "@circe/client-runtime/circe/mesh";
import { EnvironmentId, ProjectId, ThreadId, ProviderInstanceId } from "@t3tools/contracts";
import type { DependencyList, EffectCallback } from "react";
import * as Cause from "effect/Cause";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import {
  interruptCirceInteractionSpeech,
  requestCirceCommandAction,
  onCirceCommandFeedback,
  onCirceTargetSnapshot,
  isCirceCommandPending,
  publishCirceTargetSnapshot,
  requestCirceTarget,
  resetCirceCommandBusForTests,
  submitCirceComposerCommand,
  type CirceCommandFeedback,
  type CirceTargetSnapshot,
} from "../../circeBus";
import type { CirceCommandTarget } from "../../circeBus";

const state = vi.hoisted(() => ({
  catalog: null as CirceMeshCatalog | null,
  effects: [] as Array<() => void>,
  cleanups: [] as Array<() => void>,
  refresh: vi.fn(),
  refreshNode: vi.fn(),
  execute: vi.fn(),
  interpret: vi.fn(),
  desk: vi.fn(),
  cancelRequest: vi.fn(),
  drain: undefined as (() => Promise<void>) | undefined,
  retryFailed: undefined as (() => Promise<void>) | undefined,
  speechEnqueued: [] as Array<{ readonly text: string; readonly deliveryId: string }>,
  speechCancelled: [] as Array<string>,
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness: harness } = await import("../../test/reactHookHarness");
  const sameDependencies = (left: DependencyList, right: DependencyList) =>
    left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  function useMemo<T>(factory: () => T, dependencies: DependencyList): T {
    const slot = harness.useRef<{ dependencies: DependencyList; value: T } | null>(null);
    if (slot.current === null || !sameDependencies(slot.current.dependencies, dependencies)) {
      slot.current = { dependencies, value: factory() };
    }
    return slot.current.value;
  }
  return {
    ...actual,
    useState: harness.useState,
    useRef: harness.useRef,
    useMemo,
    useCallback: <T,>(callback: T, dependencies: DependencyList) =>
      useMemo(() => callback, dependencies),
    useEffect: (effect: EffectCallback, dependencies: DependencyList) => {
      const slot = harness.useRef<{
        dependencies: DependencyList;
        cleanup: ReturnType<EffectCallback>;
      } | null>(null);
      if (slot.current !== null && sameDependencies(slot.current.dependencies, dependencies))
        return;
      state.effects.push(() => {
        slot.current?.cleanup?.();
        slot.current = { dependencies, cleanup: effect() };
        if (slot.current.cleanup) state.cleanups.push(slot.current.cleanup);
      });
    },
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("./CirceManager.logic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./CirceManager.logic")>();
  return {
    ...actual,
    createCirceVoiceSubmissionQueue: (
      ...args: Parameters<typeof actual.createCirceVoiceSubmissionQueue>
    ) => {
      const queue = actual.createCirceVoiceSubmissionQueue(...args);
      state.drain = queue.drain;
      state.retryFailed = queue.retryFailed;
      return queue;
    },
  };
});
vi.mock("../../state/environments", () => ({ usePrimaryEnvironmentId: () => "local" }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.catalog }));
vi.mock("../../state/circeMesh", () => ({
  circeMeshCatalogAtom: "catalog",
  circeMeshEnvironment: {
    refresh: "refresh",
    refreshNode: "refreshNode",
    execute: "execute",
    interpret: "interpret",
    getTaskDesk: "desk",
    cancelRequest: "cancelRequest",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (
    command: "refresh" | "refreshNode" | "execute" | "interpret" | "desk" | "cancelRequest",
  ) => state[command],
}));
vi.mock("./CirceVoiceReporter.logic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./CirceVoiceReporter.logic")>();
  return {
    ...actual,
    enqueueBrowserSpeech: (text: string, deliveryId: string) => {
      state.speechEnqueued.push({ text, deliveryId });
      return actual.enqueueBrowserSpeech(text, deliveryId);
    },
    cancelBrowserSpeech: (deliveryId: string) => {
      state.speechCancelled.push(deliveryId);
      return actual.cancelBrowserSpeech(deliveryId);
    },
  };
});
vi.mock("../../circeIdentity", () => ({ circeReporterIdentity: () => "interaction" }));
import { CirceVoiceRuntime } from "./CirceVoiceRuntime";

const localNode = EnvironmentId.make("local");
const remoteNode = EnvironmentId.make("remote");
const localProject = ProjectId.make("local-project");
const remoteProject = ProjectId.make("remote-project");
const threadId = ThreadId.make("task-1");

function catalogWith(local = true, remote = true): CirceMeshCatalog {
  return {
    nodes: [
      ...(local ? [{ nodeId: localNode, label: "Local", reachability: "online" as const }] : []),
      ...(remote ? [{ nodeId: remoteNode, label: "Remote", reachability: "online" as const }] : []),
    ],
    projects: [
      ...(local
        ? [
            {
              ref: { nodeId: localNode, projectId: localProject },
              projectId: localProject,
              title: "Local",
              workspaceRoot: "/local",
              nodeLabel: "Local",
              repositoryNames: [],
              aliases: [],
              aliasDetails: [],
            },
          ]
        : []),
      ...(remote
        ? [
            {
              ref: { nodeId: remoteNode, projectId: remoteProject },
              projectId: remoteProject,
              title: "Remote",
              workspaceRoot: "/remote",
              nodeLabel: "Remote",
              repositoryNames: [],
              aliases: [],
              aliasDetails: [],
            },
          ]
        : []),
    ],
    providers: [],
  };
}

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {
    throw new Error("Deferred not initialized");
  };
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("Circe composer to runtime boundary", () => {
  let feedback: CirceCommandFeedback[];
  let snapshots: Array<CirceTargetSnapshot | null>;
  let finished: ReturnType<typeof deferred<void>>;
  const consume = vi.fn();
  const started = vi.fn();

  function render(routeTarget: CirceCommandTarget | null = null) {
    hooks.beginRender();
    expect(
      CirceVoiceRuntime({
        routeTarget,
        onTargetConsumed: consume,
        onThreadStarted: started,
      }),
    ).toBeNull();
    for (const effect of state.effects.splice(0)) effect();
  }

  async function ready(next: CirceMeshCatalog = catalogWith()) {
    render();
    await state.refresh.mock.results[0]?.value;
    render();
    await Promise.resolve();
    render();
    await Promise.resolve();
    void next;
  }

  async function selectProject(
    projectRef: { nodeId: EnvironmentId; projectId: ProjectId },
    title?: string,
  ) {
    requestCirceTarget({
      type: "select-project",
      projectRef,
      ...(title === undefined ? {} : { projectTitle: title }),
    });
    render();
    await Promise.resolve();
    render();
  }

  beforeEach(() => {
    hooks.reset();
    resetCirceCommandBusForTests();
    publishCirceTargetSnapshot(null);
    state.effects = [];
    state.cleanups = [];
    state.speechEnqueued = [];
    state.speechCancelled = [];
    feedback = [];
    snapshots = [];
    finished = deferred<void>();
    consume.mockReset();
    started.mockReset().mockImplementation(() => finished.resolve());
    state.catalog = catalogWith();
    state.refresh.mockReset().mockResolvedValue({ _tag: "Success", value: state.catalog });
    state.refreshNode.mockReset().mockResolvedValue({ _tag: "Success", value: state.catalog });
    state.desk
      .mockReset()
      .mockResolvedValue({ _tag: "Success", value: { focusedTask: null, recentTasks: [] } });
    state.cancelRequest
      .mockReset()
      .mockImplementation(async (input: { input: { requestId: string } }) => ({
        _tag: "Success" as const,
        value: { status: "cancelled" as const, requestId: input.input.requestId },
      }));
    // Proposal-first routing: one interpret call with untrusted evidence and
    // no pins, then execution revalidates. Tests default to an empty proposal
    // (ambient) so existing expectations keep their target.
    state.interpret.mockReset().mockImplementation(async () => ({
      _tag: "Success" as const,
      value: { action: "start" as const, refs: [], model: null, effort: null, answer: null },
    }));
    state.execute.mockReset().mockImplementation(async () => ({
      _tag: "Success",
      value: {
        status: "started",
        threadId,
        objective: "Do work",
        acknowledgement: "Working on it.",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "sol" },
        taskRef: { executionNodeId: remoteNode, threadId },
      },
    }));
    onCirceCommandFeedback((entry) => feedback.push(entry));
    onCirceTargetSnapshot((snapshot) => snapshots.push(snapshot));
    vi.stubGlobal("window", {
      desktopBridge: undefined,
      speechSynthesis: undefined,
    });
  });

  afterEach(() => {
    for (const cleanup of state.cleanups) cleanup();
    vi.unstubAllGlobals();
    resetCirceCommandBusForTests();
  });

  it("runs a text composer entry without wire voice marking or speech", async () => {
    await ready();
    await selectProject({ nodeId: localNode, projectId: localProject }, "Local");
    submitCirceComposerCommand({
      text: "  Fix the bug  ",
      inputMode: "text",
      captureId: "text-1",
    });
    await finished.promise;
    expect(state.execute).toHaveBeenCalledTimes(1);
    expect(state.execute.mock.calls[0]?.[0]).toMatchObject({
      projectRef: { nodeId: localNode, projectId: localProject },
      utterance: "Fix the bug",
    });
    expect(state.execute.mock.calls[0]?.[0].requestMetadata).not.toHaveProperty("inputMode");
    expect(state.speechEnqueued).toEqual([]);
    expect(feedback.some((entry) => entry.inputMode === "text" && entry.text.length > 0)).toBe(
      true,
    );
  });

  it("sends a server clarification answer raw and keeps the same request", async () => {
    const question = deferred<void>();
    state.execute.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        status: "needs-input",
        reason: "effort-missing",
        prompt: "Which effort?",
        choices: ["low"],
      },
    });
    // Capture the prompt publication to release the pause.
    const seen: string[] = [];
    onCirceCommandFeedback((entry) => {
      if (entry.kind === "needs-input") {
        seen.push(entry.text);
        if (seen.length === 1) question.resolve();
      }
    });
    await ready();
    requestCirceTarget({
      type: "select-project",
      projectRef: { nodeId: localNode, projectId: localProject },
    });
    render();
    render();
    submitCirceComposerCommand({ text: "Use low to fix it", inputMode: "text", captureId: "c1" });
    await question.promise;
    await state.drain?.();
    submitCirceComposerCommand({ text: "low", inputMode: "text", captureId: "c2" });
    await finished.promise;
    const second = state.execute.mock.calls[1]?.[0];
    expect(second.utterance).toBe("low");
    expect(second.utterance).not.toContain("Use low to fix it\n");
    expect(second.requestMetadata.requestId).toBe(
      state.execute.mock.calls[0]?.[0].requestMetadata.requestId,
    );
  });

  it("pins an explicitly selected remote task across the next interaction", async () => {
    await ready();
    requestCirceTarget({
      type: "select-task",
      projectRef: { nodeId: remoteNode, projectId: remoteProject },
      threadId,
      title: "Remote work",
      taskRef: { executionNodeId: remoteNode, threadId },
    });
    render();
    await Promise.resolve();
    render();
    submitCirceComposerCommand({ text: "Continue", inputMode: "text", captureId: "r1" });
    await finished.promise;
    expect(state.execute.mock.calls[0]?.[0]).toMatchObject({
      projectRef: { nodeId: remoteNode, projectId: remoteProject },
      contextThreadId: threadId,
      referenceThreadId: threadId,
    });
    expect(snapshots.at(-1)).toMatchObject({
      projectRef: { nodeId: remoteNode, projectId: remoteProject },
      contextThreadId: threadId,
    });
    // Next interaction keeps the pinned remote target without reselecting.
    const secondDone = deferred<void>();
    started.mockImplementationOnce(() => secondDone.resolve());
    submitCirceComposerCommand({ text: "Again", inputMode: "text", captureId: "r2" });
    await secondDone.promise;
    expect(state.execute.mock.calls[1]?.[0]).toMatchObject({
      projectRef: { nodeId: remoteNode, projectId: remoteProject },
      contextThreadId: threadId,
    });
  });

  it("cancels a paused clarification without stranding later captures", async () => {
    const question = deferred<void>();
    onCirceCommandFeedback((entry) => {
      if (entry.kind === "needs-input" && entry.text.includes("Which project")) question.resolve();
    });
    await ready();
    // No explicit target: first entry pauses for project clarification.
    submitCirceComposerCommand({ text: "Fix it", inputMode: "text", captureId: "q1" });
    await question.promise;
    await state.drain?.();
    submitCirceComposerCommand({ text: "cancel", inputMode: "text", captureId: "q2" });
    await Promise.resolve();
    expect(feedback.some((entry) => entry.text.toLowerCase().includes("discard"))).toBe(true);
    const done = deferred<void>();
    requestCirceTarget({
      type: "select-project",
      projectRef: { nodeId: localNode, projectId: localProject },
    });
    render();
    started.mockImplementationOnce(() => done.resolve());
    submitCirceComposerCommand({ text: "Fix it now", inputMode: "text", captureId: "q3" });
    await done.promise;
    expect(state.execute).toHaveBeenCalled();
  });

  it("runs a full correction as fresh work instead of grafting the paused instruction", async () => {
    const alertify = ProjectId.make("alertify");
    const rivvl = ProjectId.make("rivvl");
    const named = (projectId: ProjectId, title: string) => ({
      ref: { nodeId: localNode, projectId },
      projectId,
      title,
      workspaceRoot: `/work/${projectId}`,
      nodeLabel: "Local",
      repositoryNames: [],
      aliases: [],
      aliasDetails: [],
    });
    state.catalog = {
      nodes: [{ nodeId: localNode, label: "Local", reachability: "online" as const }],
      projects: [named(rivvl, "Rivvl"), named(alertify, "Alertify")],
      providers: [],
    };
    state.refresh.mockResolvedValue({ _tag: "Success", value: state.catalog });
    state.refreshNode.mockResolvedValue({ _tag: "Success", value: state.catalog });
    // No semantic node: the deterministic grounding path owns routing.
    state.interpret.mockResolvedValue({ _tag: "Failure" });
    const question = deferred<void>();
    onCirceCommandFeedback((entry) => {
      if (entry.kind === "needs-input" && entry.text.includes("Did you mean")) question.resolve();
    });
    await ready();
    // "ripple" is heard for Rivvl: the first request pauses for confirmation.
    submitCirceComposerCommand({
      text: "check pull requests in ripple",
      inputMode: "text",
      captureId: "c1",
    });
    await question.promise;
    await state.drain?.();
    // The user restates the whole request with a different project instead of
    // answering the question. The paused objective must not run in Alertify.
    submitCirceComposerCommand({
      text: "please check pull requests in alertify",
      inputMode: "text",
      captureId: "c2",
    });
    await finished.promise;
    expect(state.execute).toHaveBeenCalledTimes(1);
    const executeInput = state.execute.mock.calls[0]?.[0];
    expect(executeInput.projectRef).toEqual({ nodeId: localNode, projectId: alertify });
    expect(executeInput.utterance.toLowerCase()).toContain("alertify");
    expect(executeInput.utterance).not.toContain("rivvl");
  });

  it("answers a general question in the focused task's project without asking", async () => {
    const focusedThreadId = ThreadId.make("task-focused");
    const focusedTask = {
      threadId: focusedThreadId,
      taskRef: { executionNodeId: localNode, threadId: focusedThreadId },
      projectRef: { nodeId: localNode, projectId: localProject },
      title: "Auth work",
      objective: "Auth work",
      state: "ready" as const,
      pendingReply: null,
    };
    state.desk.mockResolvedValue({
      _tag: "Success",
      value: { focusedTask, recentTasks: [focusedTask] },
    });
    state.catalog = {
      nodes: [
        {
          nodeId: localNode,
          label: "Local",
          reachability: "online" as const,
          capabilities: {
            preset: "full" as const,
            ui: true,
            execution: true,
            projects: true,
            providers: true,
            pushNotifications: false,
          },
        },
      ],
      projects: catalogWith(true, false).projects,
      providers: [],
    };
    state.refresh.mockResolvedValue({ _tag: "Success", value: state.catalog });
    state.interpret.mockResolvedValue({
      _tag: "Success",
      value: {
        action: "converse",
        refs: [],
        model: null,
        effort: null,
        answer: "Nothing new.",
      },
    });
    await ready();
    render();
    await Promise.resolve();
    // No target was ever selected: the focused task's project hosts the
    // conversation instead of a "which project?" question.
    submitCirceComposerCommand({
      text: "What is the weather today?",
      inputMode: "text",
      captureId: "cv-ctx",
    });
    await finished.promise;
    expect(state.execute).toHaveBeenCalledTimes(1);
    expect(state.execute.mock.calls[0]?.[0]).toMatchObject({
      projectRef: { nodeId: localNode, projectId: localProject },
      semanticProposal: { action: "converse" },
    });
  });

  it("homes a project-free conversation in the most recent local project", async () => {
    const localSecond = ProjectId.make("local-second");
    const named = (projectId: ProjectId, title: string) => ({
      ref: { nodeId: localNode, projectId },
      projectId,
      title,
      workspaceRoot: `/work/${projectId}`,
      nodeLabel: "Local",
      repositoryNames: [],
      aliases: [],
      aliasDetails: [],
    });
    const recentThreadId = ThreadId.make("task-recent");
    state.desk.mockResolvedValue({
      _tag: "Success",
      value: {
        focusedTask: null,
        recentTasks: [
          {
            threadId: recentThreadId,
            taskRef: { executionNodeId: localNode, threadId: recentThreadId },
            projectRef: { nodeId: localNode, projectId: localSecond },
            title: "Recent work",
            objective: "Recent work",
            state: "ready" as const,
            pendingReply: null,
          },
        ],
      },
    });
    state.catalog = {
      nodes: [
        {
          nodeId: localNode,
          label: "Local",
          reachability: "online" as const,
          capabilities: {
            preset: "full" as const,
            ui: true,
            execution: true,
            projects: true,
            providers: true,
            pushNotifications: false,
          },
        },
      ],
      projects: [named(localProject, "Local"), named(localSecond, "Second")],
      providers: [],
    };
    state.refresh.mockResolvedValue({ _tag: "Success", value: state.catalog });
    state.refreshNode.mockResolvedValue({ _tag: "Success", value: state.catalog });
    state.interpret.mockResolvedValue({
      _tag: "Success",
      value: {
        action: "converse",
        refs: [],
        model: null,
        effort: null,
        answer: "Nothing new.",
      },
    });
    await ready();
    render();
    await Promise.resolve();
    submitCirceComposerCommand({
      text: "What is the weather today?",
      inputMode: "text",
      captureId: "cv-recent",
    });
    await finished.promise;
    expect(state.execute).toHaveBeenCalledTimes(1);
    expect(state.execute.mock.calls[0]?.[0]).toMatchObject({
      projectRef: { nodeId: localNode, projectId: localSecond },
      semanticProposal: { action: "converse" },
    });
  });

  it("still resumes the paused instruction for a pure target answer", async () => {
    const alertify = ProjectId.make("alertify");
    const rivvl = ProjectId.make("rivvl");
    const named = (projectId: ProjectId, title: string) => ({
      ref: { nodeId: localNode, projectId },
      projectId,
      title,
      workspaceRoot: `/work/${projectId}`,
      nodeLabel: "Local",
      repositoryNames: [],
      aliases: [],
      aliasDetails: [],
    });
    state.catalog = {
      nodes: [{ nodeId: localNode, label: "Local", reachability: "online" as const }],
      projects: [named(rivvl, "Rivvl"), named(alertify, "Alertify")],
      providers: [],
    };
    state.refresh.mockResolvedValue({ _tag: "Success", value: state.catalog });
    state.refreshNode.mockResolvedValue({ _tag: "Success", value: state.catalog });
    // No semantic node: the deterministic grounding path owns confirmation.
    state.interpret.mockResolvedValue({ _tag: "Failure" });
    const question = deferred<void>();
    onCirceCommandFeedback((entry) => {
      if (entry.kind === "needs-input" && entry.text.includes("Did you mean")) question.resolve();
    });
    await ready();
    submitCirceComposerCommand({
      text: "check pull requests in ripple",
      inputMode: "text",
      captureId: "p1",
    });
    await question.promise;
    await state.drain?.();
    submitCirceComposerCommand({ text: "rivvl", inputMode: "text", captureId: "p2" });
    await finished.promise;
    expect(state.execute).toHaveBeenCalledTimes(1);
    expect(state.execute.mock.calls[0]?.[0]).toMatchObject({
      projectRef: { nodeId: localNode, projectId: rivvl },
      utterance: "check pull requests in ripple",
    });
  });

  it("dispatches a bounded command without any model call", async () => {
    await ready();
    submitCirceComposerCommand({
      text: "check pull requests in Local",
      inputMode: "text",
      captureId: "gram-1",
    });
    await finished.promise;
    // The deterministic grammar already produced the proposal: the supervisor
    // provider must never be spawned for a routine command.
    expect(state.interpret).not.toHaveBeenCalled();
    expect(state.execute).toHaveBeenCalledTimes(1);
    expect(state.execute.mock.calls[0]?.[0]).toMatchObject({
      projectRef: { nodeId: localNode, projectId: localProject },
      semanticProposal: { action: "start" },
    });
  });

  it("sends a project-scoped question to the provider as a conversation", async () => {
    state.interpret.mockResolvedValue({
      _tag: "Success",
      value: {
        action: "converse",
        refs: [],
        model: null,
        effort: null,
        answer: "Nothing new.",
      },
    });
    await ready();
    await selectProject({ nodeId: localNode, projectId: localProject }, "Local");
    submitCirceComposerCommand({
      text: "What is new today?",
      inputMode: "text",
      captureId: "cv-1",
    });
    await finished.promise;
    expect(state.execute).toHaveBeenCalledTimes(1);
    expect(state.execute.mock.calls[0]?.[0]).toMatchObject({
      projectRef: { nodeId: localNode, projectId: localProject },
      semanticProposal: { action: "converse" },
    });
    // The supervisor's inline answer is dropped in favor of the provider's
    // tool-capable answer in the durable thread.
    expect(feedback.some((entry) => entry.text === "Nothing new.")).toBe(false);
  });

  it("keeps a disconnected selection instead of choosing another node", async () => {
    await ready();
    requestCirceTarget({
      type: "select-project",
      projectRef: { nodeId: remoteNode, projectId: remoteProject },
      projectTitle: "Remote",
    });
    render();
    // Remote drops offline; the snapshot stays on remote and reports unavailable.
    state.catalog = {
      ...catalogWith(),
      nodes: [
        { nodeId: localNode, label: "Local", reachability: "online" },
        { nodeId: remoteNode, label: "Remote", reachability: "offline" },
      ],
    };
    render();
    await Promise.resolve();
    const latest = snapshots.at(-1);
    expect(latest?.projectRef).toEqual({ nodeId: remoteNode, projectId: remoteProject });
    expect(latest?.available).toBe(false);
  });

  it("asks for confirmation when a peer catalog is unread instead of guessing", async () => {
    const partial: CirceMeshCatalog = {
      nodes: [
        { nodeId: localNode, label: "Local", reachability: "online" },
        {
          nodeId: remoteNode,
          label: "Remote",
          reachability: "online",
          catalogError: "unreachable",
          catalogErrorKind: "unreachable",
        },
      ],
      projects: [
        {
          ref: { nodeId: localNode, projectId: localProject },
          projectId: localProject,
          title: "Atlas",
          workspaceRoot: "/atlas",
          nodeLabel: "Local",
          repositoryNames: [],
          aliases: [],
          aliasDetails: [],
        },
      ],
      providers: [],
    };
    state.catalog = partial;
    state.refresh.mockResolvedValue({ _tag: "Success", value: partial });
    state.refreshNode.mockResolvedValue({ _tag: "Success", value: partial });
    await ready(partial);
    render();
    submitCirceComposerCommand({ text: "Check out Atlas", inputMode: "text", captureId: "p1" });
    await state.drain?.();
    await Promise.resolve();
    expect(state.execute).not.toHaveBeenCalled();
    expect(
      feedback.some(
        (entry) => entry.kind === "needs-input" && entry.text.toLowerCase().includes("unreachable"),
      ),
    ).toBe(true);
  });

  it("sends a raw cancel to the exact paused server node and request", async () => {
    const question = deferred<void>();
    const cancelled = deferred<void>();
    state.execute.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        status: "needs-input",
        reason: "effort-missing",
        prompt: "Which effort?",
        choices: ["low"],
        clarificationFrameId: "frame-1",
      },
    });
    state.execute.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        status: "acknowledged",
        action: "status",
        threadId,
        projectId: localProject,
        message: "Cancelled that.",
      },
    });
    onCirceCommandFeedback((entry) => {
      if (entry.kind === "needs-input" && entry.text === "Which effort?") question.resolve();
      if (entry.kind === "done" && entry.text === "Cancelled that.") cancelled.resolve();
    });
    await ready();
    await selectProject({ nodeId: localNode, projectId: localProject }, "Local");
    submitCirceComposerCommand({ text: "Do it", inputMode: "text", captureId: "s1" });
    await question.promise;
    await state.drain?.();
    const first = state.execute.mock.calls[0]?.[0];
    submitCirceComposerCommand({ text: "cancel", inputMode: "text", captureId: "s2" });
    await cancelled.promise;
    expect(state.execute).toHaveBeenCalledTimes(2);
    expect(state.execute.mock.calls[1]?.[0]).toMatchObject({
      projectRef: { nodeId: localNode, projectId: localProject },
      utterance: "cancel",
      clarificationFrameId: "frame-1",
      requestMetadata: expect.objectContaining({ requestId: first.requestMetadata.requestId }),
    });
    expect(isCirceCommandPending()).toBe(false);
  });

  it("refuses to switch targets while a request is pending", async () => {
    const question = deferred<void>();
    const cancelled = deferred<void>();
    state.execute.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        status: "needs-input",
        reason: "effort-missing",
        prompt: "Which effort?",
        choices: ["low"],
        clarificationFrameId: "frame-switch",
      },
    });
    state.execute.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        status: "acknowledged",
        action: "status",
        threadId,
        projectId: localProject,
        message: "Cancelled.",
      },
    });
    onCirceCommandFeedback((entry) => {
      if (entry.kind === "needs-input" && entry.text === "Which effort?") question.resolve();
      if (entry.kind === "done") cancelled.resolve();
    });
    await ready();
    await selectProject({ nodeId: localNode, projectId: localProject }, "Local");
    submitCirceComposerCommand({ text: "Do it", inputMode: "text", captureId: "w1" });
    await question.promise;
    await state.drain?.();
    requestCirceTarget({
      type: "select-project",
      projectRef: { nodeId: remoteNode, projectId: remoteProject },
      projectTitle: "Remote",
    });
    render();
    await Promise.resolve();
    expect(snapshots.at(-1)?.projectRef).toEqual({
      nodeId: localNode,
      projectId: localProject,
    });
    expect(feedback.some((entry) => entry.text.includes("before switching targets"))).toBe(true);
    submitCirceComposerCommand({ text: "cancel", inputMode: "text", captureId: "w2" });
    await cancelled.promise;
    requestCirceTarget({
      type: "select-project",
      projectRef: { nodeId: remoteNode, projectId: remoteProject },
      projectTitle: "Remote",
    });
    render();
    await Promise.resolve();
    expect(snapshots.at(-1)?.projectRef).toEqual({
      nodeId: remoteNode,
      projectId: remoteProject,
    });
  });

  it("pins an explicit focus result from the server project, keeping the node", async () => {
    state.execute.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        status: "acknowledged",
        action: "focused",
        projectId: remoteProject,
        message: "Focused Remote.",
      },
    });
    await ready();
    await selectProject({ nodeId: localNode, projectId: localProject }, "Local");
    // Unbounded phrasing keeps this test on the model path: it verifies ack
    // pinning, not the deterministic grammar.
    submitCirceComposerCommand({
      text: "Focus on remote please",
      inputMode: "text",
      captureId: "f1",
    });
    await Promise.resolve();
    await state.drain?.();
    await Promise.resolve();
    render();
    await Promise.resolve();
    expect(snapshots.at(-1)).toMatchObject({
      projectRef: { nodeId: localNode, projectId: remoteProject },
    });
    expect(snapshots.at(-1)?.contextThreadId).toBeUndefined();
  });

  it("pins the ack task identity even when the desk focuses another task", async () => {
    const ackThread = ThreadId.make("task-ack-A");
    const deskThread = ThreadId.make("task-desk-B");
    state.execute.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        status: "acknowledged",
        action: "focused",
        projectId: remoteProject,
        taskRef: { executionNodeId: localNode, threadId: ackThread },
        message: "Focused task.",
      },
    });
    // The desk moved on to another task on the same project: the ack
    // identity still wins, never the desk's choice.
    state.desk.mockResolvedValue({
      _tag: "Success",
      value: {
        focusedTask: {
          threadId: deskThread,
          taskRef: { executionNodeId: localNode, threadId: deskThread },
          projectRef: { nodeId: localNode, projectId: remoteProject },
          title: "Desk task",
          objective: "Desk task",
          state: "ready",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "sol" },
        },
        recentTasks: [],
        pendingInteraction: null,
      },
    });
    await ready();
    await selectProject({ nodeId: localNode, projectId: localProject }, "Local");
    submitCirceComposerCommand({ text: "Focus task", inputMode: "text", captureId: "t2" });
    await Promise.resolve();
    await state.drain?.();
    await Promise.resolve();
    render();
    await Promise.resolve();
    expect(snapshots.at(-1)).toMatchObject({
      projectRef: { nodeId: localNode, projectId: remoteProject },
      contextThreadId: ackThread,
      taskRef: { executionNodeId: localNode, threadId: ackThread },
    });
  });

  it("leaves a project focus threadless even while the desk holds a task", async () => {
    const deskThread = ThreadId.make("task-desk-A");
    state.execute.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        status: "acknowledged",
        action: "focused",
        projectId: remoteProject,
        message: "Focused Remote.",
      },
    });
    state.desk.mockResolvedValue({
      _tag: "Success",
      value: {
        focusedTask: {
          threadId: deskThread,
          taskRef: { executionNodeId: localNode, threadId: deskThread },
          projectRef: { nodeId: localNode, projectId: remoteProject },
          title: "Desk task",
          objective: "Desk task",
          state: "ready",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "sol" },
        },
        recentTasks: [],
        pendingInteraction: null,
      },
    });
    await ready();
    await selectProject({ nodeId: localNode, projectId: localProject }, "Local");
    submitCirceComposerCommand({
      text: "Focus on remote please",
      inputMode: "text",
      captureId: "t3",
    });
    await Promise.resolve();
    await state.drain?.();
    await Promise.resolve();
    render();
    await Promise.resolve();
    expect(snapshots.at(-1)).toMatchObject({
      projectRef: { nodeId: localNode, projectId: remoteProject },
    });
    expect(snapshots.at(-1)?.contextThreadId).toBeUndefined();
  });

  it("leaves no target after an explicit clear even with a local route visible", async () => {
    await ready();
    const route: CirceCommandTarget = {
      environmentId: localNode,
      projectId: localProject,
      contextThreadId: threadId,
      contextThreadTitle: "Local thread",
    };
    render(route);
    await Promise.resolve();
    render(route);
    expect(snapshots.at(-1)?.projectRef).toEqual({
      nodeId: localNode,
      projectId: localProject,
    });
    requestCirceTarget({ type: "clear" });
    render(route);
    await Promise.resolve();
    expect(snapshots.at(-1)).toBeNull();
  });

  it("reports idle pending state after a successful command", async () => {
    await ready();
    await selectProject({ nodeId: localNode, projectId: localProject }, "Local");
    submitCirceComposerCommand({ text: "Fix it", inputMode: "text", captureId: "i1" });
    await finished.promise;
    await state.drain?.();
    render();
    expect(isCirceCommandPending()).toBe(false);
  });

  it("discards a server clarification locally when the frame has no id", async () => {
    const question = deferred<void>();
    const discarded = deferred<void>();
    state.execute.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        status: "needs-input",
        reason: "effort-missing",
        prompt: "Which effort?",
        choices: ["low"],
      },
    });
    onCirceCommandFeedback((entry) => {
      if (entry.kind === "needs-input" && entry.text === "Which effort?") question.resolve();
      if (entry.kind === "done" && entry.text.toLowerCase().includes("discard"))
        discarded.resolve();
    });
    await ready();
    await selectProject({ nodeId: localNode, projectId: localProject }, "Local");
    submitCirceComposerCommand({ text: "Do it", inputMode: "text", captureId: "d1" });
    await question.promise;
    await state.drain?.();
    // A legacy frame without an id is local-only: cancelling dispatches
    // nothing and can deny nothing.
    submitCirceComposerCommand({ text: "cancel", inputMode: "text", captureId: "d2" });
    await discarded.promise;
    expect(state.execute).toHaveBeenCalledTimes(1);
    expect(isCirceCommandPending()).toBe(false);
  });

  it("retains the server answer pin for the answer, then clears it from the desk", async () => {
    const question = deferred<void>();
    state.execute.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        status: "needs-input",
        reason: "effort-missing",
        prompt: "Which effort?",
        choices: ["low"],
        clarificationFrameId: "frame-pin",
        expectedReply: { kind: "input", requestId: "req-pin-1" },
      },
    });
    onCirceCommandFeedback((entry) => {
      if (entry.kind === "needs-input" && entry.text === "Which effort?") question.resolve();
    });
    await ready();
    requestCirceTarget({
      type: "select-task",
      projectRef: { nodeId: localNode, projectId: localProject },
      threadId,
      title: "Local work",
      taskRef: { executionNodeId: localNode, threadId },
    });
    render();
    await Promise.resolve();
    render();
    submitCirceComposerCommand({ text: "Do it", inputMode: "text", captureId: "e1" });
    await question.promise;
    await state.drain?.();
    submitCirceComposerCommand({ text: "low", inputMode: "text", captureId: "e2" });
    await finished.promise;
    // The answer carries the exact pin and frame from the server frame.
    expect(state.execute.mock.calls[1]?.[0]).toMatchObject({
      utterance: "low",
      clarificationFrameId: "frame-pin",
      expectedReply: { kind: "input", requestId: "req-pin-1" },
    });
    // The answered request is complete: the desk shows no unique pending, so
    // the follow-up pins an explicit null instead of the stale request.
    const thirdDone = deferred<void>();
    started.mockImplementationOnce(() => thirdDone.resolve());
    render();
    await Promise.resolve();
    render();
    submitCirceComposerCommand({ text: "Again", inputMode: "text", captureId: "e3" });
    await thirdDone.promise;
    expect(state.execute.mock.calls[2]?.[0]).toMatchObject({
      expectedReply: null,
    });
  });

  it("retires the local prompt when a cancel finds the frame already gone", async () => {
    const question = deferred<void>();
    const retired = deferred<void>();
    state.execute.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        status: "needs-input",
        reason: "effort-missing",
        prompt: "Which effort?",
        choices: ["low"],
        clarificationFrameId: "frame-gone",
      },
    });
    state.execute.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        status: "needs-input",
        reason: "source-output-unavailable",
        prompt: "That request is no longer waiting.",
        choices: [],
      },
    });
    onCirceCommandFeedback((entry) => {
      if (entry.kind === "needs-input" && entry.text === "Which effort?") question.resolve();
      if (entry.kind === "done" && entry.text.includes("nothing was cancelled")) retired.resolve();
    });
    await ready();
    await selectProject({ nodeId: localNode, projectId: localProject }, "Local");
    submitCirceComposerCommand({ text: "Do it", inputMode: "text", captureId: "g1" });
    await question.promise;
    await state.drain?.();
    submitCirceComposerCommand({ text: "cancel", inputMode: "text", captureId: "g2" });
    await retired.promise;
    // The cancel went out with the exact frame id but the frame had moved
    // on: the local prompt retires without ever claiming a server cancel.
    expect(state.execute.mock.calls[1]?.[0]).toMatchObject({
      utterance: "cancel",
      clarificationFrameId: "frame-gone",
    });
    expect(feedback.some((entry) => entry.text.toLowerCase().includes("discard"))).toBe(false);
    expect(state.execute).toHaveBeenCalledTimes(2);
    expect(isCirceCommandPending()).toBe(false);
    // The surface unlocks for an explicit fresh target choice.
    await selectProject({ nodeId: remoteNode, projectId: remoteProject }, "Remote");
    expect(snapshots.at(-1)?.projectRef).toEqual({
      nodeId: remoteNode,
      projectId: remoteProject,
    });
  });

  it("keeps the known pin and frame when a stale reply omits them", async () => {
    const firstQuestion = deferred<void>();
    const secondQuestion = deferred<void>();
    state.execute.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        status: "needs-input",
        reason: "effort-missing",
        prompt: "Which effort?",
        choices: ["low"],
        clarificationFrameId: "frame-A",
        // Stale: no expectedReply even though the desk snapshot pinned req-A.
      },
    });
    state.execute.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        status: "needs-input",
        reason: "effort-missing",
        prompt: "Which effort, really?",
        choices: ["low"],
        // Stale again: neither a replacement pin nor a frame.
      },
    });
    onCirceCommandFeedback((entry) => {
      if (entry.kind === "needs-input" && entry.text === "Which effort?") firstQuestion.resolve();
      if (entry.kind === "needs-input" && entry.text === "Which effort, really?")
        secondQuestion.resolve();
    });
    await ready();
    requestCirceTarget({
      type: "select-task",
      projectRef: { nodeId: localNode, projectId: localProject },
      threadId,
      title: "Local work",
      taskRef: { executionNodeId: localNode, threadId },
      pendingReply: { kind: "user-input", requestId: "req-A" },
    });
    render();
    await Promise.resolve();
    render();
    submitCirceComposerCommand({ text: "Do it", inputMode: "text", captureId: "h1" });
    await firstQuestion.promise;
    await state.drain?.();
    submitCirceComposerCommand({ text: "allow", inputMode: "text", captureId: "h2" });
    await Promise.resolve();
    await state.drain?.();
    await Promise.resolve();
    // The retry still answers the known pin on the known frame.
    expect(state.execute.mock.calls[1]?.[0]).toMatchObject({
      utterance: "allow",
      clarificationFrameId: "frame-A",
      expectedReply: { kind: "input", requestId: "req-A" },
    });
    // The second stale reply is already stored; answer through it.
    await secondQuestion.promise;
    await state.drain?.();
    submitCirceComposerCommand({ text: "allow", inputMode: "text", captureId: "h3" });
    await finished.promise;
    expect(state.execute.mock.calls[2]?.[0]).toMatchObject({
      utterance: "allow",
      clarificationFrameId: "frame-A",
      expectedReply: { kind: "input", requestId: "req-A" },
    });
  });

  it("answers a newly arrived approval from the live desk, not the start-time snapshot", async () => {
    await ready();
    requestCirceTarget({
      type: "select-task",
      projectRef: { nodeId: localNode, projectId: localProject },
      threadId,
      title: "Local work",
      taskRef: { executionNodeId: localNode, threadId },
    });
    render();
    await Promise.resolve();
    render();
    state.execute.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        status: "started",
        threadId,
        objective: "Do work",
        acknowledgement: "Working on it.",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "sol" },
        taskRef: { executionNodeId: localNode, threadId },
      },
    });
    submitCirceComposerCommand({ text: "Do it", inputMode: "text", captureId: "p1" });
    await finished.promise;
    // The provider requests approval after the task started. The stored
    // snapshot still holds no pin; the live desk names the request.
    state.desk.mockResolvedValue({
      _tag: "Success",
      value: {
        focusedTask: {
          threadId,
          title: "Local work",
          taskRef: { executionNodeId: localNode, threadId },
          projectRef: { nodeId: localNode, projectId: localProject },
          pendingReply: { kind: "approval", requestId: "req-live" },
        },
        recentTasks: [],
        pendingInteraction: null,
      },
    });
    render();
    await Promise.resolve();
    render();
    const answered = deferred<void>();
    started.mockImplementationOnce(() => answered.resolve());
    submitCirceComposerCommand({ text: "allow", inputMode: "text", captureId: "p2" });
    await answered.promise;
    expect(state.execute.mock.calls[1]?.[0]).toMatchObject({
      utterance: "allow",
      expectedReply: { kind: "approval", requestId: "req-live" },
    });
  });

  it("keeps the bound answer pin across a transport-failure retry", async () => {
    const question = deferred<void>();
    state.execute.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        status: "needs-input",
        reason: "effort-missing",
        prompt: "Which effort?",
        choices: ["low"],
        clarificationFrameId: "frame-retry",
        expectedReply: { kind: "input", requestId: "req-retry" },
      },
    });
    state.execute.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(new Error("flaky network")),
    });
    const transportFailed = deferred<void>();
    onCirceCommandFeedback((entry) => {
      if (entry.kind === "needs-input" && entry.text === "Which effort?") question.resolve();
      if (entry.kind === "error") transportFailed.resolve();
    });
    await ready();
    requestCirceTarget({
      type: "select-task",
      projectRef: { nodeId: localNode, projectId: localProject },
      threadId,
      title: "Local work",
      taskRef: { executionNodeId: localNode, threadId },
    });
    render();
    await Promise.resolve();
    render();
    submitCirceComposerCommand({ text: "Do it", inputMode: "text", captureId: "r1" });
    await question.promise;
    await state.drain?.();
    submitCirceComposerCommand({ text: "low", inputMode: "text", captureId: "r2" });
    await transportFailed.promise;
    await state.drain?.();
    submitCirceComposerCommand({ text: "low", inputMode: "text", captureId: "r3" });
    await finished.promise;
    expect(state.execute.mock.calls[1]?.[0]).toMatchObject({
      clarificationFrameId: "frame-retry",
      expectedReply: { kind: "input", requestId: "req-retry" },
    });
    // The transport failure must not rebind the answer to a replacement.
    expect(state.execute.mock.calls[2]?.[0]).toMatchObject({
      clarificationFrameId: "frame-retry",
      expectedReply: { kind: "input", requestId: "req-retry" },
    });
  });

  it("falls back to the snapshot pin when the live desk read fails", async () => {
    await ready();
    requestCirceTarget({
      type: "select-task",
      projectRef: { nodeId: localNode, projectId: localProject },
      threadId,
      title: "Local work",
      taskRef: { executionNodeId: localNode, threadId },
      pendingReply: { kind: "user-input", requestId: "req-snapshot" },
    });
    render();
    await Promise.resolve();
    render();
    state.desk.mockRejectedValue(new Error("node unreachable"));
    submitCirceComposerCommand({ text: "Answer it", inputMode: "text", captureId: "q1" });
    await finished.promise;
    // Unknown desk state must not invent or erase a pin: the retained
    // snapshot answers instead of failing the interaction.
    expect(state.execute.mock.calls[0]?.[0]).toMatchObject({
      expectedReply: { kind: "input", requestId: "req-snapshot" },
    });
  });

  it("retracts interaction speech when a browser clarification is cancelled", async () => {
    const question = deferred<void>();
    const cancelled = deferred<void>();
    state.execute.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        status: "needs-input",
        reason: "effort-missing",
        prompt: "Which effort?",
        choices: ["low"],
        clarificationFrameId: "frame-speech",
      },
    });
    state.execute.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        status: "acknowledged",
        action: "focused",
        projectId: localProject,
        message: "Cancelled selection.",
      },
    });
    onCirceCommandFeedback((entry) => {
      if (entry.kind === "needs-input" && entry.text === "Which effort?") question.resolve();
      if (entry.kind === "done" && entry.text === "Cancelled selection.") cancelled.resolve();
    });
    await ready();
    await selectProject({ nodeId: localNode, projectId: localProject }, "Local");
    submitCirceComposerCommand({ text: "Do it", inputMode: "voice", captureId: "s1" });
    await question.promise;
    await state.drain?.();
    const spoken = state.speechEnqueued.at(-1);
    expect(spoken?.text).toBe("Which effort?");
    submitCirceComposerCommand({ text: "cancel", inputMode: "voice", captureId: "s2" });
    await cancelled.promise;
    // The prompt's delivery is retracted, not left playing behind the
    // cancellation confirmation.
    expect(state.speechCancelled).toContain(spoken?.deliveryId);
    // The confirmation itself speaks normally through the same lane.
    expect(state.speechEnqueued.at(-1)?.text).toBe("Cancelled selection.");
  });

  it("supersedes speaking feedback when a new submission takes the floor", async () => {
    const question = deferred<void>();
    state.execute.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        status: "needs-input",
        reason: "effort-missing",
        prompt: "Which effort?",
        choices: ["low"],
        clarificationFrameId: "frame-super",
      },
    });
    onCirceCommandFeedback((entry) => {
      if (entry.kind === "needs-input" && entry.text === "Which effort?") question.resolve();
    });
    await ready();
    await selectProject({ nodeId: localNode, projectId: localProject }, "Local");
    submitCirceComposerCommand({ text: "Do it", inputMode: "voice", captureId: "u1" });
    await question.promise;
    await state.drain?.();
    const spoken = state.speechEnqueued.at(-1);
    expect(spoken?.text).toBe("Which effort?");
    submitCirceComposerCommand({ text: "low", inputMode: "voice", captureId: "u2" });
    await finished.promise;
    expect(state.speechCancelled).toContain(spoken?.deliveryId);
  });

  it("retracts interaction speech when a new capture takes the floor", async () => {
    const question = deferred<void>();
    state.execute.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        status: "needs-input",
        reason: "effort-missing",
        prompt: "Which effort?",
        choices: ["low"],
        clarificationFrameId: "frame-floor",
      },
    });
    onCirceCommandFeedback((entry) => {
      if (entry.kind === "needs-input" && entry.text === "Which effort?") question.resolve();
    });
    await ready();
    await selectProject({ nodeId: localNode, projectId: localProject }, "Local");
    submitCirceComposerCommand({ text: "Do it", inputMode: "voice", captureId: "f1" });
    await question.promise;
    await state.drain?.();
    const spoken = state.speechEnqueued.at(-1);
    expect(spoken?.text).toBe("Which effort?");
    interruptCirceInteractionSpeech();
    expect(state.speechCancelled).toContain(spoken?.deliveryId);
  });

  it("retracts interaction speech when its owning runtime is disposed", async () => {
    const question = deferred<void>();
    state.execute.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        status: "needs-input",
        reason: "effort-missing",
        prompt: "Which effort?",
        choices: ["low"],
        clarificationFrameId: "frame-dispose",
      },
    });
    onCirceCommandFeedback((entry) => {
      if (entry.kind === "needs-input" && entry.text === "Which effort?") question.resolve();
    });
    await ready();
    await selectProject({ nodeId: localNode, projectId: localProject }, "Local");
    submitCirceComposerCommand({ text: "Do it", inputMode: "voice", captureId: "d1" });
    await question.promise;
    await state.drain?.();
    const spoken = state.speechEnqueued.at(-1);
    expect(spoken?.text).toBe("Which effort?");
    for (const cleanup of state.cleanups.splice(0)) cleanup();
    expect(state.speechCancelled).toContain(spoken?.deliveryId);
  });
  it.each([
    { kind: "approval", requestId: "A" },
    { kind: "user-input", requestId: "A" },
    null,
    undefined,
  ] as const)("direct answer retry preserves its complete request: %j", async (pin) => {
    await ready();
    requestCirceTarget({
      type: "select-task",
      projectRef: { nodeId: localNode, projectId: localProject },
      threadId,
      taskRef: { executionNodeId: localNode, threadId },
      ...(pin === undefined ? {} : { pendingReply: pin }),
    });
    render();
    await Promise.resolve();
    render();
    const desk = (requestId: string) => ({
      _tag: "Success",
      value: {
        focusedTask: {
          threadId,
          taskRef: { executionNodeId: localNode, threadId },
          projectRef: { nodeId: localNode, projectId: localProject },
          pendingReply: { kind: "approval", requestId },
        },
        recentTasks: [],
      },
    });
    state.desk.mockResolvedValue({
      _tag: "Success",
      value: { focusedTask: null, recentTasks: [] },
    });
    state.execute.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(new Error("transport failed")),
    });
    const failed = deferred<void>();
    onCirceCommandFeedback((entry) => {
      if (entry.kind === "error") failed.resolve();
    });
    submitCirceComposerCommand({ text: "allow", inputMode: "text", captureId: "direct-answer" });
    await failed.promise;
    await state.drain?.();
    render();
    const original = state.execute.mock.calls[0]?.[0];
    expect(original.expectedReply).toEqual(
      pin == null ? pin : { kind: pin.kind === "approval" ? "approval" : "input", requestId: "A" },
    );
    state.desk.mockResolvedValue(desk("B"));
    await state.retryFailed?.();
    expect(state.execute.mock.calls[1]?.[0]).toEqual(original);
  });
  it("cancels waiting submissions while retaining an in-flight result", async () => {
    await ready();
    await selectProject({ nodeId: localNode, projectId: localProject }, "Local");
    const entered = deferred<void>();
    const response = deferred<{
      _tag: "Success";
      value: { status: "acknowledged"; action: "stopped"; message: string };
    }>();
    state.execute.mockImplementationOnce(() => {
      entered.resolve();
      return response.promise;
    });
    submitCirceComposerCommand({ text: "status", inputMode: "text", captureId: "active" });
    await entered.promise;
    submitCirceComposerCommand({ text: "later", inputMode: "text", captureId: "waiting" });
    requestCirceCommandAction({ type: "cancel", inputMode: "text" });
    expect(isCirceCommandPending()).toBe(true);
    response.resolve({
      _tag: "Success",
      value: { status: "acknowledged", action: "stopped", message: "Current result" },
    });
    await state.drain?.();
    expect(state.execute).toHaveBeenCalledTimes(1);
    expect(feedback.at(-1)?.text).toBe("Current result");
    expect(isCirceCommandPending()).toBe(false);
  });
});
