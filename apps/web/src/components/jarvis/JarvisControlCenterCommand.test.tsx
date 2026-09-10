import type { JarvisMeshCatalog } from "@t3tools/jarvis-client-runtime/jarvis/mesh";
import { EnvironmentId, ProjectId, ThreadId, ProviderInstanceId } from "@t3tools/contracts";
import type { DependencyList, EffectCallback } from "react";
import * as Cause from "effect/Cause";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";
import type { ReactElement } from "react";

function mustFind(
  node: unknown,
  visitor: (element: ReactElement<Record<string, unknown>>) => boolean,
): ReactElement<Record<string, unknown>> {
  const found = visitElements(node, visitor);
  if (found === null) throw new Error("Missing expected console element");
  return found;
}
import {
  onJarvisCommandAction,
  onJarvisCommandFeedback,
  onJarvisTargetSnapshot,
  resetJarvisCommandBusForTests,
  type JarvisTargetSnapshot,
} from "../../jarvisBus";

const state = vi.hoisted(() => ({
  catalog: null as JarvisMeshCatalog | null,
  effects: [] as Array<() => void>,
  cleanups: [] as Array<() => void>,
  refresh: vi.fn(),
  refreshNode: vi.fn(),
  execute: vi.fn(),
  interpret: vi.fn(),
  converse: vi.fn(),
  desk: vi.fn(),
  cancelRequest: vi.fn(),
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
    interpret: "interpret",
    converse: "converse",
    getTaskDesk: "desk",
    cancelRequest: "cancelRequest",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (
    command:
      | "refresh"
      | "refreshNode"
      | "execute"
      | "interpret"
      | "converse"
      | "desk"
      | "cancelRequest",
  ) => state[command],
}));
vi.mock("../../jarvisIdentity", () => ({ jarvisReporterIdentity: () => "interaction" }));
vi.mock("../../env", () => ({ isElectron: false }));
import { JarvisVoiceRuntime } from "./JarvisVoiceRuntime";
import { JarvisCommandConsole } from "./JarvisControlCenter";

const localNode = EnvironmentId.make("local");
const localProject = ProjectId.make("local-project");
const threadId = ThreadId.make("task-1");

const catalog: JarvisMeshCatalog = {
  nodes: [{ nodeId: localNode, label: "Local", reachability: "online" }],
  projects: [
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
  ],
  providers: [],
};

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {
    throw new Error("Deferred not initialized");
  };
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("ControlCenter composer to runtime boundary", () => {
  let snapshots: Array<JarvisTargetSnapshot | null>;
  let finished: ReturnType<typeof deferred<void>>;
  const consume = vi.fn();
  const started = vi.fn();
  let consoleTree: unknown;

  function render() {
    hooks.beginRender();
    expect(
      JarvisVoiceRuntime({
        routeTarget: null,
        onTargetConsumed: consume,
        onThreadStarted: started,
      }),
    ).toBeNull();
    consoleTree = JarvisCommandConsole({ catalog });
    for (const effect of state.effects.splice(0)) effect();
  }

  beforeEach(async () => {
    hooks.reset();
    resetJarvisCommandBusForTests();
    state.effects = [];
    state.cleanups = [];
    state.drain = undefined;
    snapshots = [];
    finished = deferred<void>();
    consume.mockReset();
    started.mockReset().mockImplementation(() => finished.resolve());
    state.catalog = catalog;
    state.refresh.mockReset().mockResolvedValue({ _tag: "Success", value: catalog });
    state.refreshNode.mockReset().mockResolvedValue({ _tag: "Success", value: catalog });
    state.desk
      .mockReset()
      .mockResolvedValue({ _tag: "Success", value: { focusedTask: null, recentTasks: [] } });
    state.cancelRequest.mockReset().mockResolvedValue({
      _tag: "Success",
      value: { status: "unknown", requestId: "request-1" },
    });
    // Proposal-first runtime: interpret returns an ambient proposal by
    // default so console submissions execute without a second inference.
    state.interpret.mockReset().mockResolvedValue({
      _tag: "Success",
      value: { action: "start", refs: [], model: null, effort: null, answer: null },
    });
    state.converse.mockReset().mockResolvedValue({ _tag: "Failure", cause: "not under test" });
    state.execute.mockReset().mockImplementation(async () => ({
      _tag: "Success",
      value: {
        status: "started",
        threadId,
        objective: "Fix it",
        acknowledgement: "Working on it.",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "sol" },
        taskRef: { executionNodeId: localNode, threadId },
      },
    }));
    vi.stubGlobal("window", { desktopBridge: undefined });
  });

  afterEach(() => {
    for (const cleanup of state.cleanups) cleanup();
    vi.unstubAllGlobals();
    resetJarvisCommandBusForTests();
  });

  it("drives a console selection and draft through the runtime to execute", async () => {
    onJarvisTargetSnapshot((snapshot) => snapshots.push(snapshot));
    render();
    await state.refresh.mock.results[0]?.value;
    render();
    await Promise.resolve();
    render();

    const projectSelect = mustFind(
      consoleTree,
      (element) => element.props["aria-label"] === "ARIS project target",
    );
    (projectSelect.props.onChange as (event: unknown) => void)({
      target: { value: `${localNode}:${localProject}` },
    });
    render();
    await Promise.resolve();
    render();
    await state.drain?.();
    render();
    expect(snapshots.at(-1)?.projectRef).toEqual({
      nodeId: localNode,
      projectId: localProject,
    });

    const composer = mustFind(
      consoleTree,
      (element) => element.props["aria-label"] === "ARIS instruction",
    );
    (composer.props.onChange as (event: unknown) => void)({
      target: { value: "Fix it" },
    });
    render();

    const send = mustFind(consoleTree, (element) => element.props["children"] === "Send");
    (send.props.onClick as () => void)();
    await finished.promise;

    expect(state.execute).toHaveBeenCalledTimes(1);
    expect(state.execute.mock.calls[0]?.[0]).toMatchObject({
      projectRef: { nodeId: localNode, projectId: localProject },
      utterance: "Fix it",
    });
    expect(state.execute.mock.calls[0]?.[0].requestMetadata).not.toHaveProperty("inputMode");
  });

  it("answers a follow-up prompt from the real composer send", async () => {
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
    onJarvisCommandFeedback((entry) => {
      if (entry.kind === "needs-input" && entry.text === "Which effort?") question.resolve();
    });
    render();
    await state.refresh.mock.results[0]?.value;
    render();
    await Promise.resolve();
    render();

    const projectSelect = mustFind(
      consoleTree,
      (element) => element.props["aria-label"] === "ARIS project target",
    );
    (projectSelect.props.onChange as (event: unknown) => void)({
      target: { value: `${localNode}:${localProject}` },
    });
    render();
    await Promise.resolve();
    render();

    const composer = mustFind(
      consoleTree,
      (element) => element.props["aria-label"] === "ARIS instruction",
    );
    (composer.props.onChange as (event: unknown) => void)({
      target: { value: "Do it" },
    });
    render();
    const send = mustFind(consoleTree, (element) => element.props["children"] === "Send");
    (send.props.onClick as () => void)();
    await question.promise;
    await Promise.resolve();
    render();
    await Promise.resolve();
    render();

    // Waiting for an answer is not being busy: the composer stays sendable
    // while the project and task selectors stay locked on the prompt target.
    const lockedSelect = mustFind(
      consoleTree,
      (element) => element.props["aria-label"] === "ARIS project target",
    );
    expect(lockedSelect.props["disabled"]).toBe(true);

    const answered = deferred<void>();
    started.mockImplementationOnce(() => answered.resolve());
    const answerBox = mustFind(
      consoleTree,
      (element) => element.props["aria-label"] === "ARIS instruction",
    );
    (answerBox.props.onChange as (event: unknown) => void)({
      target: { value: "allow" },
    });
    render();
    const answerSend = mustFind(
      consoleTree,
      (element) => element.props["children"] === "Send answer",
    );
    expect(answerSend.props["disabled"]).toBe(false);
    (answerSend.props.onClick as () => void)();
    await answered.promise;

    expect(state.execute).toHaveBeenCalledTimes(2);
    expect(state.execute.mock.calls[1]?.[0]).toMatchObject({
      projectRef: { nodeId: localNode, projectId: localProject },
      utterance: "allow",
    });
  });

  it("keeps the console selectors visible but disabled while a command is pending", async () => {
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
    onJarvisCommandFeedback((entry) => {
      if (entry.kind === "needs-input") question.resolve();
    });
    render();
    await state.refresh.mock.results[0]?.value;
    render();
    await Promise.resolve();
    render();

    const projectSelect = mustFind(
      consoleTree,
      (element) => element.props["aria-label"] === "ARIS project target",
    );
    (projectSelect.props.onChange as (event: unknown) => void)({
      target: { value: `${localNode}:${localProject}` },
    });
    render();
    render();
    const composer = mustFind(
      consoleTree,
      (element) => element.props["aria-label"] === "ARIS instruction",
    );
    (composer.props.onChange as (event: unknown) => void)({
      target: { value: "Do it" },
    });
    render();
    const send = mustFind(consoleTree, (element) => element.props["children"] === "Send");
    (send.props.onClick as () => void)();
    await question.promise;
    render();
    const disabledSelect = mustFind(
      consoleTree,
      (element) => element.props["aria-label"] === "ARIS project target",
    );
    expect(disabledSelect.props["disabled"]).toBe(true);
  });

  it("carries a desk pending reply from the console task into the execute pin", async () => {
    const deskThread = ThreadId.make("desk-task-1");
    state.desk.mockResolvedValue({
      _tag: "Success",
      value: {
        focusedTask: null,
        recentTasks: [
          {
            threadId: deskThread,
            title: "Desk task",
            taskRef: { executionNodeId: localNode, threadId: deskThread },
            projectRef: { nodeId: localNode, projectId: localProject },
            pendingReply: { kind: "user-input", requestId: "desk-req-1" },
          },
        ],
      },
    });
    render();
    await state.refresh.mock.results[0]?.value;
    render();
    await Promise.resolve();
    render();
    await Promise.resolve();
    render();

    const projectSelect = mustFind(
      consoleTree,
      (element) => element.props["aria-label"] === "ARIS project target",
    );
    (projectSelect.props.onChange as (event: unknown) => void)({
      target: { value: `${localNode}:${localProject}` },
    });
    render();
    await Promise.resolve();
    render();
    await Promise.resolve();
    render();

    const taskSelect = mustFind(
      consoleTree,
      (element) => element.props["aria-label"] === "ARIS task target",
    );
    (taskSelect.props.onChange as (event: unknown) => void)({
      target: { value: deskThread },
    });
    render();
    await Promise.resolve();
    render();

    const composer = mustFind(
      consoleTree,
      (element) => element.props["aria-label"] === "ARIS instruction",
    );
    (composer.props.onChange as (event: unknown) => void)({
      target: { value: "Answer it" },
    });
    render();
    const send = mustFind(consoleTree, (element) => element.props["children"] === "Send");
    (send.props.onClick as () => void)();
    await finished.promise;

    expect(state.execute.mock.calls[0]?.[0]).toMatchObject({
      projectRef: { nodeId: localNode, projectId: localProject },
      contextThreadId: deskThread,
      utterance: "Answer it",
      expectedReply: { kind: "input", requestId: "desk-req-1" },
    });
  });

  it("clears a failed pending approval from the real Cancel button without dispatching raw cancel", async () => {
    const deskThread = ThreadId.make("cancel-task");
    const actions: Array<{ type: "cancel" | "retry"; inputMode: "text" | "voice" }> = [];
    onJarvisCommandAction((action) => actions.push(action));
    state.desk.mockResolvedValue({
      _tag: "Success",
      value: {
        focusedTask: null,
        recentTasks: [
          {
            threadId: deskThread,
            title: "Approval task",
            taskRef: { executionNodeId: localNode, threadId: deskThread },
            projectRef: { nodeId: localNode, projectId: localProject },
            pendingReply: { kind: "approval", requestId: "approval-cancel" },
          },
        ],
      },
    });
    state.execute.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(new Error("transport failed")),
    });
    const failed = deferred<void>();
    const cancelled = deferred<void>();
    onJarvisCommandFeedback((entry) => {
      if (entry.kind === "error") failed.resolve();
      if (entry.kind === "done") cancelled.resolve();
    });

    render();
    await state.refresh.mock.results[0]?.value;
    render();
    await Promise.resolve();
    render();
    const projectSelect = mustFind(
      consoleTree,
      (element) => element.props["aria-label"] === "ARIS project target",
    );
    (projectSelect.props.onChange as (event: unknown) => void)({
      target: { value: `${localNode}:${localProject}` },
    });
    render();
    await Promise.resolve();
    render();
    await state.drain?.();
    render();
    const taskSelect = mustFind(
      consoleTree,
      (element) => element.props["aria-label"] === "ARIS task target",
    );
    (taskSelect.props.onChange as (event: unknown) => void)({
      target: { value: deskThread },
    });
    render();
    await Promise.resolve();
    render();
    const composer = mustFind(
      consoleTree,
      (element) => element.props["aria-label"] === "ARIS instruction",
    );
    (composer.props.onChange as (event: unknown) => void)({ target: { value: "allow" } });
    render();
    const send = mustFind(consoleTree, (element) => element.props["children"] === "Send");
    (send.props.onClick as () => void)();
    await failed.promise;
    await state.drain?.();
    render();

    const cancel = mustFind(consoleTree, (element) => element.props["children"] === "Cancel");
    (cancel.props.onClick as () => void)();
    await cancelled.promise;
    render();

    expect(state.execute).toHaveBeenCalledTimes(1);
    expect(state.execute.mock.calls[0]?.[0].utterance).toBe("allow");
    expect(actions).toEqual([{ type: "cancel", inputMode: "text" }]);
    expect(
      mustFind(consoleTree, (element) => element.props["aria-label"] === "ARIS project target")
        .props["disabled"],
    ).toBe(false);
    expect(
      mustFind(consoleTree, (element) => element.props["aria-label"] === "ARIS task target").props[
        "disabled"
      ],
    ).toBe(false);
  });

  it("retries a failed direct approval from the real Retry button with its original request pin", async () => {
    const deskThread = ThreadId.make("retry-task");
    const actions: Array<{ type: "cancel" | "retry"; inputMode: "text" | "voice" }> = [];
    onJarvisCommandAction((action) => actions.push(action));
    const desk = (requestId: string) => ({
      _tag: "Success" as const,
      value: {
        focusedTask: null,
        recentTasks: [
          {
            threadId: deskThread,
            title: "Approval task",
            taskRef: { executionNodeId: localNode, threadId: deskThread },
            projectRef: { nodeId: localNode, projectId: localProject },
            pendingReply: { kind: "approval" as const, requestId },
          },
        ],
      },
    });
    state.desk.mockResolvedValue(desk("approval-A"));
    state.execute.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(new Error("transport failed")),
    });
    const failed = deferred<void>();
    onJarvisCommandFeedback((entry) => {
      if (entry.kind === "error") failed.resolve();
    });

    render();
    await state.refresh.mock.results[0]?.value;
    render();
    await Promise.resolve();
    render();
    const projectSelect = mustFind(
      consoleTree,
      (element) => element.props["aria-label"] === "ARIS project target",
    );
    (projectSelect.props.onChange as (event: unknown) => void)({
      target: { value: `${localNode}:${localProject}` },
    });
    render();
    await Promise.resolve();
    render();
    await state.drain?.();
    render();
    const taskSelect = mustFind(
      consoleTree,
      (element) => element.props["aria-label"] === "ARIS task target",
    );
    (taskSelect.props.onChange as (event: unknown) => void)({ target: { value: deskThread } });
    render();
    await Promise.resolve();
    render();
    const composer = mustFind(
      consoleTree,
      (element) => element.props["aria-label"] === "ARIS instruction",
    );
    (composer.props.onChange as (event: unknown) => void)({ target: { value: "allow" } });
    render();
    (
      mustFind(consoleTree, (element) => element.props["children"] === "Send").props
        .onClick as () => void
    )();
    await failed.promise;
    await state.drain?.();
    render();

    state.desk.mockResolvedValue(desk("approval-B"));
    const retryExecution = deferred<unknown>();
    const retryStarted = deferred<void>();
    state.execute.mockImplementationOnce(() => {
      retryStarted.resolve();
      return retryExecution.promise;
    });
    (
      mustFind(consoleTree, (element) => element.props["children"] === "Retry").props
        .onClick as () => void
    )();
    await retryStarted.promise;

    expect(state.execute).toHaveBeenCalledTimes(2);
    expect(actions).toEqual([{ type: "retry", inputMode: "text" }]);
    expect(state.execute.mock.calls[1]?.[0].requestMetadata.requestId).toBe(
      state.execute.mock.calls[0]?.[0].requestMetadata.requestId,
    );
    expect(state.execute.mock.calls[1]?.[0].expectedReply).toEqual({
      kind: "approval",
      requestId: "approval-A",
    });
    retryExecution.resolve({
      _tag: "Success",
      value: {
        status: "started",
        threadId,
        objective: "Allow",
        acknowledgement: "Working on it.",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "sol" },
        taskRef: { executionNodeId: localNode, threadId },
      },
    });
  });
});
