import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { JarvisMeshCatalog } from "@t3tools/jarvis-client-runtime/jarvis/mesh";
import type { DependencyList, EffectCallback } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const state = vi.hoisted(() => ({
  primaryId: null as EnvironmentId | null,
  desktop: true,
  environments: [] as Array<{
    environmentId: EnvironmentId;
    label: string;
    connection: { phase: "connected" | "offline"; error: null };
    serverConfig: null;
  }>,
  effects: [] as Array<() => void>,
  refresh: vi.fn(),
  navigate: vi.fn(),
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
      });
    },
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../../env", () => ({
  get isElectron() {
    return state.desktop;
  },
}));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => state.primaryId,
  useEnvironments: () => ({ environments: state.environments }),
}));
vi.mock("../../state/jarvisMesh", () => ({
  jarvisMeshEnvironment: { refresh: Symbol("refresh") },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.refresh }));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() }, stackedThreadToast: vi.fn() }));
vi.mock("./JarvisNodeAgentSettings", () => ({ JarvisNodeAgentSettings: () => null }));

import { JarvisControlCenter } from "./JarvisControlCenter";

const LAPTOP = EnvironmentId.make("my-laptop");
const REMOTE = EnvironmentId.make("remote");
const EMPTY: JarvisMeshCatalog = { nodes: [], projects: [], providers: [] };

function renderPanel() {
  hooks.beginRender();
  const panel = JarvisControlCenter();
  for (const effect of state.effects.splice(0)) effect();
  return panel;
}

describe("Jarvis control center connection lifecycle", () => {
  beforeEach(() => {
    hooks.reset();
    state.primaryId = null;
    state.desktop = true;
    state.environments = [];
    state.effects = [];
    state.navigate.mockReset();
    state.refresh.mockReset().mockResolvedValue({ _tag: "Success", value: EMPTY });
  });

  it("shows and refreshes a local device that connects after the first render", async () => {
    renderPanel();
    await Promise.resolve();
    state.primaryId = LAPTOP;
    state.environments = [
      {
        environmentId: LAPTOP,
        label: "My laptop",
        serverConfig: null,
        connection: { phase: "connected", error: null },
      },
    ];
    const panel = renderPanel();
    const rail = visitElements(panel, (element) => Array.isArray(element.props.devices));

    expect(rail?.props.devices).toEqual([
      expect.objectContaining({
        node: expect.objectContaining({ nodeId: LAPTOP }),
        isCurrentDevice: true,
      }),
    ]);
    expect(state.refresh).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    renderPanel();
    expect(state.refresh).toHaveBeenCalledTimes(2);
  });

  it("does not call a browser's remote primary environment this device", () => {
    state.desktop = false;
    state.primaryId = REMOTE;
    state.environments = [
      {
        environmentId: REMOTE,
        label: "Remote",
        serverConfig: null,
        connection: { phase: "connected", error: null },
      },
    ];
    const panel = renderPanel();
    const rail = visitElements(panel, (element) => Array.isArray(element.props.devices));
    expect(rail?.props.devices).toEqual([expect.objectContaining({ isCurrentDevice: false })]);
  });

  it("keeps device and provider configuration scoped to the selected remote node", () => {
    state.primaryId = LAPTOP;
    state.environments = [LAPTOP, REMOTE].map((environmentId) => ({
      environmentId,
      label: environmentId,
      serverConfig: null,
      connection: { phase: "connected", error: null },
    }));
    const rail = visitElements(renderPanel(), (element) => Array.isArray(element.props.devices));
    if (typeof rail?.props.onSelect !== "function") throw new Error("Missing device selection");
    rail.props.onSelect(REMOTE);
    const details = visitElements(renderPanel(), (element) => "device" in element.props);
    expect(details?.props.device).toEqual(
      expect.objectContaining({ node: expect.objectContaining({ nodeId: REMOTE }) }),
    );
    if (typeof details?.props.onManageProviders !== "function")
      throw new Error("Missing provider configuration");
    details.props.onManageProviders();
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/settings/providers",
      search: { environmentId: REMOTE },
    });
  });

  it("ignores an older catalog response after the connections change", async () => {
    let finishOld: ((result: { _tag: "Success"; value: JarvisMeshCatalog }) => void) | undefined;
    state.refresh.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    );
    renderPanel();
    state.primaryId = LAPTOP;
    state.environments = [
      {
        environmentId: LAPTOP,
        label: "My laptop",
        serverConfig: null,
        connection: { phase: "connected", error: null },
      },
    ];
    renderPanel();
    await Promise.resolve();
    finishOld?.({
      _tag: "Success",
      value: {
        nodes: [{ nodeId: LAPTOP, label: "Old snapshot", reachability: "online" }],
        projects: [
          {
            ref: { nodeId: LAPTOP, projectId: ProjectId.make("old") },
            projectId: ProjectId.make("old"),
            title: "Stale project",
            workspaceRoot: "/old",
            nodeLabel: "Old snapshot",
            repositoryNames: [],
            aliases: [],
            aliasDetails: [],
          },
        ],
        providers: [],
      },
    });
    await Promise.resolve();
    const rail = visitElements(renderPanel(), (element) => Array.isArray(element.props.devices));
    expect(rail?.props.devices).toEqual([
      expect.objectContaining({
        node: expect.objectContaining({ label: "My laptop" }),
        projects: [],
      }),
    ]);
  });
});
