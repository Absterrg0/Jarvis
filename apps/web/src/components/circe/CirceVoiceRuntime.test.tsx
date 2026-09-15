import type { CirceMeshCatalog } from "@circe/client-runtime/circe/mesh";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  ProviderDriverKind,
} from "@t3tools/contracts";
import type { DependencyList, EffectCallback } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const state = vi.hoisted(() => ({
  catalog: null as CirceMeshCatalog | null,
  effects: [] as Array<() => void>,
  cleanups: [] as Array<() => void>,
  refresh: vi.fn(),
  refreshNode: vi.fn(),
  execute: vi.fn(),
  desk: vi.fn(),
  cancelRequest: vi.fn(),
  interpret: vi.fn(),
  converse: vi.fn(),
  quickLookup: vi.fn(),
  openWebsite: vi.fn(),
  drain: undefined as (() => Promise<void>) | undefined,
  speechEvents: [] as string[],
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
      return queue;
    },
  };
});
vi.mock("../../state/environments", () => ({ usePrimaryEnvironmentId: () => "local" }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.catalog }));
vi.mock("../../state/circeLiveVoice", () => ({
  circeLiveVoiceEnvironment: { lookup: "quickLookup" },
}));
vi.mock("./CirceQuickActions.logic", () => ({
  openCirceWebsite: (url: string, sourceUtterance: string) =>
    state.openWebsite(url, sourceUtterance),
}));
vi.mock("../../state/circeMesh", () => ({
  circeMeshCatalogAtom: "catalog",
  circeMeshEnvironment: {
    refresh: "refresh",
    refreshNode: "refreshNode",
    execute: "execute",
    getTaskDesk: "desk",
    cancelRequest: "cancelRequest",
    interpret: "interpret",
    converse: "converse",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (
    command:
      | "refresh"
      | "refreshNode"
      | "execute"
      | "desk"
      | "cancelRequest"
      | "interpret"
      | "converse"
      | "quickLookup",
  ) => state[command],
}));
vi.mock("../../circeIdentity", () => ({ circeReporterIdentity: () => "interaction" }));
vi.mock("./CirceVoiceReporter.logic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./CirceVoiceReporter.logic")>();
  return {
    ...actual,
    enqueueBrowserSpeech: async (text: string) => {
      state.speechEvents.push(`speech:${text}`);
      return { status: "played" as const };
    },
    cancelBrowserSpeech: () => undefined,
  };
});
import {
  onCirceCommandFeedback,
  requestCirceCommandAction,
  resetCirceCommandBusForTests,
  submitCirceComposerCommand,
  type CirceCommandFeedback,
} from "../../circeBus";
import { resetCirceSpeechRelevanceForTests } from "./CirceVoiceReporter.logic";
import { CirceVoiceRuntime } from "./CirceVoiceRuntime";

const nodeId = EnvironmentId.make("local");
const projectId = ProjectId.make("project");
const threadId = ThreadId.make("task");
const catalog: CirceMeshCatalog = {
  nodes: [{ nodeId, label: "Local", reachability: "online" }],
  projects: [],
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

describe("Circe voice runtime", () => {
  let transcript: (
    text: string,
    event?: { captureId: string; purpose: "command" | "diagnostic" },
  ) => void;
  let events: string[];
  let routeNodeId: EnvironmentId;
  let routeThreadId: ThreadId | undefined;
  let finished: ReturnType<typeof deferred<void>>;
  const consume = vi.fn();
  const started = vi.fn();

  function render() {
    hooks.beginRender();
    expect(
      CirceVoiceRuntime({
        routeTarget: {
          environmentId: routeNodeId,
          projectId,
          ...(routeThreadId === undefined ? {} : { contextThreadId: routeThreadId }),
        },
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

  async function drainUntilDispatched() {
    for (let turn = 0; turn < 50 && state.execute.mock.calls.length === 0; turn += 1) {
      await Promise.resolve();
      render();
    }
  }

  beforeEach(() => {
    hooks.reset();
    state.effects = [];
    state.cleanups = [];
    events = [];
    state.speechEvents = events;
    routeNodeId = nodeId;
    routeThreadId = threadId;
    finished = deferred<void>();
    consume.mockReset();
    started.mockReset().mockImplementation(() => finished.resolve());
    // Live delegations and typed turns share one submission queue. Drive
    // voice turns through the composer bus with voice input mode.
    // Diagnostic captures never submit.
    transcript = (text, event) => {
      if (event?.purpose === "diagnostic") return;
      submitCirceComposerCommand({
        text,
        inputMode: "voice",
        captureId: event?.captureId ?? `capture-${events.length}`,
        sourceTranscript: text,
      });
    };
    state.catalog = catalog;
    state.quickLookup.mockReset();
    state.openWebsite.mockReset();
    state.refresh.mockReset().mockResolvedValue({ _tag: "Success", value: catalog });
    state.refreshNode.mockReset().mockResolvedValue({ _tag: "Success", value: catalog });
    state.desk
      .mockReset()
      .mockResolvedValue({ _tag: "Success", value: { focusedTask: null, recentTasks: [] } });
    // The semantic interpret lane is integration-owned; fail it closed here
    // so submissions keep the direct execute path these speech tests cover.
    state.interpret.mockReset().mockResolvedValue({ _tag: "Failure", cause: "not under test" });
    state.converse.mockReset().mockResolvedValue({ _tag: "Failure", cause: "not under test" });
    state.cancelRequest
      .mockReset()
      .mockImplementation(async (input: { input: { requestId: string } }) => ({
        _tag: "Success" as const,
        value: { status: "cancelled" as const, requestId: input.input.requestId },
      }));
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
    resetCirceCommandBusForTests();
    resetCirceSpeechRelevanceForTests();
  });

  afterEach(() => {
    for (const cleanup of state.cleanups) cleanup();
  });

  it("answers a supervisor-proposed weather lookup without creating a task", async () => {
    await ready();
    state.interpret.mockResolvedValue({
      _tag: "Success",
      value: {
        action: "lookup",
        refs: [],
        model: null,
        effort: null,
        answer: null,
        lookup: { kind: "weather", location: "Ahmedabad", day: "now" },
      },
    });
    state.quickLookup.mockResolvedValue({
      _tag: "Success",
      value: { status: "answer", message: "Ahmedabad: 31°C.", source: "https://open-meteo.com/" },
    });
    transcript("What's the weather in Ahmedabad?", { captureId: "weather", purpose: "command" });
    await state.drain?.();
    expect(state.quickLookup).toHaveBeenCalledWith({
      environmentId: "local",
      input: {
        kind: "weather",
        location: "Ahmedabad",
        day: "now",
        sourceUtterance: "What's the weather in Ahmedabad?",
      },
    });
    expect(state.execute).not.toHaveBeenCalled();
    expect(events.some((event) => event.includes("31°C"))).toBe(true);
  });

  it("opens a supervisor-proposed website on this device even with a remote task selected", async () => {
    routeNodeId = EnvironmentId.make("remote");
    await ready();
    state.interpret.mockResolvedValue({
      _tag: "Success",
      value: {
        action: "open-website",
        refs: [],
        model: null,
        effort: null,
        answer: null,
        website: "YouTube",
      },
    });
    state.openWebsite.mockResolvedValue(true);
    transcript("Open YouTube", { captureId: "website", purpose: "command" });
    await state.drain?.();
    expect(state.openWebsite).toHaveBeenCalledWith("YouTube", "Open YouTube");
    expect(state.execute).not.toHaveBeenCalled();
  });

  it.each(["local", "remote"])(
    "routes a queued capture to its explicit %s node and speaks the result once",
    async (route) => {
      routeNodeId = EnvironmentId.make(route);
      const refresh = deferred<{ _tag: "Success"; value: typeof catalog }>();
      state.catalog = null;
      state.refresh.mockReturnValueOnce(refresh.promise);
      render();
      transcript("Fix the bug", { captureId: "capture", purpose: "command" });
      expect(state.execute).not.toHaveBeenCalled();
      state.catalog = catalog;
      refresh.resolve({ _tag: "Success", value: catalog });
      await refresh.promise;
      render();
      await Promise.resolve();
      render();
      await finished.promise;
      expect(events).toEqual(["execute", "speech:Working on the bug."]);
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

  it("uses a healthy catalog update before a slow peer finishes refreshing", async () => {
    const refresh = deferred<{ _tag: "Success"; value: typeof catalog }>();
    state.catalog = null;
    state.refresh.mockReturnValueOnce(refresh.promise);
    render();
    transcript("Fix the bug", { captureId: "incremental", purpose: "command" });
    expect(state.execute).not.toHaveBeenCalled();
    state.catalog = {
      ...catalog,
      nodes: [
        ...catalog.nodes,
        {
          nodeId: EnvironmentId.make("slow"),
          label: "Slow",
          reachability: "online",
          catalogPending: true,
        },
      ],
    };
    render();
    await finished.promise;
    expect(state.execute).toHaveBeenCalledTimes(1);
    refresh.resolve({ _tag: "Success", value: catalog });
    await refresh.promise;
  });

  it("does not route diagnostic captures", async () => {
    await ready();
    const calls = state.execute.mock.calls.length;
    transcript("Fix the bug", { captureId: "diagnostic", purpose: "diagnostic" });
    await Promise.resolve();
    render();
    await Promise.resolve();
    expect(state.execute).toHaveBeenCalledTimes(calls);
  });

  it("resumes a clarification through the same request and does not replay the original transcript", async () => {
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
    await state.drain?.();
    await vi.waitFor(() =>
      expect(events.some((entry) => entry === "speech:Confirm this project?")).toBe(true),
    );
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

  it("answers a server frame with its exact id and no second supervisor call", async () => {
    state.execute.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        status: "needs-input",
        reason: "control-target-required",
        prompt: "Which project did you mean? Say its name, its number, or say cancel.",
        choices: ["Rivvl", "Beacon"],
        clarificationFrameId: "frame-1",
      },
    });
    await ready();
    transcript("Fix the bug", { captureId: "capture", purpose: "command" });
    await state.drain?.();
    await vi.waitFor(() =>
      expect(
        events.some(
          (entry) =>
            entry === "speech:Which project did you mean? Say its name, its number, or say cancel.",
        ),
      ).toBe(true),
    );
    // The first turn may consult the supervisor; the frame answer must not.
    state.interpret.mockClear();
    transcript("Rivvl", { captureId: "reply", purpose: "command" });
    await finished.promise;
    expect(state.interpret).not.toHaveBeenCalled();
    expect(state.execute).toHaveBeenCalledTimes(2);
    expect(state.execute.mock.calls[1]?.[0]).toMatchObject({
      utterance: "Rivvl",
      clarificationFrameId: "frame-1",
    });
  });
  it("applies a plan's focus and start outcomes instead of returning early", async () => {
    const focusedProject = ProjectId.make("focused-project");
    const startedThread = ThreadId.make("plan-task");
    state.desk.mockResolvedValue({
      _tag: "Success",
      value: {
        focusedTask: null,
        recentTasks: [
          {
            threadId: startedThread,
            title: "Release notes",
            taskRef: { executionNodeId: nodeId, threadId: startedThread },
            pendingReply: null,
          },
        ],
      },
    });
    state.execute.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        status: "plan",
        message: "Switched to Beacon. Started the task.",
        steps: [
          {
            action: "focused",
            status: "acknowledged",
            message: "Switched to Beacon.",
            projectId: focusedProject,
          },
          {
            action: "start",
            status: "started",
            message: "Started the task.",
            threadId: startedThread,
            projectId: focusedProject,
            taskRef: { executionNodeId: nodeId, threadId: startedThread },
          },
        ],
      },
    });
    await ready();
    transcript("switch to Beacon, then start the task", {
      captureId: "capture",
      purpose: "command",
    });
    await state.drain?.();
    await vi.waitFor(() =>
      expect(events.some((entry) => entry === "speech:Switched to Beacon. Started the task.")).toBe(
        true,
      ),
    );
    // The focused step moved the selection; the started step pinned its task
    // and subscribed reports. Without the plan handler both were skipped.
    expect(hooks.values()).toContainEqual({ nodeId, projectId: focusedProject });
    expect(started).toHaveBeenCalledWith(nodeId, startedThread);
    expect(consume).toHaveBeenCalled();
  });
  it("completes a plan even when thread navigation rejects", async () => {
    const startedThread = ThreadId.make("plan-task");
    started.mockRejectedValueOnce(new Error("navigation failed"));
    state.execute.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        status: "plan",
        message: "Started the task.",
        steps: [
          {
            action: "start",
            status: "started",
            message: "Started the task.",
            threadId: startedThread,
            projectId,
            taskRef: { executionNodeId: nodeId, threadId: startedThread },
          },
        ],
      },
    });
    await ready();
    transcript("start the task", { captureId: "capture", purpose: "command" });
    await state.drain?.();
    // A rejected subscription must not swallow the plan's terminal feedback.
    await vi.waitFor(() =>
      expect(events.some((entry) => entry === "speech:Started the task.")).toBe(true),
    );
    expect(started).toHaveBeenCalledWith(nodeId, startedThread);
    expect(consume).toHaveBeenCalled();
  });
  it("preserves the original instruction and sends a typed provider/model answer", async () => {
    const modelCatalog: CirceMeshCatalog = {
      ...catalog,
      providers: [
        {
          nodeId,
          nodeLabel: "Local",
          available: true,
          snapshot: {
            instanceId: ProviderInstanceId.make("plain"),
            driver: ProviderDriverKind.make("codex"),
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
    state.catalog = modelCatalog;
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

  it("emits an immediate transcript receipt and ignores a duplicate capture", async () => {
    resetCirceCommandBusForTests();
    const seen: CirceCommandFeedback[] = [];
    onCirceCommandFeedback((entry) => {
      seen.push(entry);
    });
    try {
      await ready();
      seen.length = 0;
      transcript("Fix the bug", { captureId: "receipt", purpose: "command" });
      expect(seen.map((entry) => entry.kind)).toEqual(["working"]);
      expect(seen[0]?.text).toBe('Heard: "Fix the bug"');
      expect(seen[0]?.captureId).toBe("receipt");
      await finished.promise;
      expect(
        seen.some((entry) => entry.kind === "working" && entry.text.includes("checking")),
      ).toBe(true);
      const calls = state.execute.mock.calls.length;
      transcript("Fix the bug", { captureId: "receipt", purpose: "command" });
      await Promise.resolve();
      expect(state.execute).toHaveBeenCalledTimes(calls);
    } finally {
      resetCirceCommandBusForTests();
    }
  });

  it("cancels the in-flight request by its exact identity and runs the correction next", async () => {
    resetCirceCommandBusForTests();
    const seen: CirceCommandFeedback[] = [];
    onCirceCommandFeedback((entry) => {
      seen.push(entry);
    });
    try {
      await ready();
      const executeGate = deferred<unknown>();
      state.execute.mockImplementationOnce(() => executeGate.promise);
      seen.length = 0;
      transcript("Fix the login bug", { captureId: "cancel-me", purpose: "command" });
      await drainUntilDispatched();
      const dispatched = state.execute.mock.calls[0]?.[0] as
        | { requestMetadata?: { requestId?: string; origin?: object } }
        | undefined;
      const requestId = dispatched?.requestMetadata?.requestId;
      expect(typeof requestId).toBe("string");
      const cancelSeen = deferred<{ nodeId: unknown; input: unknown }>();
      state.cancelRequest.mockImplementationOnce(async (input) => {
        cancelSeen.resolve(input as { nodeId: unknown; input: unknown });
        return {
          _tag: "Success" as const,
          value: { status: "cancelled" as const, requestId: requestId as string },
        };
      });
      const cancelledNotice = deferred<void>();
      const stopListening = onCirceCommandFeedback((entry) => {
        if (entry.kind === "done" && entry.text.includes("Cancelled before")) {
          cancelledNotice.resolve();
        }
      });
      requestCirceCommandAction({ type: "cancel", inputMode: "voice" });
      const cancelInput = await cancelSeen.promise;
      expect(cancelInput).toEqual({
        nodeId: routeNodeId,
        input: {
          requestId,
          ...(dispatched?.requestMetadata?.origin === undefined
            ? {}
            : { origin: dispatched.requestMetadata.origin }),
        },
      });
      executeGate.resolve({
        _tag: "Success",
        value: { status: "cancelled", requestId },
      });
      await cancelledNotice.promise;
      stopListening();
      expect(seen.at(-1)?.text).toBe("Cancelled before anything was dispatched.");
      // The obsolete cancellation never speaks over the queued correction.
      expect(events.some((entry) => entry.includes("Cancelled before"))).toBe(false);
      // The correction dispatches with a fresh identity after the cancel.
      transcript("Fix the logout bug", { captureId: "correction", purpose: "command" });
      for (let turn = 0; turn < 50 && state.execute.mock.calls.length < 2; turn += 1) {
        await Promise.resolve();
        render();
      }
      await finished.promise;
      expect(state.execute).toHaveBeenCalledTimes(2);
      const second = state.execute.mock.calls[1]?.[0] as { utterance?: string };
      expect(second?.utterance).toBe("Fix the logout bug");
    } finally {
      resetCirceCommandBusForTests();
    }
  });

  it("keeps waiting when the server already accepted the request", async () => {
    resetCirceCommandBusForTests();
    const seen: CirceCommandFeedback[] = [];
    onCirceCommandFeedback((entry) => {
      seen.push(entry);
    });
    try {
      await ready();
      const executeGate = deferred<unknown>();
      state.execute.mockImplementationOnce(() => executeGate.promise);
      transcript("Fix the login bug", { captureId: "accepted", purpose: "command" });
      await drainUntilDispatched();
      const dispatched = state.execute.mock.calls[0]?.[0] as
        | { requestMetadata?: { requestId?: string } }
        | undefined;
      const requestId = dispatched?.requestMetadata?.requestId as string;
      state.cancelRequest.mockImplementationOnce(async () => ({
        _tag: "Success" as const,
        value: {
          status: "already-accepted" as const,
          requestId,
          threadId,
        },
      }));
      const watchingNotice = deferred<void>();
      const stopListening = onCirceCommandFeedback((entry) => {
        if (entry.text.includes("already accepted")) watchingNotice.resolve();
      });
      requestCirceCommandAction({ type: "cancel", inputMode: "voice" });
      await watchingNotice.promise;
      stopListening();
      expect(state.cancelRequest).toHaveBeenCalledTimes(1);
      executeGate.resolve({
        _tag: "Success",
        value: {
          status: "started",
          threadId,
          objective: "Fix the login bug",
          acknowledgement: "Working on the login bug.",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "sol" },
        },
      });
      await finished.promise;
      expect(seen.at(-1)?.text).toBe("Working on the login bug.");
      expect(started).toHaveBeenCalledWith(routeNodeId, threadId);
    } finally {
      resetCirceCommandBusForTests();
    }
  });

  describe("mesh execute grounding", () => {
    const laptopNode = EnvironmentId.make("ground-laptop");
    const desktopNode = EnvironmentId.make("ground-desktop");
    const offlineNode = EnvironmentId.make("ground-vps");
    const rivvlLaptop = ProjectId.make("rivvl-laptop");
    const circeDesktop = ProjectId.make("circe-desktop");
    const zivilVps = ProjectId.make("zivil-vps");

    // Independently correct semantic evidence: spans reproduce the verbatim
    // source exactly, and only destination/correction roles route. Subject
    // mentions stay ambient. Each mock is built from the source string here
    // so a wrong role is a visible containment failure, never a silent
    // routing adjustment.
    function destinationProposal(source: string, wrapper: string, value: string) {
      const start = source.indexOf(wrapper);
      return {
        action: "start" as const,
        refs: [
          {
            span: { start, end: start + wrapper.length, text: wrapper },
            role: "destination" as const,
            value,
          },
        ],
        model: null,
        effort: null,
        answer: null,
      };
    }
    function subjectProposal(source: string, mention: string) {
      const start = source.indexOf(mention);
      return {
        action: "start" as const,
        refs: [
          {
            span: { start, end: start + mention.length, text: mention },
            role: "subject" as const,
            value: mention,
          },
        ],
        model: null,
        effort: null,
        answer: null,
      };
    }
    function mockInterpretSuccess(proposal: unknown) {
      state.interpret.mockReset().mockResolvedValue({ _tag: "Success", value: proposal });
    }

    function meshCatalog(
      rivvlOnDesktop: boolean,
      vpsReachable: boolean,
      includeStaleVpsProject: boolean,
    ): CirceMeshCatalog {
      return {
        nodes: [
          { nodeId: laptopNode, label: "Laptop", reachability: "online" },
          { nodeId: desktopNode, label: "Desktop", reachability: "online" },
          { nodeId: offlineNode, label: "VPS", reachability: vpsReachable ? "online" : "offline" },
        ],
        projects: [
          {
            projectId: rivvlLaptop,
            title: "Rivvl",
            workspaceRoot: "/work/rivvl",
            repositoryNames: ["rivvl"],
            aliases: [],
            aliasDetails: [],
            nodeId: laptopNode,
            ref: { nodeId: laptopNode, projectId: rivvlLaptop },
            nodeLabel: "Laptop",
          },
          ...(rivvlOnDesktop
            ? [
                {
                  projectId: ProjectId.make("rivvl-desktop"),
                  title: "Rivvl",
                  workspaceRoot: "/work/rivvl",
                  repositoryNames: ["rivvl"],
                  aliases: [],
                  aliasDetails: [],
                  nodeId: desktopNode,
                  ref: { nodeId: desktopNode, projectId: ProjectId.make("rivvl-desktop") },
                  nodeLabel: "Desktop",
                },
              ]
            : []),
          {
            projectId: circeDesktop,
            title: "Circe",
            workspaceRoot: "/work/circe",
            repositoryNames: ["circe"],
            aliases: [],
            aliasDetails: [],
            nodeId: desktopNode,
            ref: { nodeId: desktopNode, projectId: circeDesktop },
            nodeLabel: "Desktop",
          },
          ...(includeStaleVpsProject
            ? [
                {
                  projectId: zivilVps,
                  title: "Zivil",
                  workspaceRoot: "/work/zivil",
                  repositoryNames: ["zivil"],
                  aliases: [],
                  aliasDetails: [],
                  nodeId: offlineNode,
                  ref: { nodeId: offlineNode, projectId: zivilVps },
                  nodeLabel: "VPS",
                },
              ]
            : []),
        ],
        providers: [],
      };
    }

    async function readyOnMesh(options: {
      readonly twoRivvls: boolean;
      readonly vpsReachable?: boolean;
      readonly staleVpsProject?: boolean;
    }) {
      // A disconnected node normally contributes no projects; stale entries
      // linger only between disconnect and the next catalog refresh.
      const vpsReachable = options.vpsReachable ?? true;
      const mesh = meshCatalog(
        options.twoRivvls,
        vpsReachable,
        options.staleVpsProject ?? vpsReachable,
      );
      state.catalog = mesh;
      state.refresh.mockResolvedValue({ _tag: "Success", value: mesh });
      state.refreshNode.mockResolvedValue({ _tag: "Success", value: mesh });
      routeNodeId = desktopNode;
      routeThreadId = undefined;
      await ready();
      render();
    }

    it("routes an explicit cross-node destination to its owning node", async () => {
      resetCirceCommandBusForTests();
      const seen: CirceCommandFeedback[] = [];
      onCirceCommandFeedback((entry) => {
        seen.push(entry);
      });
      try {
        await readyOnMesh({ twoRivvls: false });
        const source = "Check PRs in Rivvl";
        // Correct evidence: destination role citing "in Rivvl" verbatim.
        mockInterpretSuccess(destinationProposal(source, "in Rivvl", "Rivvl"));
        transcript(source, { captureId: "route", purpose: "command" });
        for (let turn = 0; turn < 50 && state.execute.mock.calls.length === 0; turn += 1) {
          await Promise.resolve();
          render();
        }
        await finished.promise;
        expect(state.execute).toHaveBeenCalledTimes(1);
        expect(state.execute.mock.calls[0]?.[0]).toMatchObject({
          projectRef: { nodeId: laptopNode, projectId: rivvlLaptop },
          utterance: "Check PRs in Rivvl",
        });
        // Deterministic fast path: the bounded grammar already owns this
        // explicit wrapper, so no supervisor call happens at all.
        expect(state.interpret).not.toHaveBeenCalled();
        expect(state.refreshNode).toHaveBeenCalledWith({ nodeId: laptopNode });
        expect(started).toHaveBeenCalledWith(laptopNode, threadId);
        // The execution carries the nonauthoritative proposal with verbatim
        // source; the execution node validates without a second inference.
        expect(state.execute.mock.calls[0]?.[0]).toMatchObject({
          semanticProposal: expect.objectContaining({ action: "start" }),
          sourceUtterance: source,
        });
      } finally {
        resetCirceCommandBusForTests();
      }
    });

    it("routes an explicit destination from a typed composer entry the same way", async () => {
      resetCirceCommandBusForTests();
      try {
        await readyOnMesh({ twoRivvls: false });
        const source = "Check PRs in Rivvl";
        mockInterpretSuccess(destinationProposal(source, "in Rivvl", "Rivvl"));
        submitCirceComposerCommand({
          text: source,
          inputMode: "text",
          captureId: "route-text",
        });
        for (let turn = 0; turn < 50 && state.execute.mock.calls.length === 0; turn += 1) {
          await Promise.resolve();
          render();
        }
        await finished.promise;
        expect(state.execute).toHaveBeenCalledTimes(1);
        expect(state.execute.mock.calls[0]?.[0]).toMatchObject({
          projectRef: { nodeId: laptopNode, projectId: rivvlLaptop },
          utterance: "Check PRs in Rivvl",
        });
        expect(state.execute.mock.calls[0]?.[0].requestMetadata).not.toHaveProperty("inputMode");
        expect(state.interpret).not.toHaveBeenCalled();
      } finally {
        resetCirceCommandBusForTests();
      }
    });

    it("asks with node-qualified candidates instead of guessing across nodes", async () => {
      resetCirceCommandBusForTests();
      const seen: CirceCommandFeedback[] = [];
      onCirceCommandFeedback((entry) => {
        seen.push(entry);
      });
      try {
        await readyOnMesh({ twoRivvls: true });
        const source = "Check PRs in Rivvl";
        mockInterpretSuccess(destinationProposal(source, "in Rivvl", "Rivvl"));
        transcript(source, { captureId: "ambiguous", purpose: "command" });
        await state.drain?.();
        render();
        expect(state.execute).not.toHaveBeenCalled();
        const asked = seen.find((entry) => entry.kind === "needs-input");
        expect(asked?.text).toContain("more than one device");
        transcript("Rivvl — Laptop", { captureId: "answer", purpose: "command" });
        await finished.promise;
        expect(state.execute).toHaveBeenCalledTimes(1);
        expect(state.execute.mock.calls[0]?.[0]).toMatchObject({
          projectRef: { nodeId: laptopNode, projectId: rivvlLaptop },
          utterance: "Check PRs in Rivvl",
        });
        // The deterministic proposal is retained: the answer reuses the
        // original instruction with no second dispatch decision.
        expect(state.interpret).not.toHaveBeenCalled();
      } finally {
        resetCirceCommandBusForTests();
      }
    });

    it("reports the disconnected node without dispatching or falling back", async () => {
      resetCirceCommandBusForTests();
      const seen: CirceCommandFeedback[] = [];
      onCirceCommandFeedback((entry) => {
        seen.push(entry);
      });
      try {
        await readyOnMesh({ twoRivvls: false, vpsReachable: false, staleVpsProject: true });
        const source = "Check PRs in Zivil";
        mockInterpretSuccess(destinationProposal(source, "in Zivil", "Zivil"));
        transcript(source, { captureId: "offline", purpose: "command" });
        await state.drain?.();
        render();
        expect(state.execute).not.toHaveBeenCalled();
        expect(seen.at(-1)).toMatchObject({
          kind: "error",
          text: "Zivil is on VPS, which is disconnected. Reconnect it and try again.",
        });
      } finally {
        resetCirceCommandBusForTests();
      }
    });

    it("never swaps a qualified pinned followup to a mentioned project", async () => {
      resetCirceCommandBusForTests();
      try {
        await readyOnMesh({ twoRivvls: false });
        routeThreadId = threadId;
        render();
        const source = "Check PRs in Rivvl";
        // Even a destination-role proposal keeps the pinned task: pins stay
        // on the owner node, never swapping mid-task.
        mockInterpretSuccess(destinationProposal(source, "in Rivvl", "Rivvl"));
        transcript(source, { captureId: "pinned", purpose: "command" });
        for (let turn = 0; turn < 50 && state.execute.mock.calls.length === 0; turn += 1) {
          await Promise.resolve();
          render();
        }
        await finished.promise;
        expect(state.execute).toHaveBeenCalledTimes(1);
        expect(state.execute.mock.calls[0]?.[0]).toMatchObject({
          projectRef: { nodeId: desktopNode, projectId },
          contextThreadId: threadId,
        });
        expect(state.interpret).not.toHaveBeenCalled();
      } finally {
        resetCirceCommandBusForTests();
      }
    });

    it("leaves an incidental verb-complement mention on the ambient target", async () => {
      resetCirceCommandBusForTests();
      try {
        await readyOnMesh({ twoRivvls: false });
        // Out of the bounded grammar's reach on purpose: this test covers the
        // model path's role-aware grounding, not the deterministic parser.
        const source =
          "Check whether Circe believes in Rivvl when the release notes get written in the evening";
        // Correct evidence: subject role, never a destination. A destination
        // role here would route (see the adversarial test below): the stay
        // proves role-aware grounding, not a language guard.
        mockInterpretSuccess(subjectProposal(source, "Rivvl"));
        transcript(source, {
          captureId: "incidental",
          purpose: "command",
        });
        for (let turn = 0; turn < 50 && state.execute.mock.calls.length === 0; turn += 1) {
          await Promise.resolve();
          render();
        }
        await finished.promise;
        expect(state.execute).toHaveBeenCalledTimes(1);
        expect(state.execute.mock.calls[0]?.[0]).toMatchObject({
          projectRef: { nodeId: desktopNode, projectId },
          utterance:
            "Check whether Circe believes in Rivvl when the release notes get written in the evening",
        });
        expect(state.interpret).toHaveBeenCalledTimes(1);
      } finally {
        resetCirceCommandBusForTests();
      }
    });

    it("documents language dependence: a destination role for verb-complement phrasing still routes", async () => {
      resetCirceCommandBusForTests();
      try {
        await readyOnMesh({ twoRivvls: false });
        const source = "Check whether Circe believes in Rivvl";
        // Wrong-role containment evidence: the same wording with a
        // destination claim routes to the named node. Routing follows the
        // model's typed role, not the phrasing, so this documents dependence
        // on correct semantic evidence and claims no language guard.
        mockInterpretSuccess(destinationProposal(source, "in Rivvl", "Rivvl"));
        transcript(source, {
          captureId: "incidental-wrong-role",
          purpose: "command",
        });
        for (let turn = 0; turn < 50 && state.execute.mock.calls.length === 0; turn += 1) {
          await Promise.resolve();
          render();
        }
        await finished.promise;
        expect(state.execute).toHaveBeenCalledTimes(1);
        expect(state.execute.mock.calls[0]?.[0]).toMatchObject({
          projectRef: { nodeId: laptopNode, projectId: rivvlLaptop },
          utterance: source,
        });
      } finally {
        resetCirceCommandBusForTests();
      }
    });
  });
});
