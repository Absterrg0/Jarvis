import { EnvironmentId, ProjectId, ThreadId, ProviderInstanceId } from "@t3tools/contracts";
import type { DependencyList, EffectCallback } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const state = vi.hoisted(() => ({
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
vi.mock("../../state/jarvisMesh", () => ({
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

const nodeId = EnvironmentId.make("local");
const projectId = ProjectId.make("project");
const threadId = ThreadId.make("task");
const catalog = { nodes: [], projects: [], providers: [] };

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {
    throw new Error("Deferred not initialized");
  };
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("Jarvis voice runtime", () => {
  let transcript: (
    text: string,
    event?: { captureId: string; purpose: "command" | "diagnostic" },
  ) => void;
  let events: string[];
  let routeNodeId: EnvironmentId;
  let finished: ReturnType<typeof deferred<void>>;
  const unsubscribe = vi.fn();
  const consume = vi.fn();
  const started = vi.fn();
  const speak = vi.fn();

  function render() {
    hooks.beginRender();
    expect(
      JarvisVoiceRuntime({
        routeTarget: { environmentId: routeNodeId, projectId, contextThreadId: threadId },
        onTargetConsumed: consume,
        onThreadStarted: started,
      }),
    ).toBeNull();
    for (const effect of state.effects.splice(0)) effect();
  }

  async function ready() {
    render();
    await state.refresh.mock.results[0]?.value;
    render();
    await Promise.resolve();
    render();
  }

  beforeEach(() => {
    hooks.reset();
    state.effects = [];
    state.cleanups = [];
    events = [];
    routeNodeId = nodeId;
    finished = deferred<void>();
    consume.mockReset();
    unsubscribe.mockReset();
    started.mockReset().mockImplementation(() => finished.resolve());
    speak.mockReset().mockImplementation(async (text: string) => {
      events.push(`speech:${text}`);
      return { status: "spoken" };
    });
    state.refresh.mockReset().mockResolvedValue({ _tag: "Success", value: catalog });
    state.refreshNode.mockReset().mockResolvedValue({ _tag: "Success", value: catalog });
    state.desk.mockReset();
    state.execute.mockReset().mockImplementation(async () => {
      events.push("execute");
      return {
        _tag: "Success",
        value: {
          status: "started",
          threadId,
          objective: "Fix the bug",
          acknowledgement: "Working on the bug.",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "sol" },
        },
      };
    });
    vi.stubGlobal("window", {
      desktopBridge: {
        jarvisVoice: {
          onTranscript: (listener: typeof transcript) => {
            transcript = listener;
            return unsubscribe;
          },
          setRecognitionContext: vi.fn(),
          playAcknowledgement: async () => {
            events.push("cue");
          },
          prepareSpeech: async () => {
            events.push("prepare");
          },
          speak,
        },
      },
    });
  });

  afterEach(() => {
    for (const cleanup of state.cleanups) cleanup();
    vi.unstubAllGlobals();
  });

  it.each(["local", "remote"])(
    "routes a queued capture to its explicit %s node, cues and speaks the result once",
    async (route) => {
      routeNodeId = EnvironmentId.make(route);
      const refresh = deferred<{ _tag: "Success"; value: typeof catalog }>();
      state.refresh.mockReturnValueOnce(refresh.promise);
      render();
      transcript("Fix the bug", { captureId: "capture", purpose: "command" });
      expect(state.execute).not.toHaveBeenCalled();
      refresh.resolve({ _tag: "Success", value: catalog });
      await refresh.promise;
      render();
      await Promise.resolve();
      render();
      await finished.promise;
      expect(events).toEqual(["cue", "prepare", "execute", "speech:Working on the bug."]);
      expect(state.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          projectRef: { nodeId: routeNodeId, projectId },
          contextThreadId: threadId,
          utterance: "Fix the bug",
          requestMetadata: expect.objectContaining({
            inputMode: "voice",
            sourceUtterance: "Fix the bug",
          }),
        }),
      );
      expect(started).toHaveBeenCalledWith(routeNodeId, threadId);
      expect(state.refreshNode).toHaveBeenCalledWith({ nodeId: routeNodeId });
      expect(state.refresh).toHaveBeenCalledTimes(1);
      transcript("Fix the bug", { captureId: "capture", purpose: "command" });
      expect(state.execute).toHaveBeenCalledTimes(1);
    },
  );

  it("does not route diagnostic or empty transcripts and releases its subscription", async () => {
    await ready();
    transcript("Fix the bug", { captureId: "diagnostic", purpose: "diagnostic" });
    transcript("um", { captureId: "noise", purpose: "command" });
    expect(state.execute).not.toHaveBeenCalled();
    expect(speak).toHaveBeenCalledWith("I couldn't hear you. Try that again.", "interaction");
    for (const cleanup of state.cleanups.splice(0)) cleanup();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("resumes a clarification through the same request and does not replay the original transcript", async () => {
    const question = deferred<void>();
    speak.mockImplementation(async (text: string) => {
      if (text === "Confirm this project?") question.resolve();
      return { status: "spoken" };
    });
    state.execute.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        status: "needs-input",
        reason: "control-target-required",
        prompt: "Confirm this project?",
        choices: ["yes", "no"],
      },
    });
    await ready();
    transcript("Fix the bug", { captureId: "capture", purpose: "command" });
    await question.promise;
    await state.drain?.();
    transcript("yes", { captureId: "reply", purpose: "command" });
    await finished.promise;
    const first = state.execute.mock.calls[0]?.[0];
    const second = state.execute.mock.calls[1]?.[0];
    expect(second).toMatchObject({
      utterance: "yes",
      requestMetadata: {
        requestId: first.requestMetadata.requestId,
        sourceUtterance: "Fix the bug",
      },
    });
    expect(consume).toHaveBeenCalledTimes(1);
  });
  it("preserves the original instruction and sends a typed provider/model answer", async () => {
    const modelCatalog = {
      ...catalog,
      providers: [
        {
          nodeId,
          snapshot: {
            instanceId: ProviderInstanceId.make("plain"),
            driver: "codex",
            displayName: "Plain",
            enabled: true,
            installed: true,
            version: null,
            status: "ready",
            auth: { status: "authenticated" },
            checkedAt: "2026-09-05T00:00:00.000Z",
            models: [
              { slug: "plain-model", name: "Plain Model", isCustom: false, capabilities: null },
            ],
            slashCommands: [],
            skills: [],
          },
        },
      ],
    };
    state.refresh.mockResolvedValue({ _tag: "Success", value: modelCatalog });
    state.refreshNode.mockResolvedValue({ _tag: "Success", value: modelCatalog });
    state.execute.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        status: "needs-input",
        reason: "provider-not-found",
        prompt: "Which provider?",
        choices: ["Plain"],
      },
    });
    await ready();
    transcript("Use missing to fix the bug", { captureId: "capture", purpose: "command" });
    await state.drain?.();
    transcript("Plain", { captureId: "answer", purpose: "command" });
    await finished.promise;
    expect(state.execute.mock.calls[1]?.[0]).toMatchObject({
      utterance: "Use missing to fix the bug",
      modelSelection: { instanceId: "plain", model: "plain-model" },
    });
  });
});
