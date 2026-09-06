import type { JarvisMeshCatalog } from "@t3tools/jarvis-client-runtime/jarvis/mesh";
import { EnvironmentId, ProjectId, ThreadId, ProviderInstanceId } from "@t3tools/contracts";
import type { DependencyList, EffectCallback } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import {
  onJarvisCommandFeedback,
  onJarvisTargetSnapshot,
  isJarvisCommandPending,
  publishJarvisTargetSnapshot,
  requestJarvisTarget,
  resetJarvisCommandBusForTests,
  submitJarvisComposerCommand,
  type JarvisCommandFeedback,
  type JarvisTargetSnapshot,
} from "../../jarvisBus";
import type { JarvisCommandTarget } from "../../jarvisBus";

const state = vi.hoisted(() => ({
  catalog: null as JarvisMeshCatalog | null,
  effects: [] as Array<() => void>,
  cleanups: [] as Array<() => void>,
  refresh: vi.fn(),
  refreshNode: vi.fn(),
  execute: vi.fn(),
  desk: vi.fn(),
  drain: undefined as (() => Promise<void>) | undefined,
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
vi.mock("./JarvisManager.logic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./JarvisManager.logic")>();
  return {
    ...actual,
    createJarvisVoiceSubmissionQueue: (
      ...args: Parameters<typeof actual.createJarvisVoiceSubmissionQueue>
    ) => {
      const queue = actual.createJarvisVoiceSubmissionQueue(...args);
      state.drain = queue.drain;
      return queue;
    },
  };
});
vi.mock("../../state/environments", () => ({ usePrimaryEnvironmentId: () => "local" }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.catalog }));
vi.mock("../../state/jarvisMesh", () => ({
  jarvisMeshCatalogAtom: "catalog",
  jarvisMeshEnvironment: {
    refresh: "refresh",
    refreshNode: "refreshNode",
    execute: "execute",
    getTaskDesk: "desk",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: "refresh" | "refreshNode" | "execute" | "desk") => state[command],
}));
vi.mock("../../jarvisIdentity", () => ({ jarvisReporterIdentity: () => "interaction" }));
import { JarvisVoiceRuntime } from "./JarvisVoiceRuntime";

const localNode = EnvironmentId.make("local");
const remoteNode = EnvironmentId.make("remote");
const localProject = ProjectId.make("local-project");
const remoteProject = ProjectId.make("remote-project");
const threadId = ThreadId.make("task-1");

function catalogWith(local = true, remote = true): JarvisMeshCatalog {
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

describe("Jarvis composer to runtime boundary", () => {
  let feedback: JarvisCommandFeedback[];
  let snapshots: Array<JarvisTargetSnapshot | null>;
  let finished: ReturnType<typeof deferred<void>>;
  const consume = vi.fn();
  const started = vi.fn();
  const speak = vi.fn();

  function render(routeTarget: JarvisCommandTarget | null = null) {
    hooks.beginRender();
    expect(
      JarvisVoiceRuntime({
        routeTarget,
        onTargetConsumed: consume,
        onThreadStarted: started,
      }),
    ).toBeNull();
    for (const effect of state.effects.splice(0)) effect();
  }

  async function ready(next: JarvisMeshCatalog = catalogWith()) {
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
    requestJarvisTarget({
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
    resetJarvisCommandBusForTests();
    publishJarvisTargetSnapshot(null);
    state.effects = [];
    state.cleanups = [];
    feedback = [];
    snapshots = [];
    finished = deferred<void>();
    consume.mockReset();
    started.mockReset().mockImplementation(() => finished.resolve());
    speak.mockReset().mockResolvedValue({ status: "spoken" });
    state.catalog = catalogWith();
    state.refresh.mockReset().mockResolvedValue({ _tag: "Success", value: state.catalog });
    state.refreshNode.mockReset().mockResolvedValue({ _tag: "Success", value: state.catalog });
    state.desk
      .mockReset()
      .mockResolvedValue({ _tag: "Success", value: { focusedTask: null, recentTasks: [] } });
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
    onJarvisCommandFeedback((entry) => feedback.push(entry));
    onJarvisTargetSnapshot((snapshot) => snapshots.push(snapshot));
    vi.stubGlobal("window", {
      desktopBridge: undefined,
      speechSynthesis: undefined,
    });
  });

  afterEach(() => {
    for (const cleanup of state.cleanups) cleanup();
    vi.unstubAllGlobals();
    resetJarvisCommandBusForTests();
  });

  it("runs a text composer entry without wire voice marking or speech", async () => {
    await ready();
    await selectProject({ nodeId: localNode, projectId: localProject }, "Local");
    submitJarvisComposerCommand({
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
    expect(speak).not.toHaveBeenCalled();
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
    onJarvisCommandFeedback((entry) => {
      if (entry.kind === "needs-input") {
        seen.push(entry.text);
        if (seen.length === 1) question.resolve();
      }
    });
    await ready();
    requestJarvisTarget({
      type: "select-project",
      projectRef: { nodeId: localNode, projectId: localProject },
    });
    render();
    render();
    submitJarvisComposerCommand({ text: "Use low to fix it", inputMode: "text", captureId: "c1" });
    await question.promise;
    await state.drain?.();
    submitJarvisComposerCommand({ text: "low", inputMode: "text", captureId: "c2" });
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
    requestJarvisTarget({
      type: "select-task",
      projectRef: { nodeId: remoteNode, projectId: remoteProject },
      threadId,
      title: "Remote work",
      taskRef: { executionNodeId: remoteNode, threadId },
    });
    render();
    await Promise.resolve();
    render();
    submitJarvisComposerCommand({ text: "Continue", inputMode: "text", captureId: "r1" });
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
    submitJarvisComposerCommand({ text: "Again", inputMode: "text", captureId: "r2" });
    await secondDone.promise;
    expect(state.execute.mock.calls[1]?.[0]).toMatchObject({
      projectRef: { nodeId: remoteNode, projectId: remoteProject },
      contextThreadId: threadId,
    });
  });

  it("cancels a paused clarification without stranding later captures", async () => {
    const question = deferred<void>();
    onJarvisCommandFeedback((entry) => {
      if (entry.kind === "needs-input" && entry.text.includes("Which project")) question.resolve();
    });
    await ready();
    // No explicit target: first entry pauses for project clarification.
    submitJarvisComposerCommand({ text: "Fix it", inputMode: "text", captureId: "q1" });
    await question.promise;
    await state.drain?.();
    submitJarvisComposerCommand({ text: "cancel", inputMode: "text", captureId: "q2" });
    await Promise.resolve();
    expect(feedback.some((entry) => entry.text.toLowerCase().includes("discard"))).toBe(true);
    const done = deferred<void>();
    requestJarvisTarget({
      type: "select-project",
      projectRef: { nodeId: localNode, projectId: localProject },
    });
    render();
    started.mockImplementationOnce(() => done.resolve());
    submitJarvisComposerCommand({ text: "Fix it now", inputMode: "text", captureId: "q3" });
    await done.promise;
    expect(state.execute).toHaveBeenCalled();
  });

  it("keeps a disconnected selection instead of choosing another node", async () => {
    await ready();
    requestJarvisTarget({
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
    const partial: JarvisMeshCatalog = {
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
    submitJarvisComposerCommand({ text: "Check out Atlas", inputMode: "text", captureId: "p1" });
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
    onJarvisCommandFeedback((entry) => {
      if (entry.kind === "needs-input" && entry.text === "Which effort?") question.resolve();
      if (entry.kind === "done" && entry.text === "Cancelled that.") cancelled.resolve();
    });
    await ready();
    await selectProject({ nodeId: localNode, projectId: localProject }, "Local");
    submitJarvisComposerCommand({ text: "Do it", inputMode: "text", captureId: "s1" });
    await question.promise;
    await state.drain?.();
    const first = state.execute.mock.calls[0]?.[0];
    submitJarvisComposerCommand({ text: "cancel", inputMode: "text", captureId: "s2" });
    await cancelled.promise;
    expect(state.execute).toHaveBeenCalledTimes(2);
    expect(state.execute.mock.calls[1]?.[0]).toMatchObject({
      projectRef: { nodeId: localNode, projectId: localProject },
      utterance: "cancel",
      clarificationFrameId: "frame-1",
      requestMetadata: expect.objectContaining({ requestId: first.requestMetadata.requestId }),
    });
    expect(isJarvisCommandPending()).toBe(false);
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
    onJarvisCommandFeedback((entry) => {
      if (entry.kind === "needs-input" && entry.text === "Which effort?") question.resolve();
      if (entry.kind === "done") cancelled.resolve();
    });
    await ready();
    await selectProject({ nodeId: localNode, projectId: localProject }, "Local");
    submitJarvisComposerCommand({ text: "Do it", inputMode: "text", captureId: "w1" });
    await question.promise;
    await state.drain?.();
    requestJarvisTarget({
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
    submitJarvisComposerCommand({ text: "cancel", inputMode: "text", captureId: "w2" });
    await cancelled.promise;
    requestJarvisTarget({
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
    submitJarvisComposerCommand({ text: "Focus remote", inputMode: "text", captureId: "f1" });
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
    submitJarvisComposerCommand({ text: "Focus task", inputMode: "text", captureId: "t2" });
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
    submitJarvisComposerCommand({ text: "Focus remote", inputMode: "text", captureId: "t3" });
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
    const route: JarvisCommandTarget = {
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
    requestJarvisTarget({ type: "clear" });
    render(route);
    await Promise.resolve();
    expect(snapshots.at(-1)).toBeNull();
  });

  it("reports idle pending state after a successful command", async () => {
    await ready();
    await selectProject({ nodeId: localNode, projectId: localProject }, "Local");
    submitJarvisComposerCommand({ text: "Fix it", inputMode: "text", captureId: "i1" });
    await finished.promise;
    render();
    await Promise.resolve();
    expect(isJarvisCommandPending()).toBe(false);
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
    onJarvisCommandFeedback((entry) => {
      if (entry.kind === "needs-input" && entry.text === "Which effort?") question.resolve();
      if (entry.kind === "done" && entry.text.toLowerCase().includes("discard"))
        discarded.resolve();
    });
    await ready();
    await selectProject({ nodeId: localNode, projectId: localProject }, "Local");
    submitJarvisComposerCommand({ text: "Do it", inputMode: "text", captureId: "d1" });
    await question.promise;
    await state.drain?.();
    // A legacy frame without an id is local-only: cancelling dispatches
    // nothing and can deny nothing.
    submitJarvisComposerCommand({ text: "cancel", inputMode: "text", captureId: "d2" });
    await discarded.promise;
    expect(state.execute).toHaveBeenCalledTimes(1);
    expect(isJarvisCommandPending()).toBe(false);
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
    onJarvisCommandFeedback((entry) => {
      if (entry.kind === "needs-input" && entry.text === "Which effort?") question.resolve();
    });
    await ready();
    requestJarvisTarget({
      type: "select-task",
      projectRef: { nodeId: localNode, projectId: localProject },
      threadId,
      title: "Local work",
      taskRef: { executionNodeId: localNode, threadId },
    });
    render();
    await Promise.resolve();
    render();
    submitJarvisComposerCommand({ text: "Do it", inputMode: "text", captureId: "e1" });
    await question.promise;
    await state.drain?.();
    submitJarvisComposerCommand({ text: "low", inputMode: "text", captureId: "e2" });
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
    submitJarvisComposerCommand({ text: "Again", inputMode: "text", captureId: "e3" });
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
    onJarvisCommandFeedback((entry) => {
      if (entry.kind === "needs-input" && entry.text === "Which effort?") question.resolve();
      if (entry.kind === "done" && entry.text.includes("nothing was cancelled")) retired.resolve();
    });
    await ready();
    await selectProject({ nodeId: localNode, projectId: localProject }, "Local");
    submitJarvisComposerCommand({ text: "Do it", inputMode: "text", captureId: "g1" });
    await question.promise;
    await state.drain?.();
    submitJarvisComposerCommand({ text: "cancel", inputMode: "text", captureId: "g2" });
    await retired.promise;
    // The cancel went out with the exact frame id but the frame had moved
    // on: the local prompt retires without ever claiming a server cancel.
    expect(state.execute.mock.calls[1]?.[0]).toMatchObject({
      utterance: "cancel",
      clarificationFrameId: "frame-gone",
    });
    expect(feedback.some((entry) => entry.text.toLowerCase().includes("discard"))).toBe(false);
    expect(state.execute).toHaveBeenCalledTimes(2);
    expect(isJarvisCommandPending()).toBe(false);
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
    onJarvisCommandFeedback((entry) => {
      if (entry.kind === "needs-input" && entry.text === "Which effort?") firstQuestion.resolve();
      if (entry.kind === "needs-input" && entry.text === "Which effort, really?")
        secondQuestion.resolve();
    });
    await ready();
    requestJarvisTarget({
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
    submitJarvisComposerCommand({ text: "Do it", inputMode: "text", captureId: "h1" });
    await firstQuestion.promise;
    await state.drain?.();
    submitJarvisComposerCommand({ text: "allow", inputMode: "text", captureId: "h2" });
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
    submitJarvisComposerCommand({ text: "allow", inputMode: "text", captureId: "h3" });
    await finished.promise;
    expect(state.execute.mock.calls[2]?.[0]).toMatchObject({
      utterance: "allow",
      clarificationFrameId: "frame-A",
      expectedReply: { kind: "input", requestId: "req-A" },
    });
  });
});
