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
  focus: vi.fn(),
  lookup: vi.fn(),
  converse: vi.fn(),
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
    execute: "execute",
    converse: "converse",
    getTaskDesk: "desk",
    focusTask: "focus",
  },
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useRemoteConnectionStatus: () => ({ connectedEnvironments: [] }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (key: "refresh" | "execute" | "converse" | "desk" | "focus" | "lookup") =>
    state[key],
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
      state.desk.mockResolvedValue(desk("request-B", kind));
      await instruction("allow");
      expect(state.execute.mock.calls[2]?.[0]).toEqual(original);
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
