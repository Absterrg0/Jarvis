import type { ReactElement } from "react";
import {
  AuthOrchestrationOperateScope,
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerProvider,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const atoms = vi.hoisted(() => ({
  configAtom: Symbol("config"),
  providersAtom: Symbol("providers"),
  updateSettings: Symbol("updateSettings"),
  config: null as Pick<ServerConfig, "settings"> | null,
  providers: [] as ReadonlyArray<ServerProvider>,
  configEnvironmentIds: [] as EnvironmentId[],
  providerEnvironmentIds: [] as EnvironmentId[],
}));

const state = vi.hoisted(() => ({
  settings: null as UnifiedSettings | null,
  readEnvironmentIds: [] as EnvironmentId[],
  sessionEnvironmentIds: [] as EnvironmentId[],
  session: {
    data: { authenticated: true, scopes: ["orchestration:operate"] } as {
      authenticated: boolean;
      scopes: string[];
    } | null,
    hasError: false,
    isPending: false,
  },
}));

const commands = vi.hoisted(() => ({
  save: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: () => undefined,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: symbol) => {
    if (atom === atoms.configAtom) return atoms.config;
    if (atom === atoms.providersAtom) return atoms.providers;
    return null;
  },
}));

vi.mock("../../state/server", () => ({
  serverEnvironment: {
    configValueAtom: (environmentId: EnvironmentId) => {
      atoms.configEnvironmentIds.push(environmentId);
      return atoms.configAtom;
    },
    providersValueAtom: (environmentId: EnvironmentId) => {
      atoms.providerEnvironmentIds.push(environmentId);
      return atoms.providersAtom;
    },
    updateSettings: atoms.updateSettings,
  },
}));

vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: (environmentId: EnvironmentId) => {
    state.readEnvironmentIds.push(environmentId);
    return state.settings as UnifiedSettings;
  },
}));

vi.mock("../../state/session", () => ({
  useEnvironmentSessionState: (environmentId: EnvironmentId) => {
    state.sessionEnvironmentIds.push(environmentId);
    return state.session;
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => commands.save,
}));

import { JarvisNodeAgentSettings } from "./JarvisNodeAgentSettings";

const environmentId = EnvironmentId.make("remote-device");
const codexId = ProviderInstanceId.make("codex");
const claudeId = ProviderInstanceId.make("claudeAgent");

function provider(
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  models: ReadonlyArray<string>,
): ServerProvider {
  return {
    instanceId,
    driver,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: {} })),
    slashCommands: [],
    skills: [],
  };
}

function renderPanel(options?: {
  readonly online?: boolean;
  readonly executionEnabled?: boolean;
}): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  return JarvisNodeAgentSettings({
    environmentId,
    online: options?.online ?? true,
    executionEnabled: options?.executionEnabled ?? true,
  }) as ReactElement<Record<string, unknown>>;
}

function findPicker(panel: ReactElement<Record<string, unknown>>) {
  return visitElements(
    panel,
    (element) => typeof element.props.onInstanceModelChange === "function",
  );
}

function findButton(panel: ReactElement<Record<string, unknown>>, label: string) {
  return visitElements(panel, (element) => {
    if (typeof element.props.onClick !== "function") return false;
    const children = Array.isArray(element.props.children)
      ? element.props.children
      : [element.props.children];
    return children.includes(label);
  });
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("JarvisNodeAgentSettings", () => {
  beforeEach(() => {
    hooks.reset();
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      jarvisDefaultModelSelection: {
        instanceId: codexId,
        model: "codex-old",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    };
    state.readEnvironmentIds = [];
    state.sessionEnvironmentIds = [];
    atoms.configEnvironmentIds = [];
    atoms.providerEnvironmentIds = [];
    state.session = {
      data: { authenticated: true, scopes: [AuthOrchestrationOperateScope] },
      hasError: false,
      isPending: false,
    };
    atoms.config = { settings: state.settings };
    atoms.providers = [
      provider(codexId, ProviderDriverKind.make("codex"), ["codex-old", "codex-new"]),
      provider(claudeId, ProviderDriverKind.make("claudeAgent"), ["claude-new"]),
    ];
    commands.save.mockReset().mockImplementation(
      async (request: {
        readonly input: {
          readonly patch: {
            readonly jarvisDefaultModelSelection: UnifiedSettings["jarvisDefaultModelSelection"];
          };
        };
      }) => ({
        _tag: "Success",
        value: {
          ...state.settings,
          jarvisDefaultModelSelection: request.input.patch.jarvisDefaultModelSelection,
        },
      }),
    );
  });

  it("reads and saves the selected remote node, and reset uses a null replacement", async () => {
    const panel = renderPanel();
    expect(state.readEnvironmentIds).toEqual([environmentId]);
    expect(atoms.configEnvironmentIds).toEqual([environmentId]);
    expect(atoms.providerEnvironmentIds).toEqual([environmentId]);
    expect(state.sessionEnvironmentIds).toEqual([environmentId]);

    const picker = findPicker(panel);
    expect(picker?.props.activeInstanceId).toBe(codexId);
    if (typeof picker?.props.onInstanceModelChange !== "function")
      throw new Error("Missing agent picker");
    picker.props.onInstanceModelChange(claudeId, "claude-new");

    const changed = renderPanel();
    const changedPicker = findPicker(changed);
    expect(changedPicker?.props.activeInstanceId).toBe(claudeId);
    expect(changedPicker?.props.model).toBe("claude-new");

    const save = findButton(changed, "Save");
    (save?.props.onClick as (() => void) | undefined)?.();
    await flushPromises();
    expect(commands.save).toHaveBeenCalledWith({
      environmentId,
      input: {
        patch: {
          jarvisDefaultModelSelection: { instanceId: claudeId, model: "claude-new" },
        },
      },
    });

    const reset = findButton(changed, "Use project defaults");
    (reset?.props.onClick as (() => void) | undefined)?.();
    const resetPanel = renderPanel();
    const resetSave = findButton(resetPanel, "Save");
    (resetSave?.props.onClick as (() => void) | undefined)?.();
    await flushPromises();
    expect(commands.save).toHaveBeenLastCalledWith({
      environmentId,
      input: { patch: { jarvisDefaultModelSelection: null } },
    });
  });

  it("sends an explicitly selected high reasoning effort with the Jarvis default", async () => {
    state.settings = {
      ...state.settings!,
      jarvisDefaultModelSelection: {
        instanceId: codexId,
        model: "codex-old",
        options: [{ id: "reasoningEffort", value: "low" }],
      },
    };
    atoms.config = { settings: state.settings };
    const panel = renderPanel();
    const traits = visitElements(
      panel,
      (element) => typeof element.props.onModelOptionsChange === "function",
    );
    if (typeof traits?.props.onModelOptionsChange !== "function") {
      throw new Error("Missing Jarvis reasoning picker");
    }

    traits.props.onModelOptionsChange([{ id: "reasoningEffort", value: "high" }]);
    const selected = renderPanel();
    (findButton(selected, "Save")?.props.onClick as (() => void) | undefined)?.();
    await flushPromises();

    expect(commands.save).toHaveBeenLastCalledWith({
      environmentId,
      input: {
        patch: {
          jarvisDefaultModelSelection: {
            instanceId: codexId,
            model: "codex-old",
            options: [{ id: "reasoningEffort", value: "high" }],
          },
        },
      },
    });
  });

  it("drops stale model options when switching provider instances", () => {
    const panel = renderPanel();
    const picker = findPicker(panel);
    if (typeof picker?.props.onInstanceModelChange !== "function")
      throw new Error("Missing agent picker");
    picker.props.onInstanceModelChange(claudeId, "claude-new");
    const changed = renderPanel();
    const traits = visitElements(
      changed,
      (element) => typeof element.props.onModelOptionsChange === "function",
    );
    expect(traits?.props.modelOptions).toEqual([]);
  });

  it("keeps a live model valid when picker preferences hide it", () => {
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      ...state.settings,
      providerModelPreferences: {
        [codexId]: { hiddenModels: ["codex-old"], modelOrder: [] },
      },
    };
    atoms.config = { settings: state.settings };
    const panel = renderPanel();
    const picker = findPicker(panel);
    expect(picker?.props.activeInstanceId).toBe(codexId);
    expect(picker?.props.model).toBe("codex-old");
    const modelOptions = picker?.props.modelOptionsByInstance;
    if (!(modelOptions instanceof Map)) throw new Error("Missing model choices");
    expect(modelOptions.get(codexId)).toContainEqual(
      expect.objectContaining({ slug: "codex-old" }),
    );
  });

  it("does not treat a custom model absent from the live catalog as valid", () => {
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      ...state.settings,
      jarvisDefaultModelSelection: { instanceId: codexId, model: "custom-lagging" },
      providerInstances: {
        [codexId]: {
          driver: ProviderDriverKind.make("codex"),
          config: { customModels: ["custom-lagging"] },
        },
      },
    };
    atoms.config = { settings: state.settings };
    const panel = renderPanel();
    const picker = findPicker(panel);
    expect(picker?.props.activeInstanceId).toBe("t3code_no_provider");
    expect(picker?.props.model).toBe("");
  });

  it("locks the draft while a save is pending", async () => {
    let finishSave: ((result: { _tag: "Success"; value: UnifiedSettings }) => void) | undefined;
    const pending = new Promise<{ _tag: "Success"; value: UnifiedSettings }>((resolve) => {
      finishSave = resolve;
    });
    commands.save.mockReturnValueOnce(pending);
    const panel = renderPanel();
    (findButton(panel, "Save")?.props.onClick as (() => void) | undefined)?.();
    const saving = renderPanel();
    expect(findPicker(saving)?.props.disabled).toBe(true);
    expect(findButton(saving, "Save")?.props.disabled).toBe(true);
    expect(findButton(saving, "Use project defaults")?.props.disabled).toBe(true);
    finishSave?.({ _tag: "Success", value: state.settings ?? DEFAULT_UNIFIED_SETTINGS });
    await flushPromises();
    expect(findPicker(renderPanel())?.props.disabled).toBe(false);
  });

  it.each([
    ["offline", { online: false, executionEnabled: true }],
    ["controller", { online: true, executionEnabled: false }],
  ] as const)("disables editing when the node is %s", (_name, options) => {
    const panel = renderPanel(options);
    expect(findPicker(panel)?.props.disabled).toBe(true);
    expect(findButton(panel, "Save")?.props.disabled).toBe(true);
  });

  it("disables editing for a read-only remote session and hides controls for unknown config", () => {
    state.session = {
      data: { authenticated: true, scopes: ["orchestration:read"] },
      hasError: false,
      isPending: false,
    };
    const readOnly = renderPanel();
    expect(findPicker(readOnly)?.props.disabled).toBe(true);
    expect(findButton(readOnly, "Save")?.props.disabled).toBe(true);

    atoms.config = null;
    const unknown = renderPanel();
    expect(findPicker(unknown)).toBeNull();
  });

  it("keeps reset and Save available when an invalid default has no ready providers", async () => {
    atoms.providers = [];
    const panel = renderPanel();
    const reset = findButton(panel, "Use project defaults");
    expect(reset).not.toBeNull();
    (reset?.props.onClick as (() => void) | undefined)?.();

    const cleared = renderPanel();
    const save = findButton(cleared, "Save");
    expect(save).not.toBeNull();
    (save?.props.onClick as (() => void) | undefined)?.();
    await flushPromises();
    expect(commands.save).toHaveBeenLastCalledWith({
      environmentId,
      input: { patch: { jarvisDefaultModelSelection: null } },
    });
    const saved = renderPanel();
    expect(visitElements(saved, (element) => element.props.role === "status")).not.toBeNull();
  });

  it("reports an upgrade when an older node omits the requested setting", async () => {
    commands.save.mockResolvedValueOnce({
      _tag: "Success",
      value: { ...state.settings, jarvisDefaultModelSelection: null },
    });
    const panel = renderPanel();
    (findButton(panel, "Save")?.props.onClick as (() => void) | undefined)?.();
    await flushPromises();
    const result = renderPanel();
    const alert = visitElements(result, (element) => element.props.role === "alert");
    expect(JSON.stringify(alert?.props.children)).toContain("Update Jarvis on this device");
  });

  it("fails closed when the remote session cannot be read", () => {
    state.session = { data: null, hasError: true, isPending: false };
    const panel = renderPanel();
    expect(findPicker(panel)?.props.disabled).toBe(true);
    expect(findButton(panel, "Save")?.props.disabled).toBe(true);
  });
});
