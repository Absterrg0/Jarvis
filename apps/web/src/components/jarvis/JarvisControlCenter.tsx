import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type JarvisProjectRef,
  type JarvisTaskPendingReply,
  type JarvisTaskRef,
  type JarvisTaskState,
  type ThreadId,
} from "@t3tools/contracts";
import type { JarvisMeshCatalog, JarvisMeshNode } from "@t3tools/jarvis-client-runtime/jarvis/mesh";
import { useNavigate } from "@tanstack/react-router";
import {
  BotIcon,
  MicIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  ActivityIcon,
  CircleAlertIcon,
  FolderGit2Icon,
  RefreshCwIcon,
  ServerIcon,
  Settings2Icon,
  WifiOffIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isElectron } from "../../env";
import {
  getJarvisLastCommandFeedback,
  getJarvisTargetSnapshot,
  getJarvisCommandState,
  requestJarvisCommandAction,
  onJarvisCommandFeedback,
  onJarvisCommandState,
  onJarvisTargetSnapshot,
  requestJarvisTarget,
  submitJarvisComposerCommand,
  type JarvisCommandFeedback,
  type JarvisTargetSnapshot,
} from "../../jarvisBus";
import { cn, randomUUID } from "../../lib/utils";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { jarvisMeshEnvironment } from "../../state/jarvisMesh";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  getJarvisLiveVoiceUiState,
  setJarvisLiveVoiceActive,
  subscribeJarvisLiveVoice,
} from "./JarvisLiveVoice.bridge";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { Button } from "../ui/button";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { JARVIS_MARK_SRC } from "./JarvisBrand";
import {
  buildJarvisControlCenterView,
  type JarvisControlCenterDevice,
  type JarvisControlCenterView,
} from "./JarvisControlCenter.logic";
import { jarvisErrorMessage } from "./JarvisManager.logic";
import { buildJarvisVoiceWaitingView } from "@t3tools/jarvis-client-runtime/jarvis/voiceWaiting";
import { JarvisLiveAgents } from "./JarvisLiveAgents";
import { JarvisMeshDevices } from "./JarvisMeshDevices";
import { JarvisNodeAgentSettings } from "./JarvisNodeAgentSettings";
import { PROVIDER_ICON_BY_PROVIDER } from "../chat/providerIconUtils";
import { jarvisPresenceMode } from "./JarvisPresence.logic";
import "./JarvisControlCenter.css";

const EMPTY_CATALOG: JarvisMeshCatalog = { nodes: [], projects: [], providers: [] };

function StatusDot({ online }: { readonly online: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "jarvis-status-dot size-1.5 shrink-0 rounded-full",
        online ? "jarvis-status-dot-live bg-emerald-500" : "bg-muted-foreground/40",
      )}
    />
  );
}

function EnvironmentSummary({ summary }: { readonly summary: JarvisControlCenterView["summary"] }) {
  return (
    <span className="jarvis-summary">
      <StatusDot online={summary.onlineDevices > 0} />
      {summary.onlineDevices} of {summary.devices} devices connected
    </span>
  );
}

function DeviceTabs({
  devices,
  selectedNodeId,
  onSelect,
}: {
  readonly devices: ReadonlyArray<JarvisControlCenterDevice>;
  readonly selectedNodeId: EnvironmentId | null;
  readonly onSelect: (nodeId: EnvironmentId) => void;
}) {
  if (devices.length <= 1) return null;
  return (
    <div className="jarvis-device-tabs flex flex-wrap items-center gap-1.5">
      {devices.map((device) => {
        const selected = device.node.nodeId === selectedNodeId;
        const online = device.node.reachability === "online";
        return (
          <button
            key={device.node.nodeId}
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(device.node.nodeId)}
            className={cn(
              "jarvis-device-tab inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
              selected
                ? "border-border bg-card text-foreground"
                : "border-transparent text-muted-foreground hover:bg-card/60 hover:text-foreground",
            )}
          >
            <StatusDot online={online} />
            {device.node.label}
            {device.isCurrentDevice ? (
              <span className="text-[10px] text-muted-foreground">this device</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function DeviceHero({ device }: { readonly device: JarvisControlCenterDevice }) {
  const online = device.node.reachability === "online";
  return (
    <section className="jarvis-device-info">
      <span className="jarvis-device-icon">
        <ServerIcon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <h2>{device.node.label}</h2>
        <p>
          {device.isCurrentDevice ? "This device" : "Connected device"} <span aria-hidden> / </span>{" "}
          {device.node.capabilities?.preset ?? "Unknown preset"}
        </p>
      </div>
      <span className="jarvis-device-state">
        <StatusDot online={online} />
        {online ? "Online" : "Offline"}
      </span>
      {device.node.catalogError ? (
        <p className="jarvis-device-error">
          <WifiOffIcon className="size-3.5" />
          {device.node.catalogError}
        </p>
      ) : null}
    </section>
  );
}

function ProviderSection({
  providers,
  onManage,
}: {
  readonly providers: JarvisControlCenterDevice["providers"];
  readonly onManage: () => void;
}) {
  return (
    <section className="jarvis-provider-section">
      <div className="jarvis-section-heading">
        <h3>
          Providers <span className="jarvis-inline-count">{providers.length}</span>
        </h3>
        <button type="button" onClick={onManage} className="jarvis-text-action">
          Manage
        </button>
      </div>
      {providers.length === 0 ? (
        <p className="jarvis-muted-note">Connect a provider to start working.</p>
      ) : (
        <div className="jarvis-provider-list">
          {providers.map((provider) => {
            const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[provider.snapshot.driver] ?? BotIcon;
            const state = provider.available
              ? "Ready"
              : !provider.snapshot.enabled
                ? "Disabled"
                : "Needs setup";
            return (
              <div className="jarvis-provider-row" key={provider.snapshot.instanceId}>
                <span className="jarvis-provider-icon">
                  <ProviderIcon className="size-[18px]" />
                </span>
                <span className="jarvis-provider-name">
                  {provider.snapshot.displayName ?? provider.snapshot.driver}
                </span>
                <span className="jarvis-provider-state" data-ready={provider.available}>
                  <StatusDot online={provider.available} />
                  {state}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ProjectSection({
  projects,
}: {
  readonly projects: JarvisControlCenterDevice["projects"];
}) {
  return (
    <details className="jarvis-project-section">
      <summary className="jarvis-section-heading">
        <span>
          Projects <span className="jarvis-inline-count">{projects.length}</span>
        </span>
        <ChevronDownIcon className="size-4" />
      </summary>
      {projects.length === 0 ? (
        <p className="jarvis-muted-note">No projects available.</p>
      ) : (
        <div className="jarvis-project-list">
          {projects.map((project) => (
            <div className="jarvis-project-row" key={project.ref.projectId}>
              <FolderGit2Icon className="size-3.5 shrink-0" />
              <div className="min-w-0">
                <p>{project.title}</p>
                <Tooltip>
                  <TooltipTrigger render={<span tabIndex={0} />}>
                    {project.workspaceRoot}
                  </TooltipTrigger>
                  <TooltipPopup>{project.workspaceRoot}</TooltipPopup>
                </Tooltip>
              </div>
            </div>
          ))}
        </div>
      )}
    </details>
  );
}

export function JarvisCommandConsole({ catalog }: { readonly catalog: JarvisMeshCatalog | null }) {
  const [draft, setDraft] = useState("");
  const [activityView, setActivityView] = useState<"recent" | "active">("recent");
  const [feedback, setFeedback] = useState<JarvisCommandFeedback | null>(() =>
    getJarvisLastCommandFeedback(),
  );
  const [targetSnapshot, setTargetSnapshot] = useState<JarvisTargetSnapshot | null>(() =>
    getJarvisTargetSnapshot(),
  );
  const [commandState, setCommandState] = useState(getJarvisCommandState);
  const { pending: commandPending, busy: commandBusy, awaitingAnswer, canRetry } = commandState;
  const [tasks, setTasks] = useState<
    ReadonlyArray<{
      threadId: ThreadId;
      title: string;
      state: JarvisTaskState;
      projectRef: JarvisProjectRef;
      taskRef?: JarvisTaskRef;
      pendingReply?: JarvisTaskPendingReply | null;
    }>
  >([]);
  const [liveVoice, setLiveVoice] = useState(getJarvisLiveVoiceUiState);
  const getTaskDesk = useAtomCommand(jarvisMeshEnvironment.getTaskDesk, {
    reportFailure: false,
    reportDefect: false,
  });
  useEffect(() => onJarvisCommandFeedback((entry) => setFeedback(entry)), []);
  useEffect(() => subscribeJarvisLiveVoice(() => setLiveVoice(getJarvisLiveVoiceUiState())), []);
  useEffect(() => onJarvisTargetSnapshot((snapshot) => setTargetSnapshot(snapshot)), []);
  useEffect(() => onJarvisCommandState(setCommandState), []);

  // Keep the task desk useful before the user chooses an explicit project.
  // Once a target exists, its qualified node always wins so work cannot bleed
  // across nodes.
  const selectedNodeId =
    targetSnapshot?.projectRef?.nodeId ??
    catalog?.nodes.find((node) => node.reachability === "online")?.nodeId ??
    null;
  useEffect(() => {
    // Drop rows the moment the selected node changes so a stale row from
    // another node can never be picked; failures clear them the same way.
    setTasks([]);
    if (selectedNodeId === null) return;
    let active = true;
    void getTaskDesk({ nodeId: selectedNodeId }).then((result) => {
      if (!active) return;
      if (result._tag !== "Success") {
        setTasks([]);
        return;
      }
      setTasks(
        result.value.recentTasks.map((task) => ({
          threadId: task.threadId,
          title: task.title,
          state: task.state,
          projectRef: task.projectRef,
          taskRef: task.taskRef,
          ...(task.pendingReply === undefined ? {} : { pendingReply: task.pendingReply }),
        })),
      );
    });
    return () => {
      active = false;
    };
  }, [getTaskDesk, selectedNodeId, targetSnapshot?.contextThreadId]);

  // Busy means a submission is on the wire; waiting means the runtime owns
  // paused or queued work and the answer goes through Send. Selectors stay
  // locked until the prompt resolves so an answer cannot land on a new
  // target. Both come from typed runtime state, not feedback wording.
  const sendDisabled = draft.trim().length === 0 || commandBusy;
  const sendDraft = useCallback(() => {
    const text = draft.trim();
    if (text.length === 0 || commandBusy) return;
    setDraft("");
    submitJarvisComposerCommand({ text, inputMode: "text", captureId: randomUUID() });
  }, [commandBusy, draft]);

  const cancelPending = useCallback(() => {
    if (commandPending || canRetry) {
      requestJarvisCommandAction({ type: "cancel", inputMode: "text" });
    }
    setDraft("");
  }, [commandPending, canRetry]);

  const projects = catalog?.projects ?? [];
  const targetProject = projects.find(
    (project) =>
      project.ref.nodeId === targetSnapshot?.projectRef?.nodeId &&
      project.ref.projectId === targetSnapshot?.projectRef?.projectId,
  );
  const targetNode = catalog?.nodes.find(
    (node) => node.nodeId === targetSnapshot?.projectRef?.nodeId,
  );
  const targetLabel =
    targetSnapshot?.projectRef === null || targetSnapshot?.projectRef === undefined
      ? "No explicit target"
      : `${targetSnapshot.projectTitle ?? targetProject?.title ?? "Project unavailable"} — ${targetSnapshot.nodeLabel ?? targetNode?.label ?? "Device unavailable"}${
          targetSnapshot.contextThreadTitle !== undefined
            ? ` · ${targetSnapshot.contextThreadTitle}`
            : targetSnapshot.contextThreadId !== undefined
              ? ` · ${targetSnapshot.contextThreadId}`
              : ""
        }${targetSnapshot.available === false ? " (unavailable)" : ""}`;
  // Derived from typed runtime state, not feedback wording: visible only while
  // a submission is dispatched and unanswered. No animation, so reduced motion
  // needs no special case.
  const waitingView = buildJarvisVoiceWaitingView({
    busy: commandBusy,
    awaitingAnswer,
    feedbackKind: feedback?.kind ?? null,
    feedbackText: feedback?.text ?? null,
    targetLabel,
    targetAvailable: targetSnapshot?.available ?? false,
  });
  const activeTask = tasks.find((task) => task.threadId === targetSnapshot?.contextThreadId);
  const presenceMode = jarvisPresenceMode({
    listening: liveVoice.active && liveVoice.status === "live",
    submitting: commandBusy,
    activeTaskState: activeTask?.state ?? null,
    error: feedback?.kind === "error" ? feedback.text : null,
  });

  return (
    <section aria-label="Jarvis command" className="jarvis-command-panel min-w-0">
      <header className="jarvis-console-header">
        <h2>Task desk</h2>
        <span className="jarvis-presence-label" data-state={presenceMode} aria-live="polite">
          <span aria-hidden />
          {
            {
              idle: "Ready",
              listening: "Voice on",
              working: "Working",
              speaking: "Speaking",
              attention: "Needs you",
              error: "Needs attention",
            }[presenceMode]
          }
        </span>
      </header>
      <div className="jarvis-agent-tabs" aria-label="Task views">
        <button
          type="button"
          aria-pressed={activityView === "recent"}
          onClick={() => setActivityView("recent")}
        >
          Recent tasks
        </button>
        <button
          type="button"
          aria-pressed={activityView === "active"}
          onClick={() => setActivityView("active")}
        >
          Running agents
        </button>
      </div>
      <JarvisLiveAgents catalog={catalog} view={activityView} />
      <div className="jarvis-compose-area">
        <div className="jarvis-target-context" aria-live="polite">
          <span>{targetSnapshot?.projectRef ? targetLabel : "Choose where to work"}</span>
          {targetSnapshot?.projectRef ? (
            <button
              type="button"
              className="jarvis-text-action"
              disabled={commandPending}
              onClick={() => requestJarvisTarget({ type: "clear" })}
            >
              Clear
            </button>
          ) : null}
        </div>
        <div className="jarvis-command-fields">
          <div className="jarvis-field-group">
            <label className="jarvis-field-label" htmlFor="jarvis-target-project">
              Project
            </label>
            <select
              id="jarvis-target-project"
              aria-label="Jarvis project target"
              className="jarvis-select min-w-44"
              disabled={commandPending}
              value={
                targetSnapshot?.projectRef
                  ? `${targetSnapshot.projectRef.nodeId}:${targetSnapshot.projectRef.projectId}`
                  : ""
              }
              onChange={(event) => {
                const value = event.target.value;
                if (value === "") {
                  requestJarvisTarget({ type: "clear" });
                  return;
                }
                const project = projects.find(
                  (candidate) => `${candidate.ref.nodeId}:${candidate.ref.projectId}` === value,
                );
                if (project) {
                  requestJarvisTarget({
                    type: "select-project",
                    projectRef: project.ref,
                    projectTitle: project.title,
                    nodeLabel: project.nodeLabel,
                  });
                }
              }}
            >
              <option value="">Choose a project</option>
              {projects.map((project) => (
                <option
                  key={`${project.ref.nodeId}:${project.ref.projectId}`}
                  value={`${project.ref.nodeId}:${project.ref.projectId}`}
                >
                  {project.title} — {project.nodeLabel}
                </option>
              ))}
            </select>
          </div>
          {tasks.length > 0 ? (
            <div className="jarvis-field-group">
              <label className="jarvis-field-label" htmlFor="jarvis-target-task">
                Task context
              </label>
              <select
                id="jarvis-target-task"
                aria-label="Jarvis task target"
                className="jarvis-select min-w-44"
                disabled={commandPending}
                value={targetSnapshot?.contextThreadId ?? ""}
                onChange={(event) => {
                  const threadId = event.target.value;
                  if (threadId === "") return;
                  const task = tasks.find((candidate) => candidate.threadId === threadId);
                  if (task === undefined) return;
                  requestJarvisTarget({
                    type: "select-task",
                    projectRef: task.projectRef,
                    threadId: task.threadId,
                    title: task.title,
                    ...(task.taskRef === undefined ? {} : { taskRef: task.taskRef }),
                    ...(task.pendingReply === undefined ? {} : { pendingReply: task.pendingReply }),
                  });
                }}
              >
                <option value="">Current task</option>
                {tasks.map((task) => (
                  <option key={task.threadId} value={task.threadId}>
                    {task.title}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </div>

        <div className="jarvis-composer-frame">
          <textarea
            aria-label="Jarvis instruction"
            className="jarvis-composer w-full"
            placeholder="Give an instruction…"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                sendDraft();
              }
            }}
          />
          <div className="jarvis-composer-footer flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant={liveVoice.active ? "destructive" : "outline"}
              aria-pressed={liveVoice.active}
              disabled={!liveVoice.active && catalog === null}
              onClick={() => setJarvisLiveVoiceActive(!liveVoice.active)}
            >
              <MicIcon className="size-3.5" />
              {liveVoice.active
                ? liveVoice.status === "live"
                  ? "End conversation"
                  : liveVoice.status === "closing"
                    ? "Ending…"
                    : "Connecting…"
                : "Voice"}
            </Button>
            {canRetry ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => requestJarvisCommandAction({ type: "retry", inputMode: "text" })}
              >
                Retry
              </Button>
            ) : null}
            {commandPending || canRetry || draft.length > 0 ? (
              <Button size="sm" variant="ghost" onClick={cancelPending}>
                Cancel
              </Button>
            ) : null}
            <Button
              className="jarvis-send-button"
              size="icon-sm"
              aria-label={commandBusy ? "Working" : awaitingAnswer ? "Send answer" : "Send"}
              title="Send instruction (Ctrl or Command + Enter)"
              disabled={sendDisabled}
              onClick={sendDraft}
            >
              <ArrowUpIcon className="size-4" />
            </Button>
          </div>
        </div>
        {liveVoice.active ? (
          <p className="jarvis-inline-note" aria-live="polite">
            Live conversation owns the microphone. End it to type.
          </p>
        ) : null}
        {waitingView ? (
          <div aria-live="polite" className="jarvis-feedback jarvis-feedback-waiting">
            <ActivityIcon className="size-4 shrink-0" />
            <div>
              <p className="text-xs font-medium text-foreground">{waitingView.targetNote}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {waitingView.correctionHint}
              </p>
            </div>
          </div>
        ) : null}
        {feedback ? (
          <p
            aria-live="polite"
            className={cn("jarvis-feedback", feedback.kind === "error" && "jarvis-feedback-error")}
          >
            <span className="jarvis-feedback-label">Jarvis</span>
            {feedback.text}
          </p>
        ) : null}
      </div>
    </section>
  );
}

export function JarvisControlCenter() {
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const refreshMesh = useAtomCommand(jarvisMeshEnvironment.refresh, {
    reportFailure: false,
    reportDefect: false,
  });
  const [catalog, setCatalog] = useState<JarvisMeshCatalog | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<EnvironmentId | null>(primaryEnvironmentId);
  const refreshGeneration = useRef(0);
  const connectionKey = JSON.stringify(
    environments.map((environment) => [environment.environmentId, environment.connection.phase]),
  );
  const registeredNodes = useMemo(
    () =>
      environments.map((environment): JarvisMeshNode => ({
        nodeId: environment.environmentId,
        label: environment.serverConfig?.environment.label ?? environment.label,
        reachability: environment.connection.phase === "connected" ? "online" : "offline",
        ...(environment.serverConfig?.environment.capabilities.jarvisNode === undefined
          ? {}
          : { capabilities: environment.serverConfig.environment.capabilities.jarvisNode }),
        ...(environment.connection.error === null
          ? {}
          : { catalogError: environment.connection.error }),
      })),
    [environments],
  );
  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    setPending(true);
    setError(null);
    const result = await refreshMesh(undefined);
    if (generation !== refreshGeneration.current) return;
    if (result._tag === "Failure") {
      setError(jarvisErrorMessage(squashAtomCommandFailure(result)));
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
      buildJarvisControlCenterView(catalog ?? EMPTY_CATALOG, {
        registeredNodes,
        currentNodeId: isElectron ? primaryEnvironmentId : null,
      }),
    [catalog, registeredNodes, primaryEnvironmentId],
  );
  const selectedDevice = useMemo(
    () =>
      view.devices.find((device) => device.node.nodeId === selectedNodeId) ??
      view.devices[0] ??
      null,
    [selectedNodeId, view.devices],
  );

  const liveCatalog = useMemo(
    () =>
      catalog === null
        ? null
        : {
            ...catalog,
            nodes: registeredNodes,
          },
    [catalog, registeredNodes],
  );

  return (
    <SidebarInset className="jarvis-control-center h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <WorkspaceBreadcrumb ariaLabel="Jarvis environment breadcrumb" className="min-w-0">
            <WorkspaceBreadcrumbItem current>
              <span className="flex items-center gap-2">
                <img src={JARVIS_MARK_SRC} alt="" className="size-4 rounded-[2px]" />
                <h1 className="text-sm font-semibold tracking-tight">Jarvis</h1>
              </span>
            </WorkspaceBreadcrumbItem>
            {selectedDevice ? (
              <>
                <WorkspaceBreadcrumbSeparator className="hidden sm:flex" />
                <WorkspaceBreadcrumbItem className="hidden min-w-0 shrink sm:flex">
                  <span className="truncate">{selectedDevice.node.label}</span>
                </WorkspaceBreadcrumbItem>
              </>
            ) : null}
          </WorkspaceBreadcrumb>
          <div className="ms-auto flex items-center gap-3">
            <Button
              size="xs"
              variant="ghost"
              onClick={() => void navigate({ to: "/settings/connections" })}
            >
              <Settings2Icon /> Connections
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Refresh Jarvis environment"
              disabled={pending}
              onClick={() => void refresh()}
            >
              <RefreshCwIcon
                className={cn("size-3.5", pending && "animate-spin motion-reduce:animate-none")}
              />
            </Button>
          </div>
        </WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="expanded" className="jarvis-page-container">
            <div className="jarvis-page">
              <header className="jarvis-page-heading">
                <h1>Command center</h1>
                <EnvironmentSummary summary={view.summary} />
              </header>

              <DeviceTabs
                devices={view.devices}
                selectedNodeId={selectedDevice?.node.nodeId ?? null}
                onSelect={setSelectedNodeId}
              />

              {error ? (
                <div className="jarvis-alert flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2.5 text-xs text-destructive-foreground">
                  <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" /> {error}
                </div>
              ) : null}

              {pending && catalog === null && view.devices.length === 0 ? (
                <div className="jarvis-empty-state grid min-h-40 place-items-center rounded-2xl border border-border text-sm text-muted-foreground">
                  <div className="text-center">
                    <p className="mt-4">Loading your environment…</p>
                  </div>
                </div>
              ) : view.devices.length === 0 ? (
                <div className="jarvis-empty-state grid min-h-52 place-items-center rounded-2xl border border-dashed border-border px-6 text-center">
                  <div>
                    <ServerIcon className="mx-auto size-5 text-muted-foreground" />
                    <div className="mt-3 text-base font-medium">No devices connected</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Open Connections to pair or reconnect a node.
                    </div>
                  </div>
                </div>
              ) : selectedDevice ? (
                <div className="jarvis-command-layout">
                  <main className="min-w-0">
                    <JarvisCommandConsole catalog={liveCatalog} />
                  </main>
                  <aside className="jarvis-side-rail">
                    <DeviceHero device={selectedDevice} />
                    <JarvisMeshDevices />
                    <ProviderSection
                      providers={selectedDevice.providers}
                      onManage={() =>
                        void navigate({
                          to: "/settings/providers",
                          search: { environmentId: selectedDevice.node.nodeId },
                        })
                      }
                    />
                    <ProjectSection projects={selectedDevice.projects} />
                    <JarvisNodeAgentSettings
                      key={selectedDevice.node.nodeId}
                      environmentId={selectedDevice.node.nodeId}
                      online={selectedDevice.node.reachability === "online"}
                      executionEnabled={selectedDevice.node.capabilities?.execution === true}
                    />
                  </aside>
                </div>
              ) : null}
            </div>
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
