import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  DesktopJarvisVoiceState,
  EnvironmentId,
  JarvisProjectRef,
  JarvisTaskPendingReply,
  JarvisTaskRef,
  ThreadId,
} from "@t3tools/contracts";
import type { JarvisMeshCatalog, JarvisMeshNode } from "@t3tools/jarvis-client-runtime/jarvis/mesh";
import { useNavigate } from "@tanstack/react-router";
import {
  AudioLinesIcon,
  BotIcon,
  CheckIcon,
  CircleAlertIcon,
  FolderGit2Icon,
  MicIcon,
  MonitorSpeakerIcon,
  RefreshCwIcon,
  ServerIcon,
  Settings2Icon,
  SlidersHorizontalIcon,
  SquareIcon,
  WifiOffIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isElectron } from "../../env";
import {
  getJarvisLastCommandFeedback,
  getJarvisTargetSnapshot,
  interruptJarvisInteractionSpeech,
  getJarvisCommandState,
  requestJarvisCommandAction,
  onJarvisCommandFeedback,
  onJarvisCommandState,
  onJarvisTargetSnapshot,
  openJarvisOnboarding,
  requestJarvisTarget,
  submitJarvisComposerCommand,
  type JarvisCommandFeedback,
  type JarvisTargetSnapshot,
} from "../../jarvisBus";
import {
  areJarvisVoiceReportsEnabled,
  setJarvisVoiceReportsEnabled,
} from "../../jarvisPreferences";
import { cn, randomUUID } from "../../lib/utils";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { jarvisMeshEnvironment } from "../../state/jarvisMesh";
import { useAtomCommand } from "../../state/use-atom-command";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { JARVIS_MARK_SRC } from "./JarvisBrand";
import {
  buildJarvisControlCenterView,
  type JarvisControlCenterDevice,
  type JarvisControlCenterView,
} from "./JarvisControlCenter.logic";
import { jarvisErrorMessage } from "./JarvisManager.logic";
import { buildJarvisVoiceWaitingView } from "@t3tools/jarvis-client-runtime/jarvis/voiceWaiting";
import {
  createJarvisBrowserCaptureController,
  isJarvisBrowserSpeechSupported,
} from "./JarvisBrowserCapture";
import { createJarvisNativeCaptureController } from "./JarvisNativeCapture";
import { JarvisNodeAgentSettings } from "./JarvisNodeAgentSettings";

const EMPTY_CATALOG: JarvisMeshCatalog = { nodes: [], projects: [], providers: [] };

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

function EnvironmentSummary({ summary }: { readonly summary: JarvisControlCenterView["summary"] }) {
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-col gap-1">
        <span className="aris-title text-4xl font-semibold tracking-tight text-foreground tabular-nums">
          {summary.onlineDevices}/{summary.devices}
        </span>
        <span className="aris-section-label">devices online</span>
      </div>
      <div className="grid grid-cols-2 gap-5">
        <div className="flex flex-col gap-1 border-l-2 border-primary/60 pl-3">
          <span className="text-lg font-medium text-foreground tabular-nums">
            {summary.readyProviders}/{summary.providers}
          </span>
          <span className="aris-section-label">providers ready</span>
        </div>
        <div className="flex flex-col gap-1 border-l border-border pl-3">
          <span className="text-lg font-medium text-foreground tabular-nums">
            {summary.projects}
          </span>
          <span className="aris-section-label">projects available</span>
        </div>
      </div>
    </div>
  );
}

function DeviceRail({
  devices,
  selectedNodeId,
  onSelect,
  onManage,
}: {
  readonly devices: ReadonlyArray<JarvisControlCenterDevice>;
  readonly selectedNodeId: EnvironmentId | null;
  readonly onSelect: (nodeId: EnvironmentId) => void;
  readonly onManage: () => void;
}) {
  return (
    <aside className="min-w-0">
      <div className="mb-3 flex items-center justify-between border-b border-border pb-2">
        <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-foreground">
          Devices
        </h2>
        <button
          type="button"
          className="rounded-[var(--control-radius)] px-1 text-[11px] text-muted-foreground transition-colors outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onManage}
        >
          Manage
        </button>
      </div>
      <div className="flex gap-1 overflow-x-auto lg:grid lg:overflow-visible">
        {devices.map((device) => {
          const selected = device.node.nodeId === selectedNodeId;
          const online = device.node.reachability === "online";
          return (
            <button
              key={device.node.nodeId}
              type="button"
              aria-pressed={selected}
              className={cn(
                "group flex min-w-52 items-center gap-3 rounded-[var(--control-radius)] border px-2.5 py-2 text-left transition-colors outline-hidden focus-visible:ring-2 focus-visible:ring-ring lg:min-w-0",
                selected
                  ? "border-border bg-card text-foreground"
                  : "border-transparent text-muted-foreground hover:border-border hover:bg-card/60 hover:text-foreground",
              )}
              onClick={() => onSelect(device.node.nodeId)}
            >
              <ServerIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <StatusDot online={online} />
                  <span className="truncate text-sm font-medium">{device.node.label}</span>
                  {device.isCurrentDevice ? (
                    <Badge variant="outline" className="shrink-0 text-[9px]">
                      This device
                    </Badge>
                  ) : null}
                </span>
                <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                  {device.node.capabilities?.preset ?? "unknown"} · {device.projects.length}{" "}
                  projects
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function LocalVoiceConsole() {
  const [voiceState, setVoiceState] = useState<DesktopJarvisVoiceState | null>(null);
  const [captureActive, setCaptureActive] = useState(false);
  const [outputTesting, setOutputTesting] = useState(false);
  const [lastTranscript, setLastTranscript] = useState<string | null>(null);
  const [reportsEnabled, setReportsEnabled] = useState(areJarvisVoiceReportsEnabled);
  const voice = typeof window === "undefined" ? undefined : window.desktopBridge?.jarvisVoice;

  useEffect(() => {
    if (voice === undefined) return;
    let active = true;
    void voice.getState().then(
      (state) => active && setVoiceState(state),
      () =>
        active &&
        setVoiceState({ status: "unavailable", native: true, errorCode: "STATE_UNAVAILABLE" }),
    );
    const removeState = voice.onState((state) => {
      setVoiceState(state);
      if (state.status === "ready" || state.status === "error" || state.status === "unavailable") {
        setCaptureActive(false);
      }
    });
    const removeTranscript = voice.onTranscript((transcript, event) => {
      if (event.purpose !== "diagnostic") return;
      setLastTranscript(transcript);
      setCaptureActive(false);
    });
    return () => {
      active = false;
      removeState();
      removeTranscript();
    };
  }, [voice]);

  const toggleMicrophone = useCallback(async () => {
    if (voice === undefined) return;
    if (captureActive) {
      const result = await voice.releaseCapture();
      if (!result.accepted) setCaptureActive(false);
      return;
    }
    setLastTranscript(null);
    const result = await voice.startCapture({ purpose: "diagnostic" });
    setCaptureActive(result.accepted);
    if (!result.accepted) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Microphone did not start",
          description: "ARIS could not open local capture. Check the voice status below.",
        }),
      );
    }
  }, [captureActive, voice]);

  const testOutput = useCallback(async () => {
    if (voice === undefined || outputTesting) return;
    setOutputTesting(true);
    try {
      const result = await voice.speak("ARIS is ready on this device.");
      if (result.status !== "played") throw new Error("The local speech engine rejected the test.");
    } catch (cause) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Voice output failed",
          description: cause instanceof Error ? cause.message : "Local speech could not start.",
        }),
      );
    } finally {
      setOutputTesting(false);
    }
  }, [outputTesting, voice]);

  const status = voice === undefined ? "Desktop required" : (voiceState?.status ?? "Checking");
  return (
    <section id="jarvis-local-voice" className="min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <AudioLinesIcon className="size-4 text-muted-foreground" />
            <h2 className="aris-title text-sm font-semibold text-foreground">
              Voice on this device
            </h2>
            <Badge className="text-[9px]" variant="outline">
              {status}
            </Badge>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Parakeet listens locally. Pocket loads only when ARIS has something to say.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={captureActive ? "destructive" : "outline"}
            disabled={voice === undefined}
            onClick={() => void toggleMicrophone()}
          >
            {captureActive ? <SquareIcon /> : <MicIcon />}
            {captureActive ? "Stop and transcribe" : "Test microphone"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={voice === undefined || outputTesting}
            onClick={() => void testOutput()}
          >
            <MonitorSpeakerIcon />
            {outputTesting ? "Speaking…" : "Test output"}
          </Button>
        </div>
      </div>

      <div className="mt-4 grid border-y border-border">
        <label className="flex items-center justify-between gap-4 py-3 md:pr-5">
          <span>
            <span className="block text-xs font-medium text-foreground">Speak agent reports</span>
            <span className="mt-0.5 block text-[10px] text-muted-foreground">
              Results and approvals aloud
            </span>
          </span>
          <Switch
            checked={reportsEnabled}
            aria-label="Speak ARIS reports"
            onCheckedChange={(checked) => {
              const enabled = Boolean(checked);
              setJarvisVoiceReportsEnabled(enabled);
              setReportsEnabled(enabled);
            }}
          />
        </label>
      </div>

      {lastTranscript ? (
        <p className="mt-3 truncate text-xs text-foreground/80">
          <span className="mr-2 text-muted-foreground">Last transcript</span>
          Heard: “{lastTranscript}”
        </p>
      ) : null}
    </section>
  );
}

function DeviceEnvironment({
  device,
  onManageConnections,
  onManageProviders,
}: {
  readonly device: JarvisControlCenterDevice;
  readonly onManageConnections: () => void;
  readonly onManageProviders: () => void;
}) {
  const online = device.node.reachability === "online";
  const capabilities = device.node.capabilities;
  const capabilityCount = capabilities
    ? [
        capabilities.ui,
        capabilities.parakeet,
        capabilities.pocket ?? capabilities.kokoro,
        capabilities.execution,
        capabilities.projects,
        capabilities.providers,
      ].filter(Boolean).length
    : 0;
  const capabilityRows = [
    ["Interface", capabilities?.ui],
    ["Microphone", capabilities?.parakeet],
    [
      "Voice output",
      capabilities === undefined ? undefined : (capabilities.pocket ?? capabilities.kokoro),
    ],
    ["Execution", capabilities?.execution],
    ["Projects", capabilities?.projects],
    ["Providers", capabilities?.providers],
  ] as const;

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-4">
        <div>
          <div className="flex items-center gap-2.5">
            <StatusDot online={online} />
            <h2 className="aris-title text-base font-semibold tracking-tight">
              {device.node.label}
            </h2>
            {device.isCurrentDevice ? <Badge variant="outline">This device</Badge> : null}
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
              {online ? "Online" : "Offline"}
            </span>
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {capabilities?.preset ?? "Unknown"} node · {capabilityCount}/6 capabilities ·{" "}
            {device.providers.filter((provider) => provider.available).length}/
            {device.providers.length} providers ready
          </p>
        </div>
        <Button size="xs" variant="ghost" onClick={onManageConnections}>
          <Settings2Icon /> Device settings
        </Button>
      </div>

      {device.node.catalogError ? (
        <div className="mt-4 flex items-start gap-2 border border-destructive/30 bg-destructive/8 px-3 py-2.5 text-xs text-destructive-foreground">
          <WifiOffIcon className="mt-0.5 size-3.5 shrink-0" /> {device.node.catalogError}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 border-b border-border pb-4">
        {capabilityRows.map(([label, enabled]) => (
          <span
            key={label}
            className={cn(
              "inline-flex items-center gap-1.5 text-[11px]",
              enabled ? "text-foreground/80" : "text-muted-foreground/45",
            )}
          >
            {enabled ? (
              <CheckIcon className="size-3 text-emerald-500" />
            ) : (
              <CircleAlertIcon className="size-3" />
            )}
            {label}
          </span>
        ))}
      </div>

      <div className="flex min-w-0 flex-col gap-7 pt-5">
        <JarvisNodeAgentSettings
          key={device.node.nodeId}
          environmentId={device.node.nodeId}
          online={online}
          executionEnabled={capabilities?.execution === true}
        />
        <section className="min-w-0">
          <div className="mb-3 flex items-center justify-between border-b border-border pb-2">
            <h3 className="flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-foreground">
              <BotIcon className="size-3.5 text-muted-foreground" /> Providers
            </h3>
            <button
              type="button"
              className="rounded-[var(--control-radius)] px-1 text-[11px] text-muted-foreground outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              onClick={onManageProviders}
            >
              Configure
            </button>
          </div>
          <div className="border-y border-border">
            {device.providers.length === 0 ? (
              <p className="py-5 text-xs text-muted-foreground">No providers advertised.</p>
            ) : (
              <>
                <div className="hidden grid-cols-[minmax(0,1fr)_9rem_8rem_5rem] gap-4 border-b border-border py-2 font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground sm:grid">
                  <span>Provider</span>
                  <span>Authentication</span>
                  <span>Runtime</span>
                  <span className="text-right">Status</span>
                </div>
                <div className="divide-y divide-border">
                  {device.providers.map((provider) => (
                    <div
                      key={provider.snapshot.instanceId}
                      className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-3 sm:grid-cols-[minmax(0,1fr)_9rem_8rem_5rem] sm:gap-4"
                    >
                      <span className="flex min-w-0 items-center gap-2.5">
                        <StatusDot online={provider.available} />
                        <span className="truncate text-xs font-medium">
                          {provider.snapshot.displayName ?? provider.snapshot.driver}
                        </span>
                      </span>
                      <span className="hidden truncate text-[11px] text-muted-foreground sm:block">
                        {provider.snapshot.auth.status}
                      </span>
                      <span className="hidden truncate text-[11px] text-muted-foreground sm:block">
                        {provider.snapshot.status}
                      </span>
                      <span
                        className={cn(
                          "text-right text-[10px]",
                          provider.available ? "text-emerald-500" : "text-amber-500",
                        )}
                      >
                        {provider.available ? "Ready" : "Attention"}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </section>
        <section className="min-w-0">
          <h3 className="mb-3 flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-foreground">
            <FolderGit2Icon className="size-3.5 text-muted-foreground" /> Projects
          </h3>
          <div className="border-y border-border">
            {device.projects.length === 0 ? (
              <p className="py-5 text-xs text-muted-foreground">No projects available.</p>
            ) : (
              <div className="divide-y divide-border">
                {device.projects.map((project) => (
                  <div
                    key={project.ref.projectId}
                    className="grid min-w-0 gap-1 py-3 sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-center sm:gap-4"
                  >
                    <span className="truncate text-xs font-medium">{project.title}</span>
                    <span className="truncate text-[11px] text-muted-foreground">
                      {project.workspaceRoot}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
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
      projectRef: JarvisProjectRef;
      taskRef?: JarvisTaskRef;
      pendingReply?: JarvisTaskPendingReply | null;
    }>
  >([]);
  const [browserListening, setBrowserListening] = useState(false);
  const [nativeListening, setNativeListening] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const browserSupported = isJarvisBrowserSpeechSupported();
  const nativeVoice = typeof window === "undefined" ? undefined : window.desktopBridge?.jarvisVoice;
  const getTaskDesk = useAtomCommand(jarvisMeshEnvironment.getTaskDesk, {
    reportFailure: false,
    reportDefect: false,
  });
  const captureRef = useRef<ReturnType<typeof createJarvisBrowserCaptureController> | null>(null);
  if (captureRef.current === null) {
    captureRef.current = createJarvisBrowserCaptureController({
      onTranscript: (event) => {
        submitJarvisComposerCommand({
          text: event.transcript,
          inputMode: "voice",
          captureId: event.captureId,
          sourceTranscript: event.transcript,
        });
      },
      onError: (message) => setMicError(`Browser speech: ${message}`),
      onPhase: (phase) => setBrowserListening(phase === "listening"),
    });
  }
  const nativeCaptureRef = useRef<ReturnType<typeof createJarvisNativeCaptureController> | null>(
    null,
  );
  if (nativeCaptureRef.current === null && nativeVoice !== undefined) {
    const bridge = nativeVoice;
    // Device capture feeds the runtime's native transcript path directly, so
    // this button only drives hold/release; the shared queue stays the owner.
    nativeCaptureRef.current = createJarvisNativeCaptureController({
      voice: bridge,
      onPhase: (phase) => setNativeListening(phase !== "idle"),
      onStartFailure: () => setMicError("Device microphone did not start."),
      onReleaseFailure: () => setMicError("Device microphone did not stop cleanly."),
    });
  }
  useEffect(() => {
    const browserCapture = captureRef.current;
    const deviceCapture = nativeCaptureRef.current;
    return () => {
      browserCapture?.dispose();
      deviceCapture?.cancel();
    };
  }, []);
  useEffect(() => onJarvisCommandFeedback((entry) => setFeedback(entry)), []);
  useEffect(() => onJarvisTargetSnapshot((snapshot) => setTargetSnapshot(snapshot)), []);
  useEffect(() => onJarvisCommandState(setCommandState), []);
  useEffect(() => {
    if (typeof document === "undefined") return;
    // A hidden window cannot supervise a hold: stop the mic instead of
    // dispatching speech the user can no longer see or cancel.
    const stopMicOnHide = () => {
      if (document.visibilityState === "hidden") {
        captureRef.current?.cancel();
        nativeCaptureRef.current?.cancel();
      }
    };
    document.addEventListener("visibilitychange", stopMicOnHide);
    return () => document.removeEventListener("visibilitychange", stopMicOnHide);
  }, []);

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
    setMicError(null);
    submitJarvisComposerCommand({ text, inputMode: "text", captureId: randomUUID() });
  }, [commandBusy, draft]);

  const cancelPending = useCallback(() => {
    requestJarvisCommandAction({ type: "cancel", inputMode: "text" });
    captureRef.current?.cancel();
    nativeCaptureRef.current?.cancel();
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
        Describe the task and press Send. If ARIS asks a follow-up question, answer it here.
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
          {nativeVoice !== undefined ? (
            <Button
              size="sm"
              variant={nativeListening ? "destructive" : "outline"}
              aria-pressed={nativeListening}
              aria-label="ARIS device voice input"
              onPointerDown={() => {
                setMicError(null);
                interruptJarvisInteractionSpeech();
                nativeCaptureRef.current?.start();
              }}
              onPointerUp={() => nativeCaptureRef.current?.release()}
              onPointerLeave={() => {
                if (nativeListening) nativeCaptureRef.current?.release();
              }}
              onPointerCancel={() => nativeCaptureRef.current?.cancel()}
              onBlur={() => {
                if (nativeListening) nativeCaptureRef.current?.cancel();
              }}
              onKeyDown={(event) => {
                if (event.key === " " || event.key === "Enter") {
                  event.preventDefault();
                  setMicError(null);
                  interruptJarvisInteractionSpeech();
                  nativeCaptureRef.current?.start();
                }
                if (event.key === "Escape") nativeCaptureRef.current?.cancel();
              }}
              onKeyUp={(event) => {
                if (event.key === " " || event.key === "Enter") {
                  event.preventDefault();
                  nativeCaptureRef.current?.release();
                }
              }}
            >
              {nativeListening ? <SquareIcon /> : <MicIcon />}
              {nativeListening ? "Release to send" : "Hold to speak"}
            </Button>
          ) : browserSupported ? (
            <Button
              size="sm"
              variant={browserListening ? "destructive" : "outline"}
              aria-pressed={browserListening}
              aria-label="ARIS browser voice input"
              onPointerDown={() => {
                setMicError(null);
                interruptJarvisInteractionSpeech();
                captureRef.current?.start(randomUUID());
              }}
              onPointerUp={() => captureRef.current?.release()}
              onPointerLeave={() => {
                if (browserListening) captureRef.current?.release();
              }}
              onPointerCancel={() => captureRef.current?.cancel()}
              onBlur={() => {
                if (browserListening) captureRef.current?.cancel();
              }}
              onKeyDown={(event) => {
                if (event.key === " " || event.key === "Enter") {
                  event.preventDefault();
                  setMicError(null);
                  interruptJarvisInteractionSpeech();
                  captureRef.current?.start(randomUUID());
                }
                if (event.key === "Escape") captureRef.current?.cancel();
              }}
              onKeyUp={(event) => {
                if (event.key === " " || event.key === "Enter") {
                  event.preventDefault();
                  captureRef.current?.release();
                }
              }}
            >
              {browserListening ? <SquareIcon /> : <MicIcon />}
              {browserListening ? "Release to send" : "Hold to speak"}
            </Button>
          ) : (
            <span className="text-[11px] text-muted-foreground">
              Browser speech not supported here. Text still works.
            </span>
          )}
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
        {micError ? (
          <p className="text-[11px] text-destructive-foreground">Microphone: {micError}</p>
        ) : null}
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
      environments.map(
        (environment): JarvisMeshNode => ({
          nodeId: environment.environmentId,
          label: environment.serverConfig?.environment.label ?? environment.label,
          reachability: environment.connection.phase === "connected" ? "online" : "offline",
          ...(environment.serverConfig?.environment.capabilities.jarvisNode === undefined
            ? {}
            : { capabilities: environment.serverConfig.environment.capabilities.jarvisNode }),
          ...(environment.connection.error === null
            ? {}
            : { catalogError: environment.connection.error }),
        }),
      ),
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
          <div className="ms-auto flex items-center gap-1">
            <Button size="xs" variant="ghost" onClick={() => openJarvisOnboarding()}>
              <SlidersHorizontalIcon /> Setup
            </Button>
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
            <section className="grid gap-8 border-b border-border pb-7 lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
              <EnvironmentSummary summary={view.summary} />
              <LocalVoiceConsole />
            </section>

            <JarvisCommandConsole catalog={catalog} />

            {error ? (
              <div className="flex items-start gap-2 border border-destructive/30 bg-destructive/8 px-3 py-2.5 text-xs text-destructive-foreground">
                <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" /> {error}
              </div>
            ) : null}

            {pending && catalog === null && view.devices.length === 0 ? (
              <div className="grid min-h-52 place-items-center border-y border-border text-xs text-muted-foreground">
                Loading your environment…
              </div>
            ) : view.devices.length === 0 ? (
              <div className="grid min-h-52 place-items-center border-y border-border px-6 text-center">
                <div>
                  <ServerIcon className="mx-auto size-5 text-muted-foreground" />
                  <div className="mt-3 text-sm font-medium">No devices connected</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    Open Connections to pair or reconnect a node.
                  </div>
                </div>
              </div>
            ) : (
              <section className="min-w-0">
                <div className="mb-5 border-b border-border pb-3">
                  <h2 className="aris-title text-sm font-semibold tracking-tight text-foreground">
                    Your ARIS mesh
                  </h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Devices and the projects, providers, and voice capabilities they own.
                  </p>
                </div>
                <div className="grid min-w-0 gap-8 lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
                  <DeviceRail
                    devices={view.devices}
                    selectedNodeId={selectedDevice?.node.nodeId ?? null}
                    onSelect={setSelectedNodeId}
                    onManage={() => void navigate({ to: "/settings/connections" })}
                  />
                  {selectedDevice ? (
                    <DeviceEnvironment
                      device={selectedDevice}
                      onManageConnections={() =>
                        void navigate({
                          to: "/settings/connections",
                          search: { environmentId: selectedDevice.node.nodeId },
                        })
                      }
                      onManageProviders={() =>
                        void navigate({
                          to: "/settings/providers",
                          search: { environmentId: selectedDevice.node.nodeId },
                        })
                      }
                    />
                  ) : null}
                </div>
              </section>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
