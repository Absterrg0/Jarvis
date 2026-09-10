import { isValidElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId, ProviderInstanceId } from "@t3tools/contracts";
import type { JarvisMeshCatalog } from "@t3tools/jarvis-client-runtime/jarvis/mesh";
import { reactHookHarness as hooks } from "../../../../web/src/test/reactHookHarness";

const state = vi.hoisted(() => ({
  catalog: null as JarvisMeshCatalog | null,
  execute: vi.fn(),
  desk: vi.fn(),
  refresh: vi.fn(),
  refreshNode: vi.fn(),
  interpret: vi.fn(),
  focus: vi.fn(),
  lookup: vi.fn(),
  converse: vi.fn(),
  cancelRequest: vi.fn(),
  save: vi.fn(),
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../../../web/src/test/reactHookHarness");
  return {
    ...actual,
    ...reactHookHarness,
    // These tests explicitly start/select tasks through the context actions.
    // Foreground and connection subscriptions are outside this dispatch seam.
    useEffect: () => undefined,
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../../../web/src/test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("../../lib/uuid", () => ({ uuidv4: () => crypto.randomUUID() }));
vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock("expo-haptics", () => ({
  impactAsync: async () => {},
  ImpactFeedbackStyle: { Light: "light" },
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) =>
    atom === "catalog" ? state.catalog : { _tag: "Success", value: {} },
  useAtomSet: () => state.save,
}));
vi.mock("../../state/preferences", () => ({
  mobilePreferencesAtom: "preferences",
  updateMobilePreferencesAtom: "save",
}));
vi.mock("../../state/jarvis", () => ({ jarvisEnvironment: {} }));
vi.mock("../../state/threads", () => ({ lookupThread: "lookup" }));
vi.mock("../../state/jarvisMesh", () => ({
  jarvisMeshCatalogAtom: "catalog",
  jarvisMeshEnvironment: {
    refresh: "refresh",
    refreshNode: "refreshNode",
    execute: "execute",
    interpret: "interpret",
    converse: "converse",
    getTaskDesk: "desk",
    focusTask: "focus",
    cancelRequest: "cancelRequest",
  },
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useRemoteConnectionStatus: () => ({ connectedEnvironments: [] }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (
    key:
      | "refresh"
      | "refreshNode"
      | "execute"
      | "interpret"
      | "converse"
      | "desk"
      | "focus"
      | "lookup"
      | "cancelRequest",
  ) => state[key],
}));
import { JarvisMobileProvider, type useJarvisController } from "./JarvisMobileProvider";

const nodeId = EnvironmentId.make("node-A");
const projectId = ProjectId.make("project-A");
const threadId = ThreadId.make("thread-A");
const projectRef = { nodeId, projectId };
const project = {
  ref: projectRef,
  projectId,
  title: "Work",
  workspaceRoot: "/work",
  nodeLabel: "Node A",
  repositoryNames: [],
  aliases: [],
  aliasDetails: [],
};
const desk = (requestId: string, kind: "approval" | "user-input" = "approval") => ({
  _tag: "Success",
  value: {
    focusedTask: {
      threadId,
      projectRef,
      taskRef: { executionNodeId: nodeId, threadId },
      pendingReply: { kind, requestId },
    },
    recentTasks: [],
    pendingInteraction: null,
  },
});
function render() {
  hooks.beginRender();
  const tree = JarvisMobileProvider({ children: null });
  if (!isValidElement<{ value: ReturnType<typeof useJarvisController> }>(tree))
    throw new Error("Missing provider value");
  return tree.props.value;
}
async function instruction(text: string) {
  const controller = render();
  await controller.runInstruction(controller.createTextTurn(), text);
}
async function startTask() {
  state.execute.mockResolvedValueOnce({
    _tag: "Success",
    value: {
      status: "started",
      threadId,
      taskRef: { executionNodeId: nodeId, threadId },
      objective: "Work",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "sol" },
    },
  });
  await instruction("Implement a feature");
}
beforeEach(() => {
  hooks.reset();
  vi.clearAllMocks();
  state.execute.mockReset();
  state.catalog = {
    nodes: [{ nodeId, label: "Node A", reachability: "online" }],
    projects: [project],
    providers: [],
  };
  state.desk.mockResolvedValue({
    _tag: "Success",
    value: { focusedTask: null, recentTasks: [], pendingInteraction: null },
  });
  state.execute.mockResolvedValue({
    _tag: "Success",
    value: { status: "acknowledged", action: "stopped", message: "Done" },
  });
  state.cancelRequest.mockReset();
  state.cancelRequest.mockResolvedValue({
    _tag: "Success",
    value: { status: "unknown", requestId: "none" },
  });
  // Proposal-first default: one interpret call returns an ambient proposal
  // (no refs), so fresh turns execute on the ambient project without a
  // second inference. Tests that need routing override this mock.
  state.interpret.mockReset();
  state.interpret.mockResolvedValue({
    _tag: "Success",
    value: { action: "start", refs: [], model: null, effort: null, answer: null },
  });
  state.refreshNode.mockReset();
  state.refreshNode.mockImplementation(
    async ({ nodeId: refreshNodeId }: { readonly nodeId: unknown }) => ({
      _tag: "Success",
      value: state.catalog,
    }),
  );
  state.refresh.mockReset();
  state.refresh.mockResolvedValue({ _tag: "Success", value: state.catalog });
});
describe("mobile provider answer transport lifecycle", () => {
  it.each(["approval", "user-input"] as const)(
    "retains the %s identity after a direct answer transport failure",
    async (kind) => {
      await startTask();
      state.desk.mockResolvedValue(desk("request-A", kind));
      state.execute.mockResolvedValueOnce({ _tag: "Failure", cause: new Error("offline") });
      await instruction("allow");
      const original = state.execute.mock.calls[1]?.[0];
      expect(original).toMatchObject({
        contextThreadId: threadId,
        expectedReply: { kind: kind === "approval" ? "approval" : "input", requestId: "request-A" },
      });
      // The failed direct answer owns its exact execute payload: requestId
      // pins the proposal and original source.
      expect(original.semanticProposal).toMatchObject({ action: "start" });
      expect(original.sourceUtterance).toBe("allow");
      expect(original.requestMetadata.requestId).toEqual(expect.any(String));
      state.desk.mockResolvedValue(desk("request-B", kind));
      await instruction("allow");
      const retry = state.execute.mock.calls[2]?.[0];
      expect(retry).toEqual(original);
      // Never rebuilds from the changed desk: the retry keeps the original
      // pin, proposal, source, and request identity.
      expect(retry.expectedReply).toEqual(original.expectedReply);
      expect(retry.semanticProposal).toEqual(original.semanticProposal);
      expect(retry.sourceUtterance).toBe("allow");
      expect(retry.requestMetadata.requestId).toBe(original.requestMetadata.requestId);
    },
  );
  it("discards a failed direct answer locally before accepting another instruction", async () => {
    await startTask();
    state.desk.mockResolvedValue(desk("request-A"));
    state.execute.mockResolvedValueOnce({ _tag: "Failure", cause: new Error("offline") });
    await instruction("allow");
    state.desk.mockResolvedValue(desk("request-B"));
    await instruction("cancel");
    expect(state.execute).toHaveBeenCalledTimes(2);
    await instruction("allow");
    expect(state.execute.mock.calls[2]?.[0].expectedReply).toEqual({
      kind: "approval",
      requestId: "request-B",
    });
  });
  it("releases a failed direct answer when the user explicitly changes project", async () => {
    await startTask();
    state.desk.mockResolvedValue(desk("request-A"));
    state.execute.mockResolvedValueOnce({ _tag: "Failure", cause: new Error("offline") });
    await instruction("allow");
    render().selectProject(project);
    await instruction("Start a different task");
    expect(state.execute).toHaveBeenCalledTimes(3);
    expect(state.execute.mock.calls[2]?.[0].expectedReply).toBeUndefined();
    expect(state.execute.mock.calls[2]?.[0].contextThreadId).toBeUndefined();
  });

  it("hands a received model clarification to the model-answer owner", async () => {
    await startTask();
    state.desk.mockResolvedValue(desk("request-A"));
    state.execute.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        status: "needs-input",
        reason: "effort-missing",
        prompt: "Which effort?",
        choices: ["low"],
        modelDraft: { instanceId: ProviderInstanceId.make("codex"), model: "sol" },
      },
    });
    await instruction("allow");
    await instruction("cancel");
    expect(state.execute).toHaveBeenCalledTimes(2);
    expect(render().message).toBe("Okay, I discarded that request.");
    // The next instruction must not remain intercepted by the model question.
    await instruction("Start another task");
    expect(state.execute).toHaveBeenCalledTimes(3);
  });
});

describe("mobile provider speech requests", () => {
  const voiceNodeId = EnvironmentId.make("voice-node");
  const spoken: Array<{
    readonly text: string;
    readonly speechKey: string;
    readonly threadKey: string;
  }> = [];
  async function voiceInstruction(text: string) {
    const controller = render();
    const detach = controller.attachSpeechSink((request) => {
      spoken.push({
        text: request.text,
        speechKey: request.speechKey,
        threadKey: request.threadKey,
      });
    });
    try {
      await controller.runInstruction(
        {
          originInteractionId: `voice-${spoken.length}-${text}`,
          inputMode: "voice",
          speechEnabled: true,
          voiceNodeId,
        } as never,
        text,
      );
    } finally {
      detach();
    }
  }
  beforeEach(() => {
    spoken.length = 0;
  });

  it("tags a started acknowledgement with the real task identity", async () => {
    state.execute.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        status: "started",
        threadId,
        taskRef: { executionNodeId: nodeId, threadId },
        objective: "Work",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "sol" },
        acknowledgement: "Taking a look at the auth.",
      },
    });
    await voiceInstruction("Review the auth");
    expect(spoken).toHaveLength(1);
    expect(spoken[0]?.text).toBe("Taking a look at the auth.");
    expect(spoken[0]?.threadKey).toBe(`${nodeId}:${threadId}`);
    expect(spoken[0]?.speechKey).toMatch(/:started$/u);
  });

  it("cancels an in-flight request before it is accepted", async () => {
    let resolveExecute!: (value: never) => void;
    state.execute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveExecute = resolve as never;
        }),
    );
    const controller = render();
    const pending = controller.runInstruction(controller.createTextTurn(), "Do slow work");
    await vi.waitFor(() => expect(state.execute).toHaveBeenCalledTimes(1));
    const sent = state.execute.mock.calls[0]?.[0] as {
      readonly requestMetadata: { readonly requestId: string };
    };
    state.cancelRequest.mockResolvedValueOnce({
      _tag: "Success",
      value: { status: "cancelled", requestId: sent.requestMetadata.requestId },
    });
    await expect(controller.cancelInflightRequest()).resolves.toBe("cancelled");
    expect(state.cancelRequest).toHaveBeenCalledWith({
      nodeId,
      input: {
        requestId: sent.requestMetadata.requestId,
        origin: { originInteractionId: expect.any(String) },
      },
    });
    resolveExecute({
      _tag: "Success",
      value: { status: "cancelled", requestId: sent.requestMetadata.requestId },
    } as never);
    await pending;
    expect(render().message).toBe("Cancelled before it started.");
  });

  it("keeps running work when the cancel loses the race", async () => {
    let resolveExecute!: (value: never) => void;
    state.execute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveExecute = resolve as never;
        }),
    );
    const controller = render();
    const pending = controller.runInstruction(controller.createTextTurn(), "Do slow work");
    await vi.waitFor(() => expect(state.execute).toHaveBeenCalledTimes(1));
    state.cancelRequest.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        status: "already-accepted",
        requestId: "request-late",
        threadId,
        taskRef: { executionNodeId: nodeId, threadId },
        projectId,
      },
    });
    await expect(controller.cancelInflightRequest()).resolves.toBe("already-accepted");
    expect(render().message).toBe("That request already started and keeps running.");
    resolveExecute({
      _tag: "Success",
      value: {
        status: "started",
        threadId,
        taskRef: { executionNodeId: nodeId, threadId },
        objective: "Work",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "sol" },
      },
    } as never);
    await pending;
    // The receipt still owns the final wording once it lands.
    expect(render().message).toBe("Started Work");
    // The returned identity still routes the follow-up to the running task.
    await controller.runInstruction(controller.createTextTurn(), "Continue it");
    expect(state.execute.mock.calls[1]?.[0]).toMatchObject({ contextThreadId: threadId });
  });

  it("keeps waiting when no cancellable request is known", async () => {
    state.execute.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        status: "started",
        threadId,
        taskRef: { executionNodeId: nodeId, threadId },
        objective: "Work",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "sol" },
      },
    });
    await instruction("Implement a feature");
    await expect(render().cancelInflightRequest()).resolves.toBe("idle");
    expect(state.cancelRequest).not.toHaveBeenCalled();
  });

  it("reports a directly cancelled execute receipt without claiming work", async () => {
    state.execute.mockResolvedValueOnce({
      _tag: "Success",
      value: { status: "cancelled", requestId: "request-direct" },
    });
    await instruction("Do slow work");
    expect(render().message).toBe("Cancelled before it started.");
  });

  it("routes a fresh cross-node mention to the owning node", async () => {
    const nodeB = EnvironmentId.make("node-B");
    const betaId = ProjectId.make("beta");
    const beta = {
      ref: { nodeId: nodeB, projectId: betaId },
      projectId: betaId,
      title: "Beta",
      workspaceRoot: "/work/beta",
      nodeLabel: "Node B",
      repositoryNames: [],
      aliases: [],
      aliasDetails: [],
    };
    state.catalog = {
      nodes: [
        { nodeId, label: "Node A", reachability: "online" },
        { nodeId: nodeB, label: "Node B", reachability: "online" },
      ],
      projects: [project, beta],
      providers: [],
    };
    render().selectProject(project);
    // Proposal-first: the model cites the full wrapper; the host grounds it.
    const source = "In Beta, fix it";
    const start = source.indexOf("In Beta");
    state.interpret.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        action: "start",
        refs: [
          {
            span: { start, end: start + "In Beta".length, text: "In Beta" },
            role: "destination",
            value: "Beta",
          },
        ],
        model: null,
        effort: null,
        answer: null,
      },
    });
    await instruction("In Beta, fix it");
    expect(state.execute).toHaveBeenCalledTimes(1);
    expect(state.execute.mock.calls[0]?.[0]).toMatchObject({
      projectRef: { nodeId: nodeB, projectId: betaId },
      utterance: "In Beta, fix it",
    });
    expect(state.execute.mock.calls[0]?.[0].contextThreadId).toBeUndefined();
    // The proposal traveled without IDs; the execution carries it plus verbatim source.
    expect(state.execute.mock.calls[0]?.[0].semanticProposal).toMatchObject({ action: "start" });
    expect(state.execute.mock.calls[0]?.[0].sourceUtterance).toBe("In Beta, fix it");
  });

  it("asks with node-qualified choices when one name lives on two nodes", async () => {
    const nodeB = EnvironmentId.make("node-B");
    const apiAId = ProjectId.make("api-a");
    const apiA = {
      ref: { nodeId, projectId: apiAId },
      projectId: apiAId,
      title: "Api",
      workspaceRoot: "/work/api",
      nodeLabel: "Node A",
      repositoryNames: [],
      aliases: [],
      aliasDetails: [],
    };
    const backendBId = ProjectId.make("backend-b");
    const backendB = {
      ref: { nodeId: nodeB, projectId: backendBId },
      projectId: backendBId,
      title: "Backend",
      workspaceRoot: "/data/api",
      nodeLabel: "Node B",
      repositoryNames: [],
      aliases: [],
      aliasDetails: [],
    };
    state.catalog = {
      nodes: [
        { nodeId, label: "Node A", reachability: "online" },
        { nodeId: nodeB, label: "Node B", reachability: "online" },
      ],
      projects: [apiA, backendB],
      providers: [],
    };
    const voiceNodeId = EnvironmentId.make("voice-node");
    const controller = render();
    // Same name on two nodes: the model cites the heard wrapper, the host
    // asks with node-qualified choices instead of guessing.
    const ambiguousSource = "Check status in api";
    const ambiguousStart = ambiguousSource.indexOf("in api");
    state.interpret.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        action: "start",
        refs: [
          {
            span: {
              start: ambiguousStart,
              end: ambiguousStart + "in api".length,
              text: "in api",
            },
            role: "destination",
            value: "Api",
          },
        ],
        model: null,
        effort: null,
        answer: null,
      },
    });
    await controller.runInstruction(
      {
        originInteractionId: "voice-ambiguous",
        inputMode: "voice",
        speechEnabled: true,
        voiceNodeId,
      } as never,
      "Check status in api",
    );
    expect(state.execute).not.toHaveBeenCalled();
    expect(render().message).toContain("more than one device");
    await instruction("the second one");
    expect(state.execute).toHaveBeenCalledTimes(1);
    expect(state.execute.mock.calls[0]?.[0]).toMatchObject({
      projectRef: { nodeId: nodeB, projectId: backendBId },
      // Verbatim source preserved; the host derives the instruction from the
      // original transcript minus validated spans, never a canonical rewrite.
      utterance: "Check status in api",
    });
  });

  it("reports an unambiguous offline destination without falling back", async () => {
    const nodeB = EnvironmentId.make("node-B");
    const gammaId = ProjectId.make("gamma");
    const gamma = {
      ref: { nodeId: nodeB, projectId: gammaId },
      projectId: gammaId,
      title: "Gamma",
      workspaceRoot: "/work/gamma",
      nodeLabel: "Node B",
      repositoryNames: [],
      aliases: [],
      aliasDetails: [],
    };
    state.catalog = {
      nodes: [
        { nodeId, label: "Node A", reachability: "online" },
        { nodeId: nodeB, label: "Node B", reachability: "offline" },
      ],
      projects: [project, gamma],
      providers: [],
    };
    render().selectProject(project);
    const offlineSource = "In Gamma, fix it";
    const offlineStart = offlineSource.indexOf("In Gamma");
    state.interpret.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        action: "start",
        refs: [
          {
            span: { start: offlineStart, end: offlineStart + "In Gamma".length, text: "In Gamma" },
            role: "destination",
            value: "Gamma",
          },
        ],
        model: null,
        effort: null,
        answer: null,
      },
    });
    await instruction("In Gamma, fix it");
    expect(state.execute).not.toHaveBeenCalled();
    expect(render().message).toBe(
      "Gamma is on Node B, which is disconnected. Reconnect it and try again.",
    );
  });

  it("asks for confirmation when a peer catalog is unread instead of guessing", async () => {
    const nodeB = EnvironmentId.make("node-B");
    state.catalog = {
      nodes: [
        { nodeId, label: "Node A", reachability: "online" },
        {
          nodeId: nodeB,
          label: "Node B",
          reachability: "online",
          catalogError: "unreachable",
          catalogErrorKind: "unreachable",
        },
      ],
      projects: [project],
      providers: [],
    };
    render().selectProject(project);
    // Ambient proposal, but the source names the ambient project while a
    // peer catalog is unread: uniqueness can't be established, so ask.
    await instruction("Check on Work today");
    expect(state.execute).not.toHaveBeenCalled();
    expect(render().message).toContain("unreachable");
    expect(render().message).toContain("Work — Node A");
  });

  it("keeps a pinned thread on its exact task when the wording names another node", async () => {
    const nodeB = EnvironmentId.make("node-B");
    const betaId = ProjectId.make("beta");
    const beta = {
      ref: { nodeId: nodeB, projectId: betaId },
      projectId: betaId,
      title: "Beta",
      workspaceRoot: "/work/beta",
      nodeLabel: "Node B",
      repositoryNames: [],
      aliases: [],
      aliasDetails: [],
    };
    state.catalog = {
      nodes: [
        { nodeId, label: "Node A", reachability: "online" },
        { nodeId: nodeB, label: "Node B", reachability: "online" },
      ],
      projects: [project, beta],
      providers: [],
    };
    render().selectProject(project);
    state.execute.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        status: "started",
        threadId,
        taskRef: { executionNodeId: nodeId, threadId },
        objective: "Work",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "sol" },
      },
    });
    await instruction("Implement a feature");
    await instruction("In Beta, fix it");
    expect(state.execute).toHaveBeenCalledTimes(2);
    expect(state.execute.mock.calls[1]?.[0]).toMatchObject({
      projectRef: { nodeId, projectId },
      contextThreadId: threadId,
      referenceThreadId: threadId,
    });
  });

  it("tags clarification prompts with the turn thread and distinct attempt keys", async () => {
    state.execute.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        status: "started",
        threadId,
        taskRef: { executionNodeId: nodeId, threadId },
        objective: "Work",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "sol" },
        acknowledgement: "Taking a look.",
      },
    });
    await voiceInstruction("Review the auth");
    state.execute.mockResolvedValue({
      _tag: "Success",
      value: {
        status: "needs-input",
        reason: "effort-missing",
        prompt: "Which effort?",
        choices: ["low"],
        modelDraft: { instanceId: ProviderInstanceId.make("codex"), model: "sol" },
      },
    });
    await voiceInstruction("Use low effort");
    const prompt = spoken.at(-1);
    expect(prompt?.threadKey).toBe(`${nodeId}:${threadId}`);
    expect(prompt?.speechKey).toMatch(/:needs-input$/u);
    expect(prompt?.speechKey).not.toBe(spoken[0]?.speechKey);
  });

  it("stays ambient on a negated destination and never chooses its node", async () => {
    render().selectProject(project);
    const source = "Check auth but not in Beta";
    const nodeB = EnvironmentId.make("node-B");
    const betaId = ProjectId.make("beta");
    state.catalog = {
      nodes: [
        { nodeId, label: "Node A", reachability: "online" },
        { nodeId: nodeB, label: "Node B", reachability: "online" },
      ],
      projects: [
        project,
        {
          ref: { nodeId: nodeB, projectId: betaId },
          projectId: betaId,
          title: "Beta",
          workspaceRoot: "/work/beta",
          nodeLabel: "Node B",
          repositoryNames: [],
          aliases: [],
          aliasDetails: [],
        },
      ],
      providers: [],
    };
    const start = source.indexOf("in Beta");
    state.interpret.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        action: "start",
        refs: [
          {
            span: { start, end: start + "in Beta".length, text: "in Beta" },
            role: "excluded",
            value: "Beta",
          },
        ],
        model: null,
        effort: null,
        answer: null,
      },
    });
    await instruction(source);
    expect(state.execute).toHaveBeenCalledTimes(1);
    // Excluded-only never routes: the ambient project owns the turn.
    expect(state.execute.mock.calls[0]?.[0]).toMatchObject({
      projectRef: { nodeId, projectId },
    });
    expect(state.interpret.mock.calls[0]?.[0].interpret.requestMetadata).toMatchObject({
      requestId: expect.any(String),
    });
  });

  it("rejects a pinned task whose project left the catalog instead of rerouting", async () => {
    render().selectProject(project);
    state.execute.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        status: "started",
        threadId,
        taskRef: { executionNodeId: nodeId, threadId },
        objective: "Work",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "sol" },
      },
    });
    await instruction("Implement a feature");
    // The pinned project disappears (removal/outage): the next followup must
    // report unavailable, never borrow another node.
    state.catalog = {
      nodes: [{ nodeId, label: "Node A", reachability: "online" }],
      projects: [],
      providers: [],
    };
    await instruction("Continue it");
    expect(render().message).toContain("unavailable");
  });

  it("runs model-decided converse project-free with cancellable identity", async () => {
    state.interpret.mockResolvedValueOnce({
      _tag: "Success",
      value: { action: "converse", refs: [], model: null, effort: null, answer: null },
    });
    state.converse.mockResolvedValueOnce({
      _tag: "Success",
      value: { status: "acknowledged", action: "conversed", message: "Today is calm." },
    });
    const controller = render();
    await controller.runInstruction(controller.createTextTurn(), "What is new today?");
    expect(state.interpret).toHaveBeenCalledTimes(1);
    expect(state.interpret.mock.calls[0]?.[0].interpret.requestMetadata).toMatchObject({
      requestId: expect.any(String),
    });
    expect(state.converse).toHaveBeenCalledTimes(1);
    expect(state.converse.mock.calls[0]?.[0].requestMetadata).toMatchObject({
      requestId: expect.any(String),
    });
    expect(state.execute).not.toHaveBeenCalled();
    expect(render().message).toBe("Today is calm.");
  });

  it("answers converse from the interpret proposal without a second supervisor call", async () => {
    state.interpret.mockResolvedValueOnce({
      _tag: "Success",
      value: { action: "converse", refs: [], model: null, effort: null, answer: "Today is calm." },
    });
    const controller = render();
    await controller.runInstruction(controller.createTextTurn(), "What is new today?");
    expect(state.interpret).toHaveBeenCalledTimes(1);
    expect(state.converse).not.toHaveBeenCalled();
    expect(state.execute).not.toHaveBeenCalled();
    expect(render().message).toBe("Today is calm.");
  });

  it("sends a question-shaped follow-up with a focused task to interpret, never client-side converse", async () => {
    state.desk.mockResolvedValue({
      _tag: "Success",
      value: {
        focusedTask: {
          threadId,
          projectRef,
          taskRef: { executionNodeId: nodeId, threadId },
        },
        recentTasks: [],
        pendingInteraction: null,
      },
    });
    state.interpret.mockResolvedValueOnce({
      _tag: "Success",
      value: { action: "continue", refs: [], model: null, effort: null, answer: null },
    });
    await instruction("What's the status?");
    // No client question heuristic may claim it: one interpret call, then
    // the execution node decides continue vs converse.
    expect(state.interpret).toHaveBeenCalledTimes(1);
    expect(state.converse).not.toHaveBeenCalled();
    expect(state.execute).toHaveBeenCalledTimes(1);
  });

  it("queues additional input behind in-flight work instead of cancelling it", async () => {
    let releaseExecute!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseExecute = resolve;
    });
    state.execute.mockImplementationOnce(() =>
      gate.then(() => ({
        _tag: "Success" as const,
        value: {
          status: "acknowledged" as const,
          action: "stopped" as const,
          message: "Done",
        },
      })),
    );
    const controller = render();
    const first = controller.runInstruction(controller.createTextTurn(), "First work");
    // Second input arrives while the first submits: it queues, never cancels.
    await controller.runInstruction(controller.createTextTurn(), "Second work");
    expect(state.cancelRequest).not.toHaveBeenCalled();
    releaseExecute();
    await first;
    // Drain the queued turn.
    await Promise.resolve();
    expect(state.execute.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("drains queued input behind a settled converse answer", async () => {
    let releaseConverse!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseConverse = resolve;
    });
    state.interpret.mockResolvedValue({
      _tag: "Success",
      value: { action: "converse", refs: [], model: null, effort: null, answer: null },
    });
    state.converse
      .mockImplementationOnce(() =>
        gate.then(() => ({
          _tag: "Success" as const,
          value: {
            status: "acknowledged" as const,
            action: "conversed" as const,
            message: "Today is calm.",
          },
        })),
      )
      .mockResolvedValue({
        _tag: "Success",
        value: { status: "acknowledged", action: "conversed", message: "Later is calm." },
      });
    const controller = render();
    const first = controller.runInstruction(controller.createTextTurn(), "What is new today?");
    // Second input arrives while converse submits: it queues, never cancels.
    await vi.waitFor(() => expect(state.converse).toHaveBeenCalledTimes(1));
    await controller.runInstruction(controller.createTextTurn(), "And tomorrow?");
    expect(state.converse).toHaveBeenCalledTimes(1);
    releaseConverse();
    await first;
    await vi.waitFor(() => expect(state.interpret).toHaveBeenCalledTimes(2));
    expect(state.converse).toHaveBeenCalledTimes(2);
  });
});
