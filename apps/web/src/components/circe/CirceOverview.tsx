import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  CirceTaskDeskTaskView,
  CirceTaskState,
  EnvironmentId,
  ProviderDriverKind,
} from "@t3tools/contracts";
import type { CirceMeshCatalog, CirceMeshNode } from "@circe/client-runtime/circe/mesh";
import { useNavigate } from "@tanstack/react-router";
import {
  BotIcon,
  CircleAlertIcon,
  FolderGit2Icon,
  LayoutDashboardIcon,
  MonitorSmartphoneIcon,
  MoonIcon,
  SearchIcon,
  ServerCogIcon,
  Settings2Icon,
  SunIcon,
  UserIcon,
  WorkflowIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { isElectron } from "../../env";
import { useTheme } from "../../hooks/useTheme";
import { cn } from "../../lib/utils";
import { circeMeshEnvironment } from "../../state/circeMesh";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { getDisplayModelName } from "../chat/providerIconUtils";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { buildCirceControlCenterView } from "./CirceControlCenter.logic";
import { CirceHorizontalLogo, CirceMark } from "./CirceLogo";
import { circeErrorMessage } from "./CirceManager.logic";
import { AgentsOnDevicePanel, DevicePanel, type DeviceTab } from "./CirceDevicePanel";
import {
  BrandFooter,
  LiveRunsPanel,
  Panel,
  PanelViewLink,
  RecentTasks,
  ScopeToolbar,
  StatCard,
  type Tone,
} from "./CirceOverviewParts";
import { SystemMap } from "./CirceSystemMap";

const EMPTY_CATALOG: CirceMeshCatalog = { nodes: [], projects: [], providers: [] };

type RunRow = CirceTaskDeskTaskView & {
  readonly nodeId: EnvironmentId;
  readonly deviceLabel: string;
};
type Scope = "all" | "devices" | "agents" | "providers" | "runs" | "errors";

const RUN_STATUS: Readonly<Record<CirceTaskState, Tone>> = {
  running: { label: "Running", text: "text-accent-ink", dot: "bg-primary" },
  "waiting-for-input": { label: "Needs input", text: "text-warning", dot: "bg-warning" },
  "waiting-for-approval": { label: "Needs approval", text: "text-warning", dot: "bg-warning" },
  ready: { label: "Completed", text: "text-success", dot: "bg-success" },
  failed: { label: "Failed", text: "text-error", dot: "bg-error" },
  interrupted: { label: "Stopped", text: "text-muted-foreground", dot: "bg-muted-foreground" },
};

const PROVIDER_LABEL: Readonly<Record<string, string>> = {
  codex: "Codex",
  claudeAgent: "Claude",
  opencode: "OpenCode",
  cursor: "Cursor",
  grok: "Grok",
  antigravity: "Antigravity",
};

function runBucket(state: CirceTaskState): "active" | "queued" | "completed" | "failed" {
  if (state === "running") return "active";
  if (state === "waiting-for-input" || state === "waiting-for-approval") return "queued";
  if (state === "ready") return "completed";
  return "failed";
}

function providerTone(enabled: boolean, available: boolean): Tone {
  if (!enabled) {
    return { label: "Disabled", text: "text-muted-foreground", dot: "bg-muted-foreground/50" };
  }
  if (available) {
    return { label: "Ready", text: "text-success", dot: "bg-success" };
  }
  return { label: "Unavailable", text: "text-warning", dot: "bg-warning" };
}

function formatPreset(preset: string): string {
  return preset.length > 0 ? preset.charAt(0).toUpperCase() + preset.slice(1) : preset;
}

const RAIL: ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly icon: ReactNode;
}> = [
  { id: "overview", label: "Overview", icon: <LayoutDashboardIcon className="size-4" /> },
  { id: "devices", label: "Devices", icon: <MonitorSmartphoneIcon className="size-4" /> },
  { id: "agents", label: "Agents", icon: <BotIcon className="size-4" /> },
  { id: "providers", label: "Providers", icon: <ServerCogIcon className="size-4" /> },
  { id: "automations", label: "Automations", icon: <WorkflowIcon className="size-4" /> },
  { id: "knowledge", label: "Knowledge", icon: <FolderGit2Icon className="size-4" /> },
  { id: "settings", label: "Settings", icon: <Settings2Icon className="size-4" /> },
];

export function CirceOverview() {
  const navigate = useNavigate();
  const { resolvedTheme, setAppearanceMode } = useTheme();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments, presentationById } = useEnvironments();
  const refreshMesh = useAtomCommand(circeMeshEnvironment.refresh, {
    reportFailure: false,
    reportDefect: false,
  });
  const getTaskDesk = useAtomCommand(circeMeshEnvironment.getTaskDesk, {
    reportFailure: false,
    reportDefect: false,
  });
  const [catalog, setCatalog] = useState<CirceMeshCatalog | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<ReadonlyArray<RunRow>>([]);
  const [scope, setScope] = useState<Scope>("all");
  const [deviceTab, setDeviceTab] = useState<DeviceTab>("overview");
  const refreshGeneration = useRef(0);

  const connectionKey = JSON.stringify(
    environments.map((environment) => [environment.environmentId, environment.connection.phase]),
  );
  const registeredNodes = useMemo(
    () =>
      environments.map((environment): CirceMeshNode => {
        return {
          nodeId: environment.environmentId,
          label: environment.serverConfig?.environment.label ?? environment.label,
          reachability: environment.connection.phase === "connected" ? "online" : "offline",
          ...(environment.serverConfig?.environment.capabilities.circeNode === undefined
            ? {}
            : { capabilities: environment.serverConfig.environment.capabilities.circeNode }),
          ...(environment.connection.error === null
            ? {}
            : { catalogError: environment.connection.error }),
        };
      }),
    [environments],
  );

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    setPending(true);
    setError(null);
    const result = await refreshMesh(undefined);
    if (generation !== refreshGeneration.current) return;
    if (result._tag === "Failure") {
      setError(circeErrorMessage(squashAtomCommandFailure(result)));
    } else {
      setCatalog(result.value);
    }
    setPending(false);
  }, [refreshMesh]);

  useEffect(() => {
    void refresh();
    return () => {
      refreshGeneration.current += 1;
    };
  }, [refresh, connectionKey]);

  const view = useMemo(
    () =>
      buildCirceControlCenterView(catalog ?? EMPTY_CATALOG, {
        registeredNodes,
        currentNodeId: isElectron ? primaryEnvironmentId : null,
      }),
    [catalog, registeredNodes, primaryEnvironmentId],
  );

  const onlineNodes = useMemo(
    () => view.devices.filter((device) => device.node.reachability === "online"),
    [view.devices],
  );
  const deskKey = onlineNodes.map((device) => device.node.nodeId).join("|");

  useEffect(() => {
    let active = true;
    if (onlineNodes.length === 0) {
      setRuns([]);
      return;
    }
    void Promise.all(
      onlineNodes.map(async (device) => {
        const result = await getTaskDesk({ nodeId: device.node.nodeId });
        if (result._tag !== "Success") return [] as ReadonlyArray<RunRow>;
        return result.value.recentTasks.map((task) => ({
          ...task,
          nodeId: device.node.nodeId,
          deviceLabel: device.node.label,
        }));
      }),
    ).then((batches) => {
      if (!active) return;
      setRuns(batches.flat());
    });
    return () => {
      active = false;
    };
  }, [deskKey, getTaskDesk, onlineNodes]);

  const agentGroups = useMemo(() => {
    const byDriver = new Map<
      string,
      { driver: ProviderDriverKind; label: string; ready: boolean }
    >();
    for (const provider of catalog?.providers ?? []) {
      const key = provider.snapshot.driver;
      const previous = byDriver.get(key);
      byDriver.set(key, {
        driver: provider.snapshot.driver,
        label: provider.snapshot.displayName ?? PROVIDER_LABEL[key] ?? provider.snapshot.driver,
        ready: (previous?.ready ?? false) || provider.available,
      });
    }
    return [...byDriver.values()];
  }, [catalog]);

  const selectedDevice = view.devices[0] ?? null;
  const deviceEnvironment = selectedDevice
    ? presentationById.get(selectedDevice.node.nodeId)?.serverConfig?.environment
    : undefined;

  const displayModel = useCallback(
    (driver: ProviderDriverKind): string | null => {
      const provider = selectedDevice?.providers.find((entry) => entry.snapshot.driver === driver);
      if (!provider) return null;
      const models = provider.snapshot.models;
      const model =
        models.find((entry) => entry.isDefault === true && !entry.isCustom) ??
        models.find((entry) => !entry.isCustom) ??
        models[0];
      return model ? getDisplayModelName(model) : null;
    },
    [selectedDevice],
  );

  const filteredRuns = useMemo(() => {
    if (scope === "errors") {
      return runs.filter((run) => runBucket(run.state) === "failed");
    }
    if (scope === "runs") return runs;
    if (scope === "agents" || scope === "providers") {
      return runs.filter((run) => run.modelSelection.model.length > 0);
    }
    return runs;
  }, [runs, scope]);

  const counts = useMemo(() => {
    const base = { active: 0, queued: 0, completed: 0, failed: 0 };
    for (const run of runs) base[runBucket(run.state)] += 1;
    return base;
  }, [runs]);

  const { devices, onlineDevices, providers, readyProviders, projects } = view.summary;
  const agentsReady = agentGroups.filter((agent) => agent.ready).length;
  const goDevices = useCallback(() => void navigate({ to: "/devices" }), [navigate]);
  const goProviders = useCallback(() => void navigate({ to: "/settings/providers" }), [navigate]);

  const runRows = filteredRuns.map((run) => ({
    key: `${run.nodeId}:${run.threadId}`,
    status: RUN_STATUS[run.state],
    title: run.title,
    agent: run.modelSelection.model,
    device: run.deviceLabel,
    bucket: runBucket(run.state),
  }));

  const recentRows = runs.slice(0, 6).map((run) => ({
    key: `${run.nodeId}:${run.threadId}`,
    title: run.title,
    device: run.deviceLabel,
    status: RUN_STATUS[run.state],
    state: run.state,
  }));

  const deviceProviders = selectedDevice?.providers ?? [];
  const capabilities = selectedDevice
    ? [
        { label: "UI", enabled: selectedDevice.node.capabilities?.ui ?? false },
        { label: "Execution", enabled: selectedDevice.node.capabilities?.execution ?? false },
        { label: "Projects", enabled: selectedDevice.node.capabilities?.projects ?? false },
        { label: "Providers", enabled: selectedDevice.node.capabilities?.providers ?? false },
        {
          label: "Push",
          enabled: selectedDevice.node.capabilities?.pushNotifications ?? false,
        },
      ]
    : [];

  const osLabel = deviceEnvironment?.platform.os
    ? `${deviceEnvironment.platform.os}${deviceEnvironment.platform.arch ? ` · ${deviceEnvironment.platform.arch}` : ""}`
    : "Unknown";
  const serverVersion = deviceEnvironment?.serverVersion ?? "Unknown";
  const machineLabel = deviceEnvironment?.platform.machine ?? null;
  const presetLabel = formatPreset(selectedDevice?.node.capabilities?.preset ?? "unknown");
  const deviceReadyCount = deviceProviders.filter((p) => p.available).length;
  const enabledCapabilities = capabilities.filter((capability) => capability.enabled).length;

  const deviceStats = selectedDevice
    ? [
        {
          label: "Status",
          value: selectedDevice.node.reachability === "online" ? "Online" : "Offline",
        },
        { label: "OS", value: osLabel },
        { label: "Circe version", value: serverVersion },
        { label: "Projects", value: String(selectedDevice.projects.length) },
        { label: "Agents", value: `${deviceReadyCount} / ${deviceProviders.length} ready` },
        { label: "Preset", value: presetLabel },
        ...(machineLabel ? [{ label: "Device type", value: machineLabel }] : []),
        { label: "Capabilities", value: `${enabledCapabilities} of ${capabilities.length} on` },
      ]
    : [];

  const deviceAgentRows = useMemo(() => {
    const byDriver = new Map<
      string,
      { driver: ProviderDriverKind; name: string; enabled: boolean; available: boolean }
    >();
    for (const provider of deviceProviders) {
      const key = provider.snapshot.driver;
      const previous = byDriver.get(key);
      byDriver.set(key, {
        driver: provider.snapshot.driver,
        name: provider.snapshot.displayName ?? PROVIDER_LABEL[key] ?? provider.snapshot.driver,
        enabled: (previous?.enabled ?? false) || provider.snapshot.enabled,
        available: (previous?.available ?? false) || provider.available,
      });
    }
    return [...byDriver.values()].map((group) => ({
      key: String(group.driver),
      driver: group.driver,
      name: group.name,
      model: displayModel(group.driver),
      tone: providerTone(group.enabled, group.available),
    }));
  }, [deviceProviders, displayModel]);

  const deviceProviderRows = deviceProviders.map((provider) => ({
    key: `${provider.nodeId}:${provider.snapshot.instanceId}`,
    name:
      provider.snapshot.displayName ??
      PROVIDER_LABEL[provider.snapshot.driver] ??
      provider.snapshot.driver,
    version: provider.snapshot.version,
    modelCount: provider.snapshot.models.length,
    tone: providerTone(provider.snapshot.enabled, provider.available),
  }));

  const deviceInstanceRows = deviceProviders.map((provider) => ({
    key: `${provider.nodeId}:${provider.snapshot.instanceId}`,
    name:
      provider.snapshot.displayName ??
      PROVIDER_LABEL[provider.snapshot.driver] ??
      provider.snapshot.driver,
    model: displayModel(provider.snapshot.driver),
    tone: providerTone(provider.snapshot.enabled, provider.available),
  }));

  const showStats = scope === "all" || scope === "devices";
  const showRuns = scope !== "devices" && scope !== "providers";
  const showDevice = scope === "all" || scope === "devices";
  const showAgents = scope === "all" || scope === "agents" || scope === "providers";
  const showMap = scope === "all" || scope === "devices";
  const showRecent = scope === "all";

  const liveRunsPanel = showRuns ? (
    <LiveRunsPanel
      emptyLabel={
        pending && catalog === null
          ? "Loading activity…"
          : runs.length === 0
            ? "No runs yet. Ask Circe to start one."
            : "Nothing in this filter."
      }
      hint="Activity across your devices"
      onViewAll={goDevices}
      rows={runRows}
      title={scope === "errors" ? "Failed runs" : "Live runs"}
    />
  ) : null;

  const systemMapPanel = showMap ? (
    <Panel
      action={
        <PanelViewLink label="View topology" onClick={goDevices}>
          View topology
        </PanelViewLink>
      }
      hint="Devices, agents, and providers"
      title="System map"
    >
      <SystemMap
        agentCount={agentGroups.length}
        agents={agentGroups.map((agent) => ({
          id: String(agent.driver),
          label: agent.label,
          driver: agent.driver,
        }))}
        deviceCount={devices}
        devices={view.devices.map((device) => ({
          id: device.node.nodeId,
          label: device.node.label,
          online: device.node.reachability === "online",
        }))}
        providerCount={providers}
        providers={(catalog?.providers ?? []).map((provider) => ({
          id: `${provider.nodeId}:${provider.snapshot.instanceId}`,
          label:
            provider.snapshot.displayName ??
            PROVIDER_LABEL[provider.snapshot.driver] ??
            provider.snapshot.driver,
          driver: provider.snapshot.driver,
        }))}
      />
    </Panel>
  ) : null;

  const recentTasksPanel = showRecent ? (
    <Panel
      action={
        <PanelViewLink label="View all tasks" onClick={goDevices}>
          View all
        </PanelViewLink>
      }
      hint="Newest tasks across your devices"
      title="Recent tasks"
    >
      <RecentTasks rows={recentRows} />
    </Panel>
  ) : null;

  const devicePanelNode = showDevice ? (
    selectedDevice ? (
      <DevicePanel
        agentRows={deviceAgentRows}
        capabilities={capabilities}
        label={selectedDevice.node.label}
        onManageProviders={goProviders}
        onOpenConsole={goDevices}
        onRefresh={() => void refresh()}
        onTab={setDeviceTab}
        online={selectedDevice.node.reachability === "online"}
        presetLabel={presetLabel}
        providerRows={deviceProviderRows}
        stats={deviceStats}
        tab={deviceTab}
      />
    ) : (
      <Panel title="Device">
        <div className="px-4 py-8 text-center text-sm text-muted-foreground">
          No devices connected.
        </div>
      </Panel>
    )
  ) : null;

  const agentsPanelNode =
    showAgents && selectedDevice ? (
      <AgentsOnDevicePanel
        deviceLabel={selectedDevice.node.label}
        onManage={goProviders}
        rows={deviceInstanceRows}
      />
    ) : null;

  const leftColumn = (
    <>
      {liveRunsPanel}
      {showMap || showRecent ? (
        showMap && showRecent ? (
          <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
            {systemMapPanel}
            {recentTasksPanel}
          </div>
        ) : showMap ? (
          systemMapPanel
        ) : (
          recentTasksPanel
        )
      ) : null}
    </>
  );
  const rightColumn = (
    <>
      {devicePanelNode}
      {agentsPanelNode}
    </>
  );
  const hasLeft = showRuns || showMap || showRecent;
  const hasRight = showDevice || (showAgents && selectedDevice !== null);

  return (
    <div className="flex h-dvh min-h-0 w-full overflow-hidden bg-background text-foreground">
      <nav
        aria-label="Control center"
        className="hidden w-60 shrink-0 flex-col border-e border-border bg-sidebar lg:flex"
      >
        <div className="flex h-[var(--workspace-topbar-height)] items-center px-4">
          <CirceHorizontalLogo alt="Circe" className="h-6" />
        </div>
        <div className="px-4 pt-3 pb-1">
          <span className="circe-section-label">Control center</span>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <ul className="flex flex-col gap-0.5 px-2 py-2">
            {RAIL.map((item) => {
              const active = item.id === "overview";
              const count =
                item.id === "devices"
                  ? devices
                  : item.id === "agents"
                    ? agentGroups.length
                    : item.id === "providers"
                      ? providers
                      : null;
              return (
                <li key={item.id}>
                  <button
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex h-10 w-full items-center gap-2.5 rounded-md px-3 text-sm transition-colors",
                      active
                        ? "circe-nav-selected font-medium text-sidebar-foreground"
                        : "border-l-2 border-transparent text-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                    )}
                    onClick={() => {
                      if (item.id === "devices") goDevices();
                      else if (item.id === "overview") void navigate({ to: "/circe" });
                      else if (item.id === "settings") void navigate({ to: "/settings/general" });
                      else if (item.id === "automations")
                        void navigate({ to: "/settings/integrations" });
                      else if (item.id === "knowledge")
                        void navigate({
                          to: "/settings/projects",
                          search: { project: undefined, machine: undefined },
                        });
                      else goProviders();
                    }}
                    type="button"
                  >
                    <span className={active ? "text-accent-ink" : "text-muted-foreground"}>
                      {item.icon}
                    </span>
                    <span className="truncate">{item.label}</span>
                    {count === null ? null : (
                      <span className="ms-auto text-xs tabular-nums text-muted-foreground">
                        {count}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </ScrollArea>
        <div className="m-3 flex items-center gap-3 rounded-xl border border-border bg-card px-3 py-3">
          <span
            aria-hidden
            className={cn(
              "size-2 shrink-0 rounded-full",
              error !== null ? "bg-error" : onlineDevices > 0 ? "bg-success" : "bg-warning",
            )}
          />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground">
              {error !== null
                ? "Needs attention"
                : onlineDevices > 0
                  ? "Circe is ready"
                  : "No devices online"}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {error ?? `${onlineDevices} of ${devices} devices online`}
            </div>
          </div>
        </div>
      </nav>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-[var(--workspace-topbar-height)] shrink-0 items-center gap-3 border-b border-border px-4">
          <CirceMark className="h-6 lg:hidden" />
          <span className="hidden whitespace-nowrap text-[11px] font-semibold tracking-[0.24em] text-muted-foreground xl:inline">
            THINK DO ACROSS YOUR MACHINES
          </span>
          <button
            className="mx-auto flex h-9 w-full max-w-xl items-center gap-2 rounded-md border border-border bg-card px-3 text-sm text-muted-foreground transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
            onClick={() => openCommandPalette()}
            type="button"
          >
            <SearchIcon className="size-4 shrink-0" />
            <span className="truncate">Search devices, agents, runs, or ask Circe…</span>
            <kbd className="ms-auto hidden rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] md:block">
              ⌘ K
            </kbd>
          </button>
          <div className="ms-auto flex shrink-0 items-center gap-2">
            <span className="hidden items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground sm:flex">
              <span
                aria-hidden
                className={cn(
                  "size-2 rounded-full",
                  onlineDevices > 0 ? "bg-success" : "bg-muted-foreground/50",
                )}
              />
              {onlineDevices} of {devices} devices connected
            </span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label="Toggle appearance"
                    onClick={() => setAppearanceMode(resolvedTheme === "dark" ? "light" : "dark")}
                    size="icon-sm"
                    variant="ghost"
                  >
                    {resolvedTheme === "dark" ? (
                      <SunIcon className="size-4" />
                    ) : (
                      <MoonIcon className="size-4" />
                    )}
                  </Button>
                }
              />
              <TooltipPopup>Toggle appearance</TooltipPopup>
            </Tooltip>
            <span className="grid size-8 place-items-center rounded-full border border-border bg-muted text-muted-foreground">
              <UserIcon className="size-4" />
            </span>
          </div>
        </header>

        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-3 p-4 md:p-6">
            {error ? (
              <div className="flex items-start gap-2 rounded-xl border border-error/30 bg-error/8 px-3 py-2.5 text-xs text-error-foreground">
                <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                {error}
              </div>
            ) : null}

            <ScopeToolbar
              active={scope}
              onNewRun={() => openCommandPalette()}
              onSelect={(id) => setScope(id as Scope)}
              scopes={[
                { id: "all", label: "All", count: null },
                { id: "devices", label: "Devices", count: devices },
                { id: "agents", label: "Agents", count: agentGroups.length },
                { id: "providers", label: "Providers", count: providers },
                { id: "runs", label: "Runs", count: counts.active },
                { id: "errors", label: "Errors", count: counts.failed },
              ]}
            />

            {showStats ? (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <StatCard
                  breakdown={[
                    { label: `${onlineDevices} online`, dot: "bg-success" },
                    { label: `${devices - onlineDevices} offline`, dot: "bg-muted-foreground/50" },
                  ]}
                  label="Devices"
                  max={devices}
                  onClick={goDevices}
                  value={devices}
                />
                <StatCard
                  breakdown={[
                    { label: `${agentsReady} ready`, dot: "bg-success" },
                    { label: `${agentGroups.length - agentsReady} limited`, dot: "bg-warning" },
                  ]}
                  label="Agents"
                  max={agentGroups.length}
                  onClick={goProviders}
                  value={agentGroups.length}
                />
                <StatCard
                  breakdown={[
                    { label: `${readyProviders} ready`, dot: "bg-success" },
                    {
                      label: `${providers - readyProviders} unavailable`,
                      dot: "bg-muted-foreground/50",
                    },
                  ]}
                  label="Providers"
                  max={providers}
                  onClick={goProviders}
                  value={providers}
                />
                <StatCard
                  breakdown={[{ label: `${projects} across devices`, dot: "bg-primary" }]}
                  label="Projects"
                  max={projects}
                  onClick={() =>
                    void navigate({
                      to: "/settings/projects",
                      search: { project: undefined, machine: undefined },
                    })
                  }
                  value={projects}
                />
              </div>
            ) : null}

            {hasLeft && hasRight ? (
              <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
                <div className="flex min-w-0 flex-col gap-3">{leftColumn}</div>
                <div className="flex min-w-0 flex-col gap-3">{rightColumn}</div>
              </div>
            ) : (
              <div className="flex min-w-0 flex-col gap-3">
                {leftColumn}
                {rightColumn}
              </div>
            )}
          </div>
        </ScrollArea>

        <BrandFooter />
      </div>
    </div>
  );
}
