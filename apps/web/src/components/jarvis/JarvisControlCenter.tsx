import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  JARVIS_CONVERSATION_TITLE_PREFIX,
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
  CheckIcon,
  CircleAlertIcon,
  FolderGit2Icon,
  MessageCircleIcon,
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
import { JarvisNodeAgentSettings } from "./JarvisNodeAgentSettings";

const EMPTY_CATALOG: JarvisMeshCatalog = { nodes: [], projects: [], providers: [] };

const JARVIS_TASK_STATE_LABEL: Readonly<Record<JarvisTaskState, string | null>> = {
  running: "Running",
  "waiting-for-input": "Needs answer",
  "waiting-for-approval": "Needs approval",
  failed: "Failed",
  interrupted: "Stopped",
  ready: null,
};

function StatusDot({ online }: { readonly online: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-[1px]",
        online ? "bg-emerald-500" : "bg-muted-foreground/40",
      )}
    />
  );
}

/**
 * One compact status line. The command surface owns the page; counts are
 * reference, not the product, so they never take the first screen.
 */
function EnvironmentSummary({ summary }: { readonly summary: JarvisControlCenterView["summary"] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <StatusDot online={summary.onlineDevices > 0} />
        <span className="tabular-nums text-foreground">
          {summary.onlineDevices}/{summary.devices}
        </span>
        devices
      </span>
      <span className="flex items-center gap-1.5">
        <StatusDot online={summary.providers > 0 && summary.readyProviders === summary.providers} />
        <span className="tabular-nums text-foreground">
          {summary.readyProviders}/{summary.providers}
        </span>
        providers
      </span>
      <span className="flex items-center gap-1.5">
        <span className="tabular-nums text-foreground">{summary.projects}</span>
        projects
      </span>
    </div>
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
    <div className="flex flex-wrap items-center gap-1.5">
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
              "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
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

function CapabilityPill({
  label,
  enabled,
}: {
  readonly label: string;
  readonly enabled: boolean | undefined;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px]",
        enabled
          ? "border-border bg-background text-foreground/90"
          : "border-border/40 text-muted-foreground/40",
      )}
    >
      {enabled ? (
        <CheckIcon className="size-3 text-emerald-500" />
      ) : (
        <span aria-hidden className="size-1.5 rounded-full bg-current opacity-40" />
      )}
      {label}
    </span>
  );
}

function DeviceHero({ device }: { readonly device: JarvisControlCenterDevice }) {
  const online = device.node.reachability === "online";
  const capabilities = device.node.capabilities;
  const readyProviders = device.providers.filter((provider) => provider.available).length;
  const pills = [
    ["Interface", capabilities?.ui],
    ["Execution", capabilities?.execution],
    ["Projects", capabilities?.projects],
    ["Providers", capabilities?.providers],
  ] as const;
  return (
    <section className="rounded-2xl border border-border bg-card p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <StatusDot online={online} />
            <h2 className="text-lg font-semibold tracking-tight">{device.node.label}</h2>
            {device.isCurrentDevice ? (
              <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">
                This device
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {online ? "Online" : "Offline"} · {capabilities?.preset ?? "unknown"} node ·{" "}
            {device.projects.length} projects · {readyProviders}/{device.providers.length} providers
            ready
          </p>
        </div>
      </div>
      <div className="mt-5 flex flex-wrap gap-2">
        {pills.map(([label, enabled]) => (
          <CapabilityPill key={label} label={label} enabled={enabled} />
        ))}
      </div>
      {device.node.catalogError ? (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2.5 text-xs text-destructive-foreground">
          <WifiOffIcon className="mt-0.5 size-3.5 shrink-0" /> {device.node.catalogError}
        </div>
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
    <section className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="flex items-center justify-between px-5 py-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <BotIcon className="size-4 text-muted-foreground" /> Providers
        </h3>
        <Button size="xs" variant="ghost" onClick={onManage}>
          Configure
        </Button>
      </div>
      {providers.length === 0 ? (
        <p className="px-5 pb-5 text-xs text-muted-foreground">No providers advertised.</p>
      ) : (
        <div className="divide-y divide-border border-t border-border">
          {providers.map((provider) => (
            <div
              key={provider.snapshot.instanceId}
              className="flex items-center justify-between gap-3 px-5 py-3"
            >
              <span className="flex min-w-0 items-center gap-3">
                <span
                  aria-hidden
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    provider.available ? "bg-emerald-500" : "bg-amber-500",
                  )}
                />
                <span className="truncate text-sm font-medium">
                  {provider.snapshot.displayName ?? provider.snapshot.driver}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-3 text-[11px] text-muted-foreground">
                <span className="hidden sm:inline">{provider.snapshot.auth.status}</span>
                <span className="hidden text-border sm:inline">·</span>
                <span className="hidden sm:inline">{provider.snapshot.status}</span>
                <span
                  className={cn(
                    "font-medium",
                    provider.available ? "text-emerald-500" : "text-amber-500",
                  )}
                >
                  {provider.available ? "Ready" : "Attention"}
                </span>
              </span>
            </div>
          ))}
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
    <section className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="flex items-center gap-2 px-5 py-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <FolderGit2Icon className="size-4 text-muted-foreground" /> Projects
        </h3>
      </div>
      {projects.length === 0 ? (
        <p className="px-5 pb-5 text-xs text-muted-foreground">No projects available.</p>
      ) : (
        <div className="divide-y divide-border border-t border-border">
          {projects.map((project) => (
            <div
              key={project.ref.projectId}
              className="flex min-w-0 items-center justify-between gap-4 px-5 py-3"
            >
              <span className="truncate text-sm font-medium">{project.title}</span>
              <span className="truncate font-mono text-[11px] text-muted-foreground">
                {project.workspaceRoot}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function JarvisCommandConsole({ catalog }: { readonly catalog: JarvisMeshCatalog | null }) {
  const [draft, setDraft] = useState("");
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

  const selectedNodeId = targetSnapshot?.projectRef?.nodeId ?? null;
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
    requestJarvisCommandAction({ type: "cancel", inputMode: "text" });
    setDraft("");
  }, []);

  const projects = catalog?.projects ?? [];
  const targetLabel =
    targetSnapshot?.projectRef === null || targetSnapshot?.projectRef === undefined
      ? "No explicit target"
      : `${targetSnapshot.projectTitle ?? targetSnapshot.projectRef.projectId} — ${targetSnapshot.nodeLabel ?? targetSnapshot.projectRef.nodeId}${
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

  return (
    <section aria-label="ARIS command" className="min-w-0 border-b border-border pb-7">
      <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-foreground">
        ARIS command
      </h2>
      <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
        Type a directive or start a live conversation. ARIS resolves the project and task against
        your real catalog, asks when a name is unclear, and runs the work through your providers.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="text-[11px] text-muted-foreground" htmlFor="jarvis-target-project">
          Project
        </label>
        <select
          id="jarvis-target-project"
          aria-label="ARIS project target"
          className="min-w-44 rounded-[var(--control-radius)] border border-border bg-card px-2 py-1.5 text-xs text-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
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
          <option value="">No explicit target</option>
          {projects.map((project) => (
            <option
              key={`${project.ref.nodeId}:${project.ref.projectId}`}
              value={`${project.ref.nodeId}:${project.ref.projectId}`}
            >
              {project.title} — {project.nodeLabel}
            </option>
          ))}
        </select>
        {tasks.length > 0 ? (
          <>
            <label className="text-[11px] text-muted-foreground" htmlFor="jarvis-target-task">
              Task
            </label>
            <select
              id="jarvis-target-task"
              aria-label="ARIS task target"
              className="min-w-44 rounded-[var(--control-radius)] border border-border bg-card px-2 py-1.5 text-xs text-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              disabled={commandPending}
              value={targetSnapshot?.contextThreadId ?? ""}
              onChange={(event) => {
                const threadId = event.target.value;
                if (threadId === "") return;
                // The row owns its node-qualified project: send that exact
                // ref, never the separately selected project, and send
                // nothing when the row is gone.
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
          </>
        ) : null}
        <Button
          size="xs"
          variant="ghost"
          disabled={commandPending}
          onClick={() => requestJarvisTarget({ type: "clear" })}
        >
          Reset target
        </Button>
        <span aria-live="polite" className="text-[11px] text-muted-foreground">
          {targetLabel}
        </span>
      </div>
      <div className="mt-3 flex flex-col gap-2">
        <textarea
          aria-label="ARIS instruction"
          className="min-h-20 w-full rounded-[var(--control-radius)] border border-border bg-card px-3 py-2 text-sm text-foreground outline-hidden placeholder:text-placeholder focus-visible:ring-2 focus-visible:ring-ring"
          placeholder="Ask ARIS to start, steer, or check a task…"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              sendDraft();
            }
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={sendDisabled} onClick={sendDraft}>
            {commandBusy ? "Working…" : awaitingAnswer ? "Send answer" : "Send"}
          </Button>
          {liveVoice.active ? (
            <span className="text-[11px] text-muted-foreground">
              Live conversation owns the microphone. End it to type.
            </span>
          ) : null}
          <Button
            size="sm"
            variant={liveVoice.active ? "destructive" : "outline"}
            aria-pressed={liveVoice.active}
            disabled={!liveVoice.active && catalog === null}
            onClick={() => setJarvisLiveVoiceActive(!liveVoice.active)}
          >
            {liveVoice.active
              ? liveVoice.status === "live"
                ? "End conversation"
                : liveVoice.status === "closing"
                  ? "Ending…"
                  : "Connecting…"
              : "Live conversation"}
          </Button>
          {canRetry && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => requestJarvisCommandAction({ type: "retry", inputMode: "text" })}
            >
              Retry
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={cancelPending}>
            Cancel
          </Button>
        </div>
        {waitingView ? (
          <div aria-live="polite" className="border border-border bg-card px-3 py-2 text-xs">
            <p className="text-[11px] text-muted-foreground">{waitingView.targetNote}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{waitingView.correctionHint}</p>
          </div>
        ) : null}
        {feedback ? (
          <p aria-live="polite" className="text-xs text-foreground/80">
            <span className="mr-2 text-muted-foreground">ARIS</span>
            {feedback.text}
          </p>
        ) : null}
        {tasks.length > 0 ? (
          <div className="mt-2 border-t border-border pt-3">
            <h3 className="aris-section-label">Recent work</h3>
            <ul className="mt-1 divide-y divide-border/60">
              {tasks.slice(0, 8).map((task) => {
                const projectTitle = projects.find(
                  (candidate) =>
                    candidate.ref.nodeId === task.projectRef.nodeId &&
                    candidate.ref.projectId === task.projectRef.projectId,
                )?.title;
                const isConversation = task.title.startsWith(JARVIS_CONVERSATION_TITLE_PREFIX);
                const stateLabel = JARVIS_TASK_STATE_LABEL[task.state];
                const isCurrent = targetSnapshot?.contextThreadId === task.threadId;
                return (
                  <li key={task.threadId}>
                    <button
                      type="button"
                      disabled={commandPending}
                      onClick={() =>
                        requestJarvisTarget({
                          type: "select-task",
                          projectRef: task.projectRef,
                          threadId: task.threadId,
                          title: task.title,
                          ...(task.taskRef === undefined ? {} : { taskRef: task.taskRef }),
                          ...(task.pendingReply === undefined
                            ? {}
                            : { pendingReply: task.pendingReply }),
                        })
                      }
                      className={cn(
                        "flex w-full items-center gap-2.5 px-1 py-2 text-left text-xs transition-colors",
                        commandPending ? "opacity-60" : "hover:bg-muted/40",
                        isCurrent ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {isConversation ? (
                        <MessageCircleIcon className="size-3.5 shrink-0 text-primary" />
                      ) : (
                        <StatusDot online={task.state === "running"} />
                      )}
                      <span className="min-w-0 flex-1 truncate">{task.title}</span>
                      {stateLabel !== null ? (
                        <span className="shrink-0 text-[11px] text-muted-foreground/80">
                          {stateLabel}
                        </span>
                      ) : null}
                      {projectTitle !== undefined ? (
                        <span className="hidden shrink-0 text-[11px] text-muted-foreground/60 sm:inline">
                          {projectTitle}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
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

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <WorkspaceBreadcrumb ariaLabel="ARIS environment breadcrumb" className="min-w-0">
            <WorkspaceBreadcrumbItem current>
              <span className="flex items-center gap-2">
                <img src={JARVIS_MARK_SRC} alt="" className="size-4 rounded-[2px]" />
                <h1 className="aris-title text-sm font-semibold tracking-tight">ARIS</h1>
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
              aria-label="Refresh ARIS environment"
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
          <WorkspacePageContainer width="wide">
            <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 py-8">
              <header className="flex flex-wrap items-end justify-between gap-3">
                <div className="flex flex-col gap-1.5">
                  <h1 className="text-xl font-semibold tracking-tight">Control center</h1>
                  <p className="text-sm text-muted-foreground">
                    Your ARIS mesh: devices, providers, projects, and agent settings.
                  </p>
                </div>
                <EnvironmentSummary summary={view.summary} />
              </header>

              <DeviceTabs
                devices={view.devices}
                selectedNodeId={selectedDevice?.node.nodeId ?? null}
                onSelect={setSelectedNodeId}
              />

              {error ? (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2.5 text-xs text-destructive-foreground">
                  <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" /> {error}
                </div>
              ) : null}

              {pending && catalog === null && view.devices.length === 0 ? (
                <div className="grid min-h-40 place-items-center rounded-2xl border border-border text-sm text-muted-foreground">
                  Loading your environment…
                </div>
              ) : view.devices.length === 0 ? (
                <div className="grid min-h-40 place-items-center rounded-2xl border border-dashed border-border px-6 text-center">
                  <div>
                    <ServerIcon className="mx-auto size-5 text-muted-foreground" />
                    <div className="mt-3 text-sm font-medium">No devices connected</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Open Connections to pair or reconnect a node.
                    </div>
                  </div>
                </div>
              ) : selectedDevice ? (
                <>
                  <DeviceHero device={selectedDevice} />
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
                  <section className="overflow-hidden rounded-2xl border border-border bg-card">
                    <div className="flex items-center gap-2 border-b border-border px-5 py-4">
                      <h3 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
                        <Settings2Icon className="size-4 text-muted-foreground" /> Node settings
                      </h3>
                    </div>
                    <div className="px-5 py-4">
                      <JarvisNodeAgentSettings
                        key={selectedDevice.node.nodeId}
                        environmentId={selectedDevice.node.nodeId}
                        online={selectedDevice.node.reachability === "online"}
                        executionEnabled={selectedDevice.node.capabilities?.execution === true}
                      />
                    </div>
                  </section>
                </>
              ) : null}
            </div>
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
