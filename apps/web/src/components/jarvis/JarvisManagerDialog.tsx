import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  jarvisMeshCatalogCoverage,
  resolveJarvisMeshInstructionProject,
  type JarvisMeshCatalog,
  type JarvisMeshProject,
  type JarvisMeshProjectCandidate,
} from "@t3tools/jarvis-client-runtime/jarvis/mesh";
import { answerJarvisModelChoice, type JarvisModelDraft } from "@t3tools/jarvis-core/modelChoice";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  DesktopJarvisVoiceState,
  EnvironmentId,
  JarvisNeedsInput,
  JarvisProjectRef,
  JarvisTaskDeskTaskView,
  JarvisTaskRef,
  ModelSelection,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { ExternalLinkIcon, MicIcon, PlayIcon, SquareIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { JarvisCommandTarget } from "../../jarvisBus";
import { jarvisReporterIdentity } from "../../jarvisIdentity";
import { randomUUID } from "../../lib/utils";
import { environmentCatalog } from "../../connection/catalog";
import { jarvisMeshEnvironment } from "../../state/jarvisMesh";
import { useProject } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Dialog, DialogDescription, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { Field, FieldLabel } from "../ui/field";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { JarvisPresence } from "./JarvisPresence";
import { jarvisPresenceMode } from "./JarvisPresence.logic";
import {
  createJarvisNativeCaptureController,
  groundJarvisVoiceProjectMention,
  jarvisRecognitionContextPhrases,
} from "./JarvisNativeCapture";
import { JARVIS_BRAND_NAME, JARVIS_BRAND_TAGLINE, JARVIS_MARK_SRC } from "./JarvisBrand";
import {
  appendJarvisChoice,
  applyJarvisClarificationChoice,
  buildJarvisRequestMetadata,
  desktopVoiceAllowsBrowserFallback,
  desktopVoiceCanStartCapture,
  desktopVoiceCanRetry,
  desktopVoiceStatusMessage,
  isJarvisModelClarificationReason,
  jarvisFullSessionTarget,
  type JarvisModelClarificationReason,
  jarvisManagementTasks,
  jarvisRequestFingerprint,
  jarvisErrorMessage,
  jarvisManagerCanSubmit,
  jarvisManagerHeaderState,
  jarvisManagerNodeCapabilities,
  jarvisSelectedTargetPresentation,
  jarvisTaskExecutionTarget,
  jarvisTaskStateLabel,
  jarvisExecutionFeedback,
  resolveJarvisVoiceDefaultTarget,
  resolveJarvisVoiceMentionTarget,
  jarvisManagerCatalogIsReady,
  resolveJarvisRequestId,
  createJarvisVoiceSubmissionQueue,
  isJarvisVoiceClarificationDiscard,
  type JarvisVoiceSubmission,
  resolveJarvisVoiceProjectChoice,
  shouldSubmitJarvisVoiceTranscript,
  isJarvisVoiceGarbageTranscript,
} from "./JarvisManager.logic";

interface SpeechRecognitionResultEventLike {
  readonly results: ArrayLike<{
    readonly isFinal: boolean;
    readonly 0: { readonly transcript: string };
  }>;
}

interface BrowserSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionResultEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

function speechRecognitionConstructor(): BrowserSpeechRecognitionConstructor | null {
  const browserWindow = window as typeof window & {
    SpeechRecognition?: BrowserSpeechRecognitionConstructor;
    webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
  };
  return browserWindow.SpeechRecognition ?? browserWindow.webkitSpeechRecognition ?? null;
}

interface JarvisManagerDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly returnFocusRef: React.RefObject<HTMLElement | null>;
  readonly routeTarget: JarvisCommandTarget | null;
  readonly onTargetConsumed: () => void;
  readonly onThreadStarted: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) => Promise<void> | void;
  readonly onOpenConnections: (environmentId?: EnvironmentId, action?: "rename" | "remove") => void;
  readonly onOpenOnboarding: () => void;
  readonly autoSubmitVoice?: boolean;
  /** Keeps orchestration mounted while Desktop's dedicated overlay owns voice presentation. */
  readonly voiceOnly?: boolean;
  readonly voiceToggleRequest?: number;
  readonly onVoiceToggleConsumed?: () => void;
  readonly voiceStartRequest?: number;
  readonly onVoiceStartConsumed?: () => void;
  readonly voiceReleaseRequest?: number;
  readonly onVoiceReleaseConsumed?: () => void;
  readonly initialUtterance?: string | null;
}

function speakBrowserText(text: string): void {
  if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = navigator.language || "en-US";
  window.speechSynthesis.speak(utterance);
}

function speakWithoutDesktopVoice(text: string): void {
  speakBrowserText(text);
}

async function desktopVoiceBridgeAllowsBrowserFallback(): Promise<boolean> {
  const voice = window.desktopBridge?.jarvisVoice;
  if (voice === undefined) return true;
  try {
    const current = await voice.getState();
    return desktopVoiceAllowsBrowserFallback(current);
  } catch {
    // A broken native IPC path must not silently switch a Full node to a
    // browser speech service. Non-native Desktop platforms report their
    // capability through getState() and take the fallback above.
    return false;
  }
}

function speakJarvisText(text: string): void {
  if (text.trim().length === 0) return;
  const nativeVoice = window.desktopBridge?.jarvisVoice;
  if (nativeVoice) {
    void nativeVoice.speak(text, "interaction").then(
      async (response) => {
        if (response.status === "failed" && (await desktopVoiceBridgeAllowsBrowserFallback())) {
          speakWithoutDesktopVoice(text);
        }
      },
      async () => {
        if (await desktopVoiceBridgeAllowsBrowserFallback()) speakWithoutDesktopVoice(text);
      },
    );
    return;
  }
  speakWithoutDesktopVoice(text);
}

async function playJarvisAcknowledgement(): Promise<void> {
  await window.desktopBridge?.jarvisVoice?.playAcknowledgement().catch(() => undefined);
}

interface JarvisDeskNodeView {
  readonly nodeId: EnvironmentId;
  readonly nodeLabel: string;
  readonly focusedThreadId: ThreadId | null;
  readonly tasks: ReadonlyArray<JarvisTaskDeskTaskView>;
}

interface JarvisDialogTarget {
  readonly projectRef: JarvisProjectRef;
  readonly projectTitle?: string;
  readonly contextThreadId?: ThreadId;
  readonly contextThreadTitle?: string;
  readonly referenceThreadId?: ThreadId;
  readonly taskRef?: JarvisTaskRef;
}

export function JarvisManagerDialog({
  open,
  onOpenChange,
  returnFocusRef,
  routeTarget,
  onTargetConsumed,
  onThreadStarted,
  onOpenConnections,
  autoSubmitVoice = false,
  voiceOnly = false,
  voiceToggleRequest = 0,
  onVoiceToggleConsumed,
  voiceStartRequest = 0,
  onVoiceStartConsumed,
  voiceReleaseRequest = 0,
  onVoiceReleaseConsumed,
  initialUtterance = null,
}: JarvisManagerDialogProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const originNodeId = primaryEnvironmentId;
  const executeInstruction = useAtomCommand(jarvisMeshEnvironment.execute, {
    reportFailure: false,
    reportDefect: false,
  });
  const refreshMesh = useAtomCommand(jarvisMeshEnvironment.refresh, {
    reportFailure: false,
    reportDefect: false,
  });
  const refreshMeshNode = useAtomCommand(jarvisMeshEnvironment.refreshNode, {
    reportFailure: false,
    reportDefect: false,
  });
  const getTaskDesk = useAtomCommand(jarvisMeshEnvironment.getTaskDesk, {
    reportFailure: false,
    reportDefect: false,
  });
  const focusTask = useAtomCommand(jarvisMeshEnvironment.focusTask, {
    reportFailure: false,
    reportDefect: false,
  });
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, {
    reportFailure: false,
    reportDefect: false,
  });
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const requestIdRef = useRef<string | null>(null);
  const requestFingerprintRef = useRef<string | null>(null);
  const currentTargetRef = useRef<JarvisDialogTarget | null>(null);
  const voiceSubmissionSnapshotsRef = useRef(
    new Map<string, { readonly requestId: string; readonly target: JarvisDialogTarget | null }>(),
  );
  const [utterance, setUtterance] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [listening, setListening] = useState(false);
  const [clarification, setClarification] = useState<JarvisNeedsInput | null>(null);
  const [projectCandidates, setProjectCandidates] =
    useState<ReadonlyArray<JarvisMeshProjectCandidate> | null>(null);
  const [catalog, setCatalog] = useState<JarvisMeshCatalog | null>(null);
  const [catalogPending, setCatalogPending] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [taskDesks, setTaskDesks] = useState<ReadonlyArray<JarvisDeskNodeView>>([]);
  const [taskDesksPending, setTaskDesksPending] = useState(false);
  const [selectedProjectRef, setSelectedProjectRef] = useState<JarvisProjectRef | null>(null);
  const [selectedTask, setSelectedTask] = useState<{
    readonly nodeId: EnvironmentId;
    readonly task: JarvisTaskDeskTaskView;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [voiceRetryAvailable, setVoiceRetryAvailable] = useState(false);
  const [nativeVoiceState, setNativeVoiceState] = useState<DesktopJarvisVoiceState | null>(null);
  const catalogRef = useRef<JarvisMeshCatalog | null>(catalog);
  catalogRef.current = catalog;
  const submitVoiceTranscriptRef = useRef(false);
  const submissionBusyRef = useRef(false);
  const voiceClarificationRef = useRef<{
    readonly instruction: string;
    readonly sourceUtterance: string;
    readonly clarification: JarvisNeedsInput;
    readonly target: JarvisDialogTarget | null;
    readonly projectCandidates?: ReadonlyArray<JarvisMeshProjectCandidate>;
    readonly acceptsAffirmation?: boolean;
    readonly captureId: string;
    readonly requestId: string;
    readonly modelDraft?: JarvisModelDraft;
  } | null>(null);
  // Typed answers to provider/model/effort clarification. The draft carries
  // the multi-step choice state; the selection is consumed by the next submit
  // and sent with the original utterance instead of rewritten English.
  const modelDraftRef = useRef<{
    readonly utterance: string;
    readonly reason: JarvisModelClarificationReason;
    readonly draft: JarvisModelDraft;
  } | null>(null);
  const pendingModelSelectionRef = useRef<ModelSelection | null>(null);
  const voiceSubmissionReadyRef = useRef(false);
  const submitVoiceInstructionRef = useRef<
    (submission: JarvisVoiceSubmission) => Promise<void | "complete" | "pause">
  >(async () => undefined);
  const voiceSubmissionQueueRef = useRef<ReturnType<
    typeof createJarvisVoiceSubmissionQueue
  > | null>(null);
  if (voiceSubmissionQueueRef.current === null) {
    voiceSubmissionQueueRef.current = createJarvisVoiceSubmissionQueue({
      canSubmit: () => voiceSubmissionReadyRef.current && !submissionBusyRef.current,
      submit: (submission) => submitVoiceInstructionRef.current(submission),
    });
  }
  const nativeCaptureControllerRef = useRef<ReturnType<
    typeof createJarvisNativeCaptureController
  > | null>(null);
  const nativeCaptureControllerVoiceRef = useRef<typeof nativeVoiceBridge>(undefined);

  // Command context is owned by explicit selection and the current route.
  // Spoken reports never contribute: they are display-only.
  const commandTarget: JarvisCommandTarget | null = routeTarget;
  const targetProjectRef = useMemo(() => {
    if (selectedTask) {
      return scopeProjectRef(
        selectedTask.task.projectRef.nodeId,
        selectedTask.task.projectRef.projectId,
      );
    }
    if (selectedProjectRef) {
      return scopeProjectRef(selectedProjectRef.nodeId, selectedProjectRef.projectId);
    }
    return commandTarget
      ? scopeProjectRef(commandTarget.environmentId, commandTarget.projectId)
      : null;
  }, [commandTarget, selectedProjectRef, selectedTask]);
  const activeProject = useProject(targetProjectRef);
  const catalogProject = catalog?.projects.find(
    (project) =>
      project.ref.nodeId === targetProjectRef?.environmentId &&
      project.ref.projectId === targetProjectRef?.projectId,
  );
  const target: JarvisDialogTarget | null = targetProjectRef
    ? {
        projectRef: {
          nodeId: targetProjectRef.environmentId,
          projectId: targetProjectRef.projectId,
        },
        ...(selectedTask
          ? {
              contextThreadId: selectedTask.task.threadId,
              contextThreadTitle: selectedTask.task.title,
              referenceThreadId: selectedTask.task.taskRef?.threadId ?? selectedTask.task.threadId,
              taskRef: selectedTask.task.taskRef,
            }
          : commandTarget && selectedProjectRef === null
            ? {
                ...(commandTarget.contextThreadId === undefined
                  ? {}
                  : { contextThreadId: commandTarget.contextThreadId }),
                ...(commandTarget.contextThreadTitle === undefined
                  ? {}
                  : { contextThreadTitle: commandTarget.contextThreadTitle }),
                ...(commandTarget.contextThreadId === undefined
                  ? {}
                  : { referenceThreadId: commandTarget.contextThreadId }),
              }
            : {}),
      }
    : null;
  currentTargetRef.current = target;
  const targetTitle = target?.projectTitle ?? catalogProject?.title ?? activeProject?.title;
  const targetNode = catalog?.nodes.find((node) => node.nodeId === target?.projectRef.nodeId);
  const targetProviderId = selectedTask?.task.modelSelection.instanceId;
  const targetProvider = catalog?.providers.find(
    (provider) =>
      provider.nodeId === target?.projectRef.nodeId &&
      provider.snapshot.instanceId === targetProviderId,
  );
  const targetDisplayTitle = target?.contextThreadTitle ?? targetTitle;
  const targetProjectTitle = catalogProject?.title ?? activeProject?.title;
  const targetProviderLabel =
    targetProvider?.snapshot.displayName ?? targetProvider?.snapshot.driver;
  const targetPresentation = jarvisSelectedTargetPresentation({
    ...(targetDisplayTitle ? { targetTitle: targetDisplayTitle } : {}),
    ...(targetProjectTitle ? { projectTitle: targetProjectTitle } : {}),
    ...(targetNode?.label ? { nodeLabel: targetNode.label } : {}),
    ...(targetProviderLabel ? { providerLabel: targetProviderLabel } : {}),
    ...(selectedTask === null ? {} : { taskState: selectedTask.task.state }),
  });
  const hasTarget = target !== null;
  const nativeVoiceBridge = window.desktopBridge?.jarvisVoice;
  const nativeVoice =
    nativeVoiceBridge !== undefined && desktopVoiceCanStartCapture(nativeVoiceState)
      ? nativeVoiceBridge
      : undefined;
  const desktopVoiceCapabilityPending =
    window.desktopBridge?.jarvisVoice !== undefined && nativeVoiceState === null;
  const speechAvailable =
    nativeVoice !== undefined ||
    (nativeVoiceBridge === undefined && speechRecognitionConstructor() !== null) ||
    (nativeVoiceBridge !== undefined &&
      nativeVoiceState?.native === false &&
      speechRecognitionConstructor() !== null);
  const nativeVoiceStatus = desktopVoiceStatusMessage(nativeVoiceState);
  if (nativeVoiceBridge === undefined) {
    nativeCaptureControllerRef.current = null;
  } else if (
    nativeCaptureControllerRef.current === null ||
    nativeCaptureControllerVoiceRef.current !== nativeVoiceBridge
  ) {
    nativeCaptureControllerVoiceRef.current = nativeVoiceBridge;
    nativeCaptureControllerRef.current = createJarvisNativeCaptureController({
      voice: nativeVoiceBridge,
      onPhase: (phase) => setListening(phase === "capturing"),
      onStartFailure: () =>
        setError("Native voice capture is unavailable. You can continue by typing."),
      onReleaseFailure: () => setError("Native voice capture could not stop."),
    });
  }
  const retryNativeVoice = useCallback(async () => {
    if (!desktopVoiceCanRetry(nativeVoiceState) || nativeVoiceBridge === undefined) return;
    setError(null);
    try {
      await nativeVoiceBridge.prepare();
      const refreshed = await nativeVoiceBridge.getState();
      setNativeVoiceState(refreshed);
      if (refreshed.status === "error") {
        setError(desktopVoiceStatusMessage(refreshed) ?? "Local voice failed to start.");
      }
    } catch {
      const refreshed = await nativeVoiceBridge.getState().catch(() => null);
      if (refreshed !== null) setNativeVoiceState(refreshed);
      setError(
        desktopVoiceStatusMessage(refreshed) ??
          "Local voice failed to start. Retry, or reinstall Jarvis if the problem continues.",
      );
    }
  }, [nativeVoiceBridge, nativeVoiceState]);

  useEffect(() => {
    if (!open) return;
    setCatalog(null);
    setTaskDesks([]);
    setTaskDesksPending(false);
    setSelectedProjectRef(null);
    setSelectedTask(null);
    setProjectCandidates(null);
    setError(null);
    let active = true;
    setCatalogPending(true);
    setCatalogError(null);
    void refreshMesh(undefined).then((result) => {
      if (!active) return;
      setCatalogPending(false);
      if (result._tag === "Failure") {
        setCatalogError(jarvisErrorMessage(squashAtomCommandFailure(result)));
        return;
      }
      setCatalog(result.value);
    });
    return () => {
      active = false;
    };
  }, [open, refreshMesh]);

  const catalogReady = jarvisManagerCatalogIsReady({
    catalogLoaded: catalog !== null,
    catalogPending,
    catalogError,
  });
  voiceSubmissionReadyRef.current = catalogReady && !submissionBusyRef.current;
  const targetCapabilities =
    targetNode === undefined ? null : jarvisManagerNodeCapabilities(targetNode);
  const headerState = jarvisManagerHeaderState({
    catalogReady,
    catalogPending,
    catalogError,
    hasTarget,
    targetExecutionAvailable: targetCapabilities?.execution === true,
  });

  useEffect(() => {
    if (!open || catalog === null) return;
    let active = true;
    const connectedNodes = catalog.nodes.filter((node) => node.reachability === "online");
    setTaskDesksPending(true);
    void Promise.all(
      connectedNodes.map(async (node) => {
        const result = await getTaskDesk({ nodeId: node.nodeId });
        return result._tag === "Success"
          ? {
              nodeId: node.nodeId,
              nodeLabel: node.label,
              focusedThreadId: result.value.focusedTask?.threadId ?? null,
              tasks: result.value.recentTasks,
            }
          : null;
      }),
    ).then((desks) => {
      if (!active) return;
      setTaskDesks(desks.filter((desk): desk is JarvisDeskNodeView => desk !== null));
      setTaskDesksPending(false);
    });
    return () => {
      active = false;
    };
  }, [catalog, getTaskDesk, open]);

  useEffect(() => {
    if (nativeVoiceBridge === undefined) return;
    nativeVoiceBridge.setRecognitionContext(
      catalog === null ? [] : jarvisRecognitionContextPhrases(catalog),
    );
    return () => nativeVoiceBridge.setRecognitionContext([]);
  }, [catalog, nativeVoiceBridge]);

  useEffect(() => {
    if (
      !voiceOnly ||
      catalog === null ||
      routeTarget !== null ||
      selectedProjectRef !== null ||
      selectedTask !== null
    ) {
      return;
    }
    const voiceTarget = resolveJarvisVoiceDefaultTarget({
      originNodeId: primaryEnvironmentId,
      nodes: catalog.nodes,
      projects: catalog.projects,
      taskDesks,
    });
    if (voiceTarget?.kind === "task") {
      setSelectedTask({ nodeId: voiceTarget.nodeId, task: voiceTarget.task });
    } else if (voiceTarget?.kind === "project") {
      setSelectedProjectRef(voiceTarget.projectRef);
    }
  }, [
    catalog,
    primaryEnvironmentId,
    routeTarget,
    selectedProjectRef,
    selectedTask,
    taskDesks,
    voiceOnly,
  ]);

  useEffect(() => {
    if (catalog === null) return;
    if (selectedProjectRef !== null || selectedTask !== null) return;
    if (routeTarget !== null) return;
    if (catalog.projects.length === 1) {
      setSelectedProjectRef(catalog.projects[0]!.ref);
    }
  }, [catalog, routeTarget, selectedProjectRef, selectedTask]);

  /* eslint-disable unicorn/prefer-add-event-listener -- Web Speech uses nullable handler properties across Chromium versions. */
  const releaseNativeCapture = useCallback(() => {
    nativeCaptureControllerRef.current?.release();
  }, []);

  const cancelNativeCapture = useCallback(() => {
    nativeCaptureControllerRef.current?.cancel();
  }, []);

  const releaseRecognition = useCallback(
    (abort: boolean) => {
      if (abort) cancelNativeCapture();
      else releaseNativeCapture();
      const recognition = recognitionRef.current;
      recognitionRef.current = null;
      if (recognition) {
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onend = null;
        if (abort) recognition.abort();
      }
      setListening(false);
    },
    [cancelNativeCapture, releaseNativeCapture],
  );

  useEffect(() => () => releaseRecognition(true), [releaseRecognition]);

  useEffect(() => {
    const voice = window.desktopBridge?.jarvisVoice;
    if (voice === undefined) return;
    let active = true;
    void voice.getState().then(
      (next) => {
        if (active) setNativeVoiceState((current) => current ?? next);
      },
      () => {
        if (active) {
          setNativeVoiceState({
            status: "unavailable",
            native: true,
            errorCode: "STATE_UNAVAILABLE",
          });
        }
      },
    );
    const enqueueVoiceTranscript = (input: {
      readonly captureId: string;
      readonly transcript: string;
      readonly sourceTranscript?: string;
      readonly requestId?: string;
      readonly target?: JarvisDialogTarget | null;
    }): void => {
      const existing = voiceSubmissionSnapshotsRef.current.get(input.captureId);
      if (existing === undefined || input.target !== undefined) {
        voiceSubmissionSnapshotsRef.current.set(input.captureId, {
          requestId: input.requestId ?? existing?.requestId ?? randomUUID(),
          target:
            input.target === undefined
              ? (existing?.target ?? currentTargetRef.current)
              : input.target,
        });
        while (voiceSubmissionSnapshotsRef.current.size > 128) {
          const oldest = voiceSubmissionSnapshotsRef.current.keys().next().value;
          if (oldest === undefined) break;
          voiceSubmissionSnapshotsRef.current.delete(oldest);
        }
      }
      const snapshot = voiceSubmissionSnapshotsRef.current.get(input.captureId);
      const enqueueResult = voiceSubmissionQueueRef.current?.enqueue({
        captureId: input.captureId,
        transcript: input.transcript,
        ...(input.sourceTranscript === undefined
          ? {}
          : { sourceTranscript: input.sourceTranscript }),
        ...(snapshot === undefined ? {} : { requestId: snapshot.requestId }),
      });
      if (enqueueResult === "enqueued") void voiceSubmissionQueueRef.current?.drain();
      else if (enqueueResult === "full") {
        const message = "Voice requests are backed up. Wait for one to finish, then try again.";
        setError(message);
        speakJarvisText(message);
      }
    };

    const unsubscribeTranscript = voice.onTranscript((transcript, event) => {
      if (!shouldSubmitJarvisVoiceTranscript(event?.purpose)) return;
      if (isJarvisVoiceGarbageTranscript(transcript)) {
        speakJarvisText("I couldn't hear you. Try that again.");
        setListening(false);
        return;
      }
      const captureId = event?.captureId ?? randomUUID();
      if (autoSubmitVoice) {
        const pendingClarification = voiceClarificationRef.current;
        if (pendingClarification !== null) {
          if (isJarvisVoiceClarificationDiscard(transcript)) {
            voiceClarificationRef.current = null;
            voiceSubmissionSnapshotsRef.current.delete(pendingClarification.captureId);
            setClarification(null);
            setProjectCandidates(null);
            setError(null);
            setVoiceRetryAvailable(false);
            const discarded =
              voiceSubmissionQueueRef.current?.discard(pendingClarification.captureId) === true;
            speakJarvisText(
              discarded
                ? "Okay, I discarded that request."
                : "That voice request was no longer pending.",
            );
            setListening(false);
            return;
          }
          voiceSubmissionQueueRef.current?.resume(pendingClarification.captureId, {
            captureId: pendingClarification.captureId,
            transcript,
            sourceTranscript: pendingClarification.sourceUtterance,
            requestId: pendingClarification.requestId,
          });
          setListening(false);
          return;
        }
        enqueueVoiceTranscript({
          captureId,
          transcript,
          sourceTranscript: transcript,
        });
      } else {
        setUtterance((current) => appendJarvisChoice(current, transcript));
        submitVoiceTranscriptRef.current = false;
      }
      setListening(false);
      requestAnimationFrame(() => textareaRef.current?.focus());
    });
    const unsubscribeState = voice.onState((next) => {
      setNativeVoiceState(next);
      if (next.status === "capturing") {
        setListening(true);
      }
      if (next.status === "ready" || next.status === "error") {
        if (next.status === "ready") {
          nativeCaptureControllerRef.current?.markWorkerReady();
          if (nativeCaptureControllerRef.current?.phase() !== "starting") setListening(false);
        } else {
          cancelNativeCapture();
          setListening(false);
        }
      }
    });
    const unsubscribeError = voice.onError((message) => {
      cancelNativeCapture();
      setListening(false);
      setError(message);
    });
    return () => {
      active = false;
      unsubscribeTranscript();
      unsubscribeState();
      unsubscribeError();
    };
  }, [autoSubmitVoice, cancelNativeCapture]);

  useEffect(() => {
    if (!initialUtterance) return;
    setUtterance(initialUtterance);
    submitVoiceTranscriptRef.current = true;
  }, [initialUtterance]);

  const resetAndClose = useCallback(() => {
    releaseRecognition(true);
    voiceSubmissionQueueRef.current?.clear();
    voiceSubmissionSnapshotsRef.current.clear();
    voiceClarificationRef.current = null;
    requestIdRef.current = null;
    requestFingerprintRef.current = null;
    setUtterance("");
    setClarification(null);
    setProjectCandidates(null);
    setSelectedProjectRef(null);
    setSelectedTask(null);
    setError(null);
    setVoiceRetryAvailable(false);
    onOpenChange(false);
  }, [onOpenChange, releaseRecognition]);

  const startNativeCapture = useCallback(() => {
    setError(null);
    if (nativeVoiceBridge !== undefined) {
      nativeVoiceBridge.setRecognitionContext(
        catalogRef.current === null ? [] : jarvisRecognitionContextPhrases(catalogRef.current),
      );
    }
    nativeCaptureControllerRef.current?.start();
  }, [nativeVoiceBridge]);

  const toggleListening = useCallback(() => {
    const voice = nativeVoice;
    if (voice !== undefined) {
      if (nativeCaptureControllerRef.current?.phase() === "capturing") releaseNativeCapture();
      else if (nativeCaptureControllerRef.current?.phase() === "idle") startNativeCapture();
      return;
    }
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      releaseRecognition(false);
      return;
    }
    const Recognition = speechRecognitionConstructor();
    if (!Recognition) return;
    const recognition = new Recognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = navigator.language || "en-US";
    recognition.onresult = (event) => {
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (!result?.isFinal) continue;
        setUtterance((current) => appendJarvisChoice(current, result[0].transcript));
        submitVoiceTranscriptRef.current = autoSubmitVoice;
        break;
      }
      recognition.stop();
      releaseRecognition(false);
      requestAnimationFrame(() => textareaRef.current?.focus());
    };
    recognition.onerror = () => {
      setError("Browser speech recognition stopped. You can continue by typing.");
      releaseRecognition(false);
    };
    recognition.onend = () => releaseRecognition(false);
    recognitionRef.current = recognition;
    setError(null);
    setListening(true);
    try {
      recognition.start();
    } catch (cause) {
      releaseRecognition(true);
      setError(jarvisErrorMessage(cause));
    }
  }, [autoSubmitVoice, nativeVoice, releaseNativeCapture, releaseRecognition, startNativeCapture]);
  /* eslint-enable unicorn/prefer-add-event-listener */

  useEffect(() => {
    if (!open || desktopVoiceCapabilityPending || voiceStartRequest === 0) {
      return;
    }
    if (nativeVoice !== undefined) startNativeCapture();
    else if (nativeVoiceBridge !== undefined) {
      setError("Native voice capture is unavailable. You can continue by typing.");
    }
    onVoiceStartConsumed?.();
  }, [
    desktopVoiceCapabilityPending,
    nativeVoice,
    nativeVoiceBridge,
    onVoiceStartConsumed,
    open,
    startNativeCapture,
    voiceStartRequest,
  ]);

  useEffect(() => {
    if (!open || desktopVoiceCapabilityPending || voiceReleaseRequest === 0) {
      return;
    }
    if (nativeVoice !== undefined) releaseNativeCapture();
    onVoiceReleaseConsumed?.();
  }, [
    desktopVoiceCapabilityPending,
    nativeVoice,
    onVoiceReleaseConsumed,
    open,
    releaseNativeCapture,
    voiceReleaseRequest,
  ]);

  useEffect(() => {
    if (!open || desktopVoiceCapabilityPending || voiceToggleRequest === 0) {
      return;
    }
    void toggleListening();
    onVoiceToggleConsumed?.();
  }, [
    desktopVoiceCapabilityPending,
    onVoiceToggleConsumed,
    open,
    toggleListening,
    voiceToggleRequest,
  ]);

  const resolveVoiceModelAnswer = useCallback(
    (
      pending: NonNullable<typeof voiceClarificationRef.current>,
      answer: string,
    ): { readonly instruction: string; readonly selection: ModelSelection } | "paused" | null => {
      const reason = isJarvisModelClarificationReason(pending.clarification.reason);
      const catalog = catalogRef.current;
      if (reason === null || catalog === null) return null;
      const nodeId = pending.target?.projectRef.nodeId;
      const providers = (
        nodeId === undefined
          ? catalog.providers
          : catalog.providers.filter((provider) => provider.nodeId === nodeId)
      ).map((provider) => provider.snapshot);
      const result = answerJarvisModelChoice(providers, pending.modelDraft ?? {}, reason, answer);
      if (result.status === "no-match") return null;
      if (result.status === "need-choice") {
        const next: JarvisNeedsInput = {
          status: "needs-input",
          reason,
          prompt: result.prompt,
          choices: [...result.choices],
        };
        voiceClarificationRef.current = {
          ...pending,
          clarification: next,
          modelDraft: result.draft,
        };
        setClarification(next);
        setProjectCandidates(null);
        setError(null);
        speakJarvisText(result.prompt);
        return "paused";
      }
      return { instruction: pending.instruction, selection: result.selection };
    },
    [],
  );

  const submit = useCallback(
    async (voiceSubmission?: JarvisVoiceSubmission) => {
      const fromVoice = voiceSubmission !== undefined;
      const capturedInstruction = voiceSubmission?.transcript ?? utterance;
      const pendingVoiceClarification = fromVoice ? voiceClarificationRef.current : null;
      const voiceSnapshot =
        voiceSubmission === undefined
          ? null
          : voiceSubmissionSnapshotsRef.current.get(voiceSubmission.captureId);
      const pendingProjectChoice =
        pendingVoiceClarification?.projectCandidates === undefined || voiceSubmission === undefined
          ? null
          : resolveJarvisVoiceProjectChoice({
              instruction: pendingVoiceClarification.instruction,
              answer: capturedInstruction,
              candidates: pendingVoiceClarification.projectCandidates,
              acceptsAffirmation: pendingVoiceClarification.acceptsAffirmation === true,
            });
      // A typed model answer from the choice buttons travels in this ref with
      // the original utterance; voice answers resolve inline below.
      let modelSelectionOverride = pendingModelSelectionRef.current;
      let instruction: string;
      if (pendingProjectChoice?.instruction !== undefined) {
        instruction = pendingProjectChoice.instruction;
      } else if (
        pendingVoiceClarification !== null &&
        pendingVoiceClarification.projectCandidates === undefined
      ) {
        const modelAnswer = resolveVoiceModelAnswer(pendingVoiceClarification, capturedInstruction);
        if (modelAnswer === "paused") return "pause" as const;
        if (modelAnswer !== null) {
          instruction = modelAnswer.instruction;
          modelSelectionOverride = modelAnswer.selection;
        } else {
          instruction = applyJarvisClarificationChoice(
            pendingVoiceClarification.instruction,
            pendingVoiceClarification.clarification,
            capturedInstruction,
          );
        }
      } else {
        instruction = capturedInstruction.trim();
      }
      if (
        (fromVoice &&
          (submissionBusyRef.current || !catalogReady || instruction.trim().length === 0)) ||
        (!fromVoice &&
          !jarvisManagerCanSubmit({
            catalogReady,
            instruction,
            submitting: submitting || submissionBusyRef.current,
          }))
      ) {
        return;
      }
      if (
        fromVoice &&
        pendingVoiceClarification?.projectCandidates !== undefined &&
        pendingProjectChoice === null
      ) {
        const message = "I couldn't match that project. Say its name or give its number.";
        setError(message);
        speakJarvisText(message);
        return "pause" as const;
      }

      let submissionCatalog = catalog;
      if (fromVoice && pendingVoiceClarification === null) {
        // An already-selected target only needs its own node revalidated; a
        // slow unrelated node must not stall a qualified submission.
        const explicitNodeId = (voiceSnapshot?.target ?? target)?.projectRef.nodeId;
        const refreshed =
          explicitNodeId === undefined
            ? await refreshMesh(undefined)
            : await refreshMeshNode({ nodeId: explicitNodeId });
        if (refreshed._tag === "Failure") {
          const failure = squashAtomCommandFailure(refreshed);
          const message = jarvisErrorMessage(failure);
          setError(message);
          setVoiceRetryAvailable(true);
          speakJarvisText(message);
          throw failure;
        }
        submissionCatalog = refreshed.value;
        setCatalog(refreshed.value);
      }

      let groundedVoiceProject: JarvisMeshProject | undefined;
      if (fromVoice && pendingVoiceClarification === null && submissionCatalog !== null) {
        const grounding = groundJarvisVoiceProjectMention({
          transcript: instruction,
          projects: submissionCatalog.projects,
        });
        if (grounding.status === "needs-confirmation") {
          // A phonetic guess is not authority: pause for an explicit yes
          // exactly like a multi-candidate clarification.
          const requestId = voiceSubmission.requestId ?? voiceSnapshot?.requestId ?? randomUUID();
          const candidate = {
            ...grounding.project,
            label: `${grounding.project.title} — ${grounding.project.nodeLabel}`,
          };
          voiceClarificationRef.current = {
            instruction,
            sourceUtterance: voiceSubmission.sourceTranscript ?? capturedInstruction,
            clarification: {
              status: "needs-input",
              reason: "control-target-required",
              prompt: grounding.prompt,
              choices: [candidate.label],
            },
            projectCandidates: [candidate],
            acceptsAffirmation: true,
            target: voiceSnapshot?.target ?? target,
            captureId: voiceSubmission.captureId,
            requestId,
          };
          setProjectCandidates([candidate]);
          setError(null);
          speakJarvisText(grounding.prompt);
          return "pause" as const;
        }
        if (grounding.status === "needs-clarification") {
          const requestId = voiceSubmission.requestId ?? voiceSnapshot?.requestId ?? randomUUID();
          voiceClarificationRef.current = {
            instruction,
            sourceUtterance: voiceSubmission.sourceTranscript ?? capturedInstruction,
            clarification: {
              status: "needs-input",
              reason: "control-target-required",
              prompt: grounding.prompt,
              choices: grounding.candidates.map(({ label }) => label),
            },
            projectCandidates: grounding.candidates.map(({ project, label }) => ({
              ...project,
              label,
            })),
            target: voiceSnapshot?.target ?? target,
            captureId: voiceSubmission.captureId,
            requestId,
          };
          setProjectCandidates(
            grounding.candidates.map(({ project, label }) => ({ ...project, label })),
          );
          setError(null);
          speakJarvisText(grounding.prompt);
          return "pause" as const;
        }
        if (grounding.status === "resolved") {
          const coverage =
            submissionCatalog === null
              ? { complete: true, unavailableNodeLabels: [] as ReadonlyArray<string> }
              : jarvisMeshCatalogCoverage(submissionCatalog);
          if (!coverage.complete) {
            // The name matched here, but an unread node may hold the same
            // name: confirm explicitly instead of guessing.
            const requestId = voiceSubmission.requestId ?? voiceSnapshot?.requestId ?? randomUUID();
            const candidate = {
              ...grounding.mention.project,
              label: `${grounding.mention.project.title} — ${grounding.mention.project.nodeLabel}`,
            };
            const prompt =
              `${coverage.unavailableNodeLabels.join(", ")} ${coverage.unavailableNodeLabels.length === 1 ? "is" : "are"} unreachable, so I can't tell if the name is unique. ` +
              `Use ${candidate.label}?`;
            voiceClarificationRef.current = {
              instruction,
              sourceUtterance: voiceSubmission.sourceTranscript ?? capturedInstruction,
              clarification: {
                status: "needs-input",
                reason: "control-target-required",
                prompt,
                choices: [candidate.label],
              },
              projectCandidates: [candidate],
              acceptsAffirmation: true,
              target: voiceSnapshot?.target ?? target,
              captureId: voiceSubmission.captureId,
              requestId,
            };
            setProjectCandidates([candidate]);
            setError(null);
            speakJarvisText(prompt);
            return "pause" as const;
          }
          groundedVoiceProject = grounding.mention.project;
          instruction = grounding.mention.transcript;
        }
      }

      const chosenProject =
        pendingProjectChoice === null || pendingVoiceClarification?.projectCandidates === undefined
          ? undefined
          : pendingVoiceClarification.projectCandidates.find(
              (candidate) =>
                candidate.ref.nodeId === pendingProjectChoice.projectRef.nodeId &&
                candidate.ref.projectId === pendingProjectChoice.projectRef.projectId,
            );
      let submissionTarget: JarvisDialogTarget | null =
        pendingProjectChoice === null
          ? (pendingVoiceClarification?.target ?? voiceSnapshot?.target ?? target)
          : {
              projectRef: pendingProjectChoice.projectRef,
              ...(chosenProject === undefined ? {} : { projectTitle: chosenProject.title }),
            };
      if (groundedVoiceProject !== undefined) {
        submissionTarget = resolveJarvisVoiceMentionTarget({
          projectRef: groundedVoiceProject.ref,
          projectTitle: groundedVoiceProject.title,
          currentTarget: submissionTarget,
        });
      }
      if (!fromVoice && submissionCatalog !== null && pendingProjectChoice === null) {
        const explicit = resolveJarvisMeshInstructionProject(submissionCatalog, instruction);
        if (explicit.resolution.status === "needs-clarification") {
          setProjectCandidates(explicit.resolution.candidates);
          setError(null);
          speakJarvisText("I found more than one matching project. Which one should I use?");
          return "pause" as const;
        }
        if (explicit.resolution.status === "resolved") {
          const coverage = jarvisMeshCatalogCoverage(submissionCatalog);
          if (!coverage.complete) {
            const candidate = {
              ...explicit.resolution.project,
              label: `${explicit.resolution.project.title} — ${explicit.resolution.project.nodeLabel}`,
            };
            const prompt =
              `${coverage.unavailableNodeLabels.join(", ")} ${coverage.unavailableNodeLabels.length === 1 ? "is" : "are"} unreachable, so I can't tell if the name is unique. ` +
              `Which project should I use?`;
            setProjectCandidates([candidate]);
            setError(null);
            speakJarvisText(prompt);
            return "pause" as const;
          }
          setSelectedProjectRef(explicit.resolution.project.ref);
          const resolvedTarget = resolveJarvisVoiceMentionTarget({
            projectRef: explicit.resolution.project.ref,
            projectTitle: explicit.resolution.project.title,
            currentTarget: submissionTarget,
          });
          if (resolvedTarget.contextThreadId === undefined) setSelectedTask(null);
          submissionTarget = resolvedTarget;
        }
      }
      if (submissionTarget === null && submissionCatalog !== null) {
        const coverage = jarvisMeshCatalogCoverage(submissionCatalog);
        const onlyProject =
          submissionCatalog.projects.length === 1 && coverage.complete
            ? submissionCatalog.projects[0]
            : undefined;
        if (onlyProject !== undefined) {
          const project = onlyProject;
          setSelectedProjectRef(project.ref);
          submissionTarget = { projectRef: project.ref, projectTitle: project.title };
        } else {
          const candidates = submissionCatalog.projects.map((project) => ({
            ...project,
            label: `${project.title} — ${project.nodeLabel}`,
          }));
          if (fromVoice) {
            voiceClarificationRef.current = {
              instruction,
              sourceUtterance: voiceSubmission.sourceTranscript ?? instruction,
              clarification: {
                status: "needs-input",
                reason: "control-target-required",
                prompt: "Which project should I use? Say the project name with your instruction.",
                choices: candidates.map((candidate) => candidate.label),
              },
              projectCandidates: candidates,
              target: voiceSnapshot?.target ?? target,
              captureId: voiceSubmission?.captureId ?? randomUUID(),
              requestId: voiceSubmission?.requestId ?? voiceSnapshot?.requestId ?? randomUUID(),
            };
          }
          setProjectCandidates(candidates);
          setError(null);
          speakJarvisText(
            "Which project should I use? Say the project name with your instruction.",
          );
          return "pause" as const;
        }
      }
      if (submissionTarget === null) {
        const message = catalogPending
          ? "I'm still loading your registered projects. Try again in a moment."
          : "Choose a project before running.";
        setError(message);
        speakJarvisText(message);
        return fromVoice ? ("pause" as const) : undefined;
      }

      submissionBusyRef.current = true;
      setSubmitting(true);
      try {
        if (!fromVoice || voiceSubmissionQueueRef.current?.failed() === null) {
          setError(null);
        }
        setClarification(null);
        setProjectCandidates(null);
        const requestFingerprint = jarvisRequestFingerprint({
          utterance: instruction,
          projectRef: submissionTarget.projectRef,
          ...(submissionTarget.contextThreadId === undefined
            ? {}
            : { contextThreadId: submissionTarget.contextThreadId }),
          ...(submissionTarget.referenceThreadId === undefined
            ? {}
            : { referenceThreadId: submissionTarget.referenceThreadId }),
          ...(modelSelectionOverride === null ? {} : { modelSelection: modelSelectionOverride }),
        });
        const requestId = fromVoice
          ? (pendingVoiceClarification?.requestId ??
            voiceSubmission.requestId ??
            voiceSnapshot?.requestId ??
            randomUUID())
          : resolveJarvisRequestId({
              currentRequestId: requestIdRef.current,
              currentFingerprint: requestFingerprintRef.current,
              nextFingerprint: requestFingerprint,
              createRequestId: randomUUID,
            });
        if (!fromVoice) {
          requestIdRef.current = requestId;
          requestFingerprintRef.current = requestFingerprint;
        }
        let commandResult;
        try {
          if (fromVoice) {
            void playJarvisAcknowledgement();
            void window.desktopBridge?.jarvisVoice?.prepareSpeech().catch(() => undefined);
          }
          const execution = executeInstruction({
            kind: "control",
            projectRef: submissionTarget.projectRef,
            requestMetadata: buildJarvisRequestMetadata({
              requestId,
              originInteractionId: jarvisReporterIdentity(),
              originNodeId,
              ...(fromVoice ? { inputMode: "voice" } : {}),
              ...(fromVoice
                ? {
                    sourceUtterance:
                      pendingVoiceClarification?.sourceUtterance ??
                      voiceSubmission.sourceTranscript ??
                      capturedInstruction,
                  }
                : {}),
            }),
            ...(submissionTarget.contextThreadId
              ? { contextThreadId: submissionTarget.contextThreadId }
              : {}),
            ...(submissionTarget.referenceThreadId
              ? { referenceThreadId: submissionTarget.referenceThreadId }
              : {}),
            ...(modelSelectionOverride === null ? {} : { modelSelection: modelSelectionOverride }),
            utterance: instruction,
          });
          commandResult = await execution;
        } catch (cause) {
          const message = jarvisErrorMessage(cause);
          setError(message);
          speakJarvisText(message);
          if (fromVoice) {
            setVoiceRetryAvailable(true);
            throw cause;
          }
          return;
        }
        if (commandResult._tag === "Failure") {
          const message = jarvisErrorMessage(squashAtomCommandFailure(commandResult));
          setError(message);
          speakJarvisText(message);
          if (fromVoice) {
            setVoiceRetryAvailable(true);
            throw new Error(message);
          }
          return;
        }
        const result = commandResult.value;
        if (result.status === "needs-input") {
          const modelReason = isJarvisModelClarificationReason(result.reason);
          if (!fromVoice) {
            // Typed model answers resolve against the catalog with the
            // original wording; the draft tracks multi-step choices.
            modelDraftRef.current =
              modelReason === null
                ? null
                : { utterance: instruction, reason: modelReason, draft: {} };
          }
          if (fromVoice) {
            voiceSubmissionSnapshotsRef.current.delete(voiceSubmission.captureId);
            voiceClarificationRef.current = {
              instruction,
              sourceUtterance:
                pendingVoiceClarification?.sourceUtterance ??
                voiceSubmission.sourceTranscript ??
                instruction,
              clarification: result,
              target: submissionTarget,
              ...(pendingVoiceClarification?.captureId === undefined
                ? { captureId: voiceSubmission.captureId }
                : { captureId: pendingVoiceClarification.captureId }),
              requestId:
                pendingVoiceClarification?.requestId ??
                voiceSubmission.requestId ??
                voiceSnapshot?.requestId ??
                randomUUID(),
            };
          }
          setClarification(result);
          const feedback = jarvisExecutionFeedback(result);
          speakJarvisText(feedback.speech);
          requestAnimationFrame(() => textareaRef.current?.focus());
          return "pause" as const;
        }
        if (result.status === "acknowledged") {
          if (fromVoice) {
            voiceSubmissionSnapshotsRef.current.delete(voiceSubmission.captureId);
            if (pendingVoiceClarification?.captureId !== undefined) {
              voiceSubmissionSnapshotsRef.current.delete(pendingVoiceClarification.captureId);
            }
            if (pendingVoiceClarification !== null) voiceClarificationRef.current = null;
            if (voiceSubmissionQueueRef.current?.failed() === null) {
              setVoiceRetryAvailable(false);
            }
          }
          const feedback = jarvisExecutionFeedback(result);
          speakJarvisText(feedback.speech);
          if (!fromVoice) setUtterance("");
          pendingModelSelectionRef.current = null;
          modelDraftRef.current = null;
          onTargetConsumed();
          onOpenChange(false);
          if ("threadId" in result) {
            await onThreadStarted(submissionTarget.projectRef.nodeId, result.threadId);
          }
          if (!fromVoice) {
            requestIdRef.current = null;
            requestFingerprintRef.current = null;
          }
          return;
        }
        if (fromVoice) {
          voiceSubmissionSnapshotsRef.current.delete(voiceSubmission.captureId);
          if (pendingVoiceClarification?.captureId !== undefined) {
            voiceSubmissionSnapshotsRef.current.delete(pendingVoiceClarification.captureId);
          }
          if (pendingVoiceClarification !== null) voiceClarificationRef.current = null;
          if (voiceSubmissionQueueRef.current?.failed() === null) {
            setVoiceRetryAvailable(false);
          }
        }
        if (!fromVoice) setUtterance("");
        if (fromVoice) {
          const feedback = jarvisExecutionFeedback(result);
          speakJarvisText(feedback.speech);
        }
        pendingModelSelectionRef.current = null;
        modelDraftRef.current = null;
        onTargetConsumed();
        onOpenChange(false);
        if (!fromVoice) {
          requestIdRef.current = null;
          requestFingerprintRef.current = null;
        }
        await onThreadStarted(
          result.taskRef?.executionNodeId ?? submissionTarget.projectRef.nodeId,
          result.threadId,
        );
      } finally {
        submissionBusyRef.current = false;
        setSubmitting(false);
      }
    },
    [
      catalog,
      catalogPending,
      catalogReady,
      executeInstruction,
      onOpenChange,
      onTargetConsumed,
      onThreadStarted,
      originNodeId,
      refreshMesh,
      refreshMeshNode,
      resolveVoiceModelAnswer,
      submitting,
      target,
      utterance,
    ],
  );

  submitVoiceInstructionRef.current = (submission) => submit(submission);

  // Answer a typed provider/model/effort clarification with catalog data.
  // Returns true when the choice was consumed (submitted or restated as a
  // follow-up question); false falls back to editing the instruction text.
  const answerTypedModelChoice = (choice: string): boolean => {
    if (clarification === null || catalog === null) return false;
    const reason = isJarvisModelClarificationReason(clarification.reason);
    if (reason === null) return false;
    const stored = modelDraftRef.current;
    const draft =
      stored !== null && stored.utterance === utterance && stored.reason === reason
        ? stored.draft
        : {};
    const nodeId = target?.projectRef.nodeId;
    const providers = (
      nodeId === undefined
        ? catalog.providers
        : catalog.providers.filter((provider) => provider.nodeId === nodeId)
    ).map((provider) => provider.snapshot);
    const result = answerJarvisModelChoice(providers, draft, reason, choice);
    if (result.status === "no-match") return false;
    if (result.status === "need-choice") {
      modelDraftRef.current = { utterance, reason, draft: result.draft };
      setClarification({
        status: "needs-input",
        reason,
        prompt: result.prompt,
        choices: [...result.choices],
      });
      speakJarvisText(result.prompt);
      return true;
    }
    pendingModelSelectionRef.current = result.selection;
    modelDraftRef.current = null;
    setClarification(null);
    void submit();
    return true;
  };

  const retryVoiceSubmission = useCallback(async () => {
    const queue = voiceSubmissionQueueRef.current;
    if (queue === null || queue.failed() === null) return;
    setVoiceRetryAvailable(false);
    await queue.retryFailed();
    if (queue.failed() !== null) setVoiceRetryAvailable(true);
  }, []);

  useEffect(() => {
    if (!autoSubmitVoice || !voiceSubmissionReadyRef.current) return;
    void voiceSubmissionQueueRef.current?.drain();
  }, [autoSubmitVoice, catalogReady, target]);

  const submitVoiceClarification = useCallback((answer: string): boolean => {
    const pending = voiceClarificationRef.current;
    if (pending === null) return false;
    const resumed = voiceSubmissionQueueRef.current?.resume(pending.captureId, {
      captureId: pending.captureId,
      transcript: answer,
      sourceTranscript: pending.sourceUtterance,
      requestId: pending.requestId,
    });
    if (resumed !== "resumed") {
      voiceClarificationRef.current = null;
      setClarification(null);
      setProjectCandidates(null);
      const message = "That voice request is no longer pending. Please say it again.";
      setError(message);
      speakJarvisText(message);
    }
    return true;
  }, []);

  useEffect(() => {
    if (
      !autoSubmitVoice ||
      !submitVoiceTranscriptRef.current ||
      utterance.trim().length === 0 ||
      !catalogReady ||
      (target === null && (catalog === null || catalog.projects.length === 0)) ||
      submitting
    ) {
      return;
    }
    submitVoiceTranscriptRef.current = false;
    void submit();
  }, [autoSubmitVoice, catalog, catalogReady, submit, submitting, target, utterance]);

  const projectsByNode = useMemo(() => {
    if (catalog === null) return [];
    return catalog.nodes.map((node) => ({
      node,
      projects: catalog.projects.filter((project) => project.ref.nodeId === node.nodeId),
    }));
  }, [catalog]);

  const taskRows = useMemo(
    () =>
      taskDesks.flatMap((desk) =>
        jarvisManagementTasks(desk.tasks).map((task) => {
          const taskTarget = jarvisTaskExecutionTarget(task);
          const taskNodeLabel =
            catalog?.nodes.find((node) => node.nodeId === taskTarget.environmentId)?.label ??
            (taskTarget.environmentId === desk.nodeId ? desk.nodeLabel : "Execution node pending");
          const taskProjectLabel =
            catalog?.projects.find(
              (project) =>
                project.ref.nodeId === taskTarget.environmentId &&
                project.ref.projectId === taskTarget.projectId,
            )?.title ?? "Project pending";
          const taskProviderLabel =
            catalog?.providers.find(
              (provider) =>
                provider.nodeId === taskTarget.environmentId &&
                provider.snapshot.instanceId === task.modelSelection.instanceId,
            )?.snapshot.displayName ?? "Provider pending";
          return {
            ...desk,
            task,
            taskTarget,
            taskMetadata: `${taskProjectLabel} · ${taskProviderLabel} · ${taskNodeLabel} · ${jarvisTaskStateLabel(task.state)}`,
          };
        }),
      ),
    [catalog?.nodes, catalog?.projects, catalog?.providers, taskDesks],
  );
  const presenceMode = jarvisPresenceMode({
    listening,
    submitting,
    activeTaskState:
      taskRows.find(({ task }) =>
        ["running", "waiting-for-input", "waiting-for-approval"].includes(task.state),
      )?.task.state ?? null,
    error,
    nativeVoiceState,
  });

  const chooseProject = useCallback(
    (project: JarvisMeshProject) => {
      setSelectedProjectRef(project.ref);
      setSelectedTask(null);
      setProjectCandidates(null);
      setError(null);
      submitVoiceClarification(project.title);
    },
    [submitVoiceClarification],
  );

  const chooseTask = useCallback(
    (_nodeId: EnvironmentId, task: JarvisTaskDeskTaskView) => {
      const taskTarget = jarvisTaskExecutionTarget(task);
      setSelectedTask({ nodeId: taskTarget.environmentId, task });
      setSelectedProjectRef({
        nodeId: taskTarget.environmentId,
        projectId: taskTarget.projectId,
      });
      setProjectCandidates(null);
      setError(null);
      voiceClarificationRef.current = null;
      void focusTask({
        nodeId: taskTarget.environmentId,
        task: {
          threadId: task.threadId,
          taskRef: task.taskRef,
        },
      });
    },
    [focusTask],
  );

  const openFullSession = useCallback(
    async (_nodeId: EnvironmentId, task: JarvisTaskDeskTaskView) => {
      const sessionTarget = jarvisFullSessionTarget(task);
      resetAndClose();
      await onThreadStarted(sessionTarget.environmentId, sessionTarget.threadId);
    },
    [onThreadStarted, resetAndClose],
  );

  if (voiceOnly) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          releaseRecognition(true);
          if (!submitting) resetAndClose();
        }
      }}
    >
      <DialogPopup
        className="w-[calc(100vw-1rem)] max-w-2xl overflow-hidden rounded-xl border-border/70 bg-background/98 p-0 shadow-xl shadow-black/20"
        finalFocus={() => returnFocusRef.current ?? false}
        initialFocus={() => textareaRef.current}
      >
        <header className="border-b border-border/70 px-4 py-3.5 pr-11">
          <div className="flex min-w-0 items-center gap-3">
            <span className="relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/70 bg-muted/15">
              <img
                src={JARVIS_MARK_SRC}
                alt=""
                aria-hidden="true"
                className="size-full object-cover"
              />
              <span className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-info" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-baseline gap-2">
                <DialogTitle className="shrink-0 font-mono text-sm font-semibold leading-5 tracking-tight">
                  {JARVIS_BRAND_NAME}
                </DialogTitle>
                <span className="truncate font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                  {JARVIS_BRAND_TAGLINE}
                </span>
              </div>
              <p
                className={`mt-0.5 flex items-center gap-1.5 text-[11px] font-medium ${headerState.kind === "ready" ? "text-info-foreground" : "text-warning-foreground"}`}
              >
                <span
                  className={`size-1 rounded-full ${headerState.kind === "ready" ? "bg-info" : "bg-warning"}`}
                  aria-hidden="true"
                />
                {headerState.label}
              </p>
            </div>
            <div className="min-w-0 max-w-[45%] text-right font-mono text-[10px] uppercase tracking-[0.08em]">
              <p className="text-muted-foreground">Target</p>
              <p
                className={target ? "truncate text-foreground" : "text-warning-foreground"}
                aria-label={target?.contextThreadTitle ?? targetTitle}
              >
                {target?.contextThreadTitle ?? targetTitle ?? "No project"}
              </p>
            </div>
          </div>
          <div className="mt-2 flex items-center justify-between gap-3 border-t border-border/60 pt-2">
            <JarvisPresence mode={presenceMode} visible={open} />
            {nativeVoiceStatus ? (
              <span className="max-w-[45%] truncate text-right text-[11px] text-warning-foreground">
                {nativeVoiceStatus}
              </span>
            ) : null}
          </div>
          <DialogDescription className="sr-only">
            Route an instruction to a provider and model through your connected workspace.
          </DialogDescription>
        </header>

        <DialogPanel className="space-y-3 p-4">
          <section
            aria-labelledby="jarvis-selected-target"
            className="rounded-lg border border-border/60 bg-muted/5 px-3 py-2.5"
          >
            <p
              id="jarvis-selected-target"
              className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground"
            >
              Execution target
            </p>
            <p
              className="mt-1 truncate text-base font-medium"
              aria-label={targetPresentation.title}
            >
              {targetPresentation.title}
            </p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {target?.contextThreadTitle ??
                (selectedTask
                  ? jarvisTaskStateLabel(selectedTask.task.state)
                  : "Ready to route an instruction")}
            </p>
            <div className="mt-2 grid grid-cols-3 gap-2 border-t border-border/60 pt-2 text-[10px]">
              <div className="min-w-0">
                <span className="block font-mono uppercase tracking-[0.1em] text-muted-foreground">
                  Node
                </span>
                <span className="block truncate text-foreground/80">
                  {targetNode?.label ?? "Auto"}
                </span>
              </div>
              <div className="min-w-0">
                <span className="block font-mono uppercase tracking-[0.1em] text-muted-foreground">
                  Project
                </span>
                <span className="block truncate text-foreground/80">
                  {targetProjectTitle ?? "Choose one"}
                </span>
              </div>
              <div className="min-w-0">
                <span className="block font-mono uppercase tracking-[0.1em] text-muted-foreground">
                  Provider
                </span>
                <span className="block truncate text-foreground/80">
                  {targetProviderLabel ?? "Auto"}
                </span>
              </div>
            </div>
          </section>

          <Field className="gap-1.5">
            <div className="flex w-full items-center justify-between gap-2">
              <FieldLabel
                htmlFor="jarvis-instruction"
                className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground"
              >
                Instruction
              </FieldLabel>
              <div className="flex items-center gap-1.5">
                <span className="hidden font-mono text-[10px] text-muted-foreground sm:inline">
                  {navigator.platform.includes("Mac") ? "⌘" : "CTRL"}+ENTER TO RUN
                </span>
                {speechAvailable ? (
                  <Button
                    type="button"
                    variant={listening ? "secondary" : "ghost"}
                    size="icon-xs"
                    aria-label={
                      listening ? "Listening for your instruction" : "Speak an instruction"
                    }
                    aria-pressed={listening}
                    title={
                      listening
                        ? "Stop listening"
                        : "Speak your instruction. Jarvis starts the task after a final transcript. Audio processing depends on your browser and may use an online speech service."
                    }
                    onClick={toggleListening}
                    disabled={
                      !catalogReady ||
                      (target === null && (catalog === null || catalog.projects.length === 0))
                    }
                  >
                    {listening ? <SquareIcon /> : <MicIcon />}
                  </Button>
                ) : null}
                <span className="font-mono text-[9px] uppercase tracking-[0.08em] text-muted-foreground">
                  {nativeVoiceStatus
                    ? "unavailable"
                    : speechAvailable
                      ? listening
                        ? "listening"
                        : autoSubmitVoice
                          ? "tap to speak"
                          : "browser voice"
                      : "text only"}
                </span>
              </div>
            </div>
            <Textarea
              id="jarvis-instruction"
              ref={textareaRef}
              value={utterance}
              onChange={(event) => {
                setUtterance(event.target.value);
                // Edited wording invalidates a typed model answer and its draft.
                pendingModelSelectionRef.current = null;
                modelDraftRef.current = null;
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void submit();
                }
              }}
              placeholder="Use Codex Sol at high effort to review the current implementation…"
              aria-invalid={error ? true : undefined}
              className="min-h-24 rounded-lg border-border/80 bg-muted/8 font-mono dark:bg-black/8"
            />
            {nativeVoiceStatus ? (
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <p role="status" className="text-xs text-warning-foreground">
                  {nativeVoiceStatus}
                </p>
                {desktopVoiceCanRetry(nativeVoiceState) ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => void retryNativeVoice()}
                  >
                    Retry
                  </Button>
                ) : null}
              </div>
            ) : null}
          </Field>

          <details open={target === null} className="group border-b border-border/60 py-2">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground [&::-webkit-details-marker]:hidden">
              <span id="jarvis-devices-title">Devices</span>
              <span className="text-[9px] normal-case tracking-normal group-open:hidden">Show</span>
              <span className="hidden text-[9px] normal-case tracking-normal group-open:inline">
                Hide
              </span>
            </summary>
            <section aria-labelledby="jarvis-devices-title" className="mt-2 space-y-1.5">
              <div className="flex items-center justify-end gap-2">
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => onOpenConnections()}
                  >
                    Manage connections
                  </Button>
                </div>
              </div>
              {catalogPending && catalog === null ? (
                <p className="text-xs text-muted-foreground">Loading registered environments…</p>
              ) : catalog?.nodes.length ? (
                <div className="grid gap-1 sm:grid-cols-2">
                  {catalog.nodes.map((node) => {
                    const capabilities = jarvisManagerNodeCapabilities(node);
                    return (
                      <div
                        key={node.nodeId}
                        className="flex min-w-0 items-center justify-between gap-2 border border-border/50 bg-muted/5 px-2.5 py-2"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-xs font-medium">{node.label}</p>
                          <p className="font-mono text-[9px] uppercase tracking-[0.08em] text-muted-foreground">
                            <span
                              className={
                                node.reachability === "online"
                                  ? "text-success"
                                  : "text-warning-foreground"
                              }
                            >
                              {node.reachability}
                            </span>
                            {node.catalogError
                              ? ` · ${node.catalogErrorKind ?? "catalog unavailable"}`
                              : ` · ${capabilities?.preset ?? "capabilities unknown"}`}
                          </p>
                          <p className="truncate text-[10px] text-muted-foreground/80">
                            {node.catalogError ??
                              (capabilities === null
                                ? "Capabilities have not been verified."
                                : [
                                    capabilities.execution ? "execution" : "controller",
                                    capabilities.projects ? "projects" : null,
                                    capabilities.providers ? "providers" : null,
                                  ]
                                    .filter((value): value is string => value !== null)
                                    .join(" · "))}
                          </p>
                        </div>
                        <div className="flex shrink-0 gap-1">
                          {node.reachability !== "online" ? (
                            <Button
                              type="button"
                              size="xs"
                              variant="outline"
                              onClick={() => void retryEnvironment(node.nodeId)}
                            >
                              Reconnect
                            </Button>
                          ) : null}
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            onClick={() => onOpenConnections(node.nodeId, "rename")}
                          >
                            Rename
                          </Button>
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            onClick={() => onOpenConnections(node.nodeId, "remove")}
                          >
                            Remove
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">No paired environments yet.</p>
              )}
              {catalogError ? (
                <p role="alert" className="text-xs text-destructive-foreground">
                  {catalogError}
                </p>
              ) : null}
            </section>
          </details>

          <details open={target === null} className="group border-b border-border/60 py-2">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground [&::-webkit-details-marker]:hidden">
              <span id="jarvis-projects-title">Projects</span>
              <span className="text-[9px] normal-case tracking-normal group-open:hidden">Show</span>
              <span className="hidden text-[9px] normal-case tracking-normal group-open:inline">
                Hide
              </span>
            </summary>
            <section aria-labelledby="jarvis-projects-title" className="mt-2 space-y-1.5">
              <div className="flex items-center justify-end gap-2">
                {catalogPending ? <Spinner className="size-3" /> : null}
              </div>
              {projectsByNode.length > 0 ? (
                <div className="space-y-1">
                  {projectsByNode.map(({ node, projects }) => (
                    <div
                      key={node.nodeId}
                      className="border border-border/50 bg-muted/5 px-2.5 py-1.5"
                    >
                      <p className="font-mono text-[9px] uppercase tracking-[0.08em] text-muted-foreground">
                        {node.label}
                      </p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {projects.map((project) => {
                          const selected =
                            target?.projectRef.nodeId === project.ref.nodeId &&
                            target.projectRef.projectId === project.ref.projectId;
                          return (
                            <Button
                              key={`${project.ref.nodeId}:${project.ref.projectId}`}
                              type="button"
                              size="xs"
                              variant={selected ? "secondary" : "outline"}
                              onClick={() => chooseProject(project)}
                              title={project.workspaceRoot}
                            >
                              {project.title}
                            </Button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Connect a device to load its projects.
                </p>
              )}
            </section>
          </details>

          <details className="group border-b border-border/60 py-2">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground [&::-webkit-details-marker]:hidden">
              <span id="jarvis-tasks-title">Recent tasks</span>
              <span className="text-[9px] normal-case tracking-normal group-open:hidden">Show</span>
              <span className="hidden text-[9px] normal-case tracking-normal group-open:inline">
                Hide
              </span>
            </summary>
            <section aria-labelledby="jarvis-tasks-title" className="mt-2 space-y-1.5">
              {taskDesksPending ? (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Spinner className="size-3" /> Loading recent tasks…
                </p>
              ) : taskRows.length > 0 ? (
                <div className="space-y-1">
                  {taskRows.map(({ nodeId, task, taskMetadata }) => (
                    <div
                      key={`${nodeId}:${task.threadId}`}
                      className="flex min-w-0 w-full items-center gap-1 border border-border/50 bg-muted/5 p-1"
                    >
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-sm px-1.5 py-1 text-left hover:bg-muted/25"
                        onClick={() => chooseTask(nodeId, task)}
                      >
                        <span className="min-w-0 flex-1 truncate text-xs">{task.title}</span>
                        <span
                          className="min-w-0 max-w-[58%] truncate text-right font-mono text-[9px] uppercase text-muted-foreground"
                          aria-label={taskMetadata}
                        >
                          {taskMetadata}
                        </span>
                      </button>
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        onClick={() => void openFullSession(nodeId, task)}
                        title={`Open ${task.title} in the full session`}
                      >
                        <ExternalLinkIcon />
                        <span className="sr-only sm:not-sr-only">Open full session</span>
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">No recent tasks.</p>
              )}
            </section>
          </details>

          {projectCandidates ? (
            <section
              aria-live="polite"
              aria-labelledby="jarvis-project-clarification-title"
              className="rounded-lg border border-info/25 bg-info/5 px-3 py-2.5"
            >
              <h3 id="jarvis-project-clarification-title" className="text-xs font-semibold">
                Which project should receive this instruction?
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                The instruction stays unchanged; choose the execution node.
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {projectCandidates.map((project) => (
                  <Button
                    key={`${project.ref.nodeId}:${project.ref.projectId}`}
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() => chooseProject(project)}
                  >
                    {project.label}
                  </Button>
                ))}
              </div>
            </section>
          ) : null}

          {!target ? (
            <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-warning-foreground">
              Choose a project above, or name one with “In &lt;project&gt; …”
            </p>
          ) : null}

          {clarification ? (
            <section
              aria-live="polite"
              aria-labelledby="jarvis-clarification-title"
              className="rounded-lg border border-info/25 bg-info/5 px-3 py-2.5"
            >
              <h3 id="jarvis-clarification-title" className="text-xs font-semibold">
                Jarvis needs one detail
              </h3>
              <p className="mt-1 text-sm text-foreground/88">{clarification.prompt}</p>
              {clarification.choices.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Available choices">
                  {clarification.choices.map((choice) => (
                    <Button
                      key={choice}
                      size="xs"
                      variant="outline"
                      onClick={() => {
                        if (submitVoiceClarification(choice)) return;
                        if (answerTypedModelChoice(choice)) return;
                        setUtterance((current) =>
                          applyJarvisClarificationChoice(current, clarification, choice),
                        );
                        setClarification(null);
                        requestAnimationFrame(() => textareaRef.current?.focus());
                      }}
                    >
                      {choice}
                    </Button>
                  ))}
                </div>
              ) : null}
            </section>
          ) : null}

          {error ? (
            <div
              role="alert"
              className="rounded-md border border-destructive/25 bg-destructive/8 px-3 py-2 text-sm dark:bg-destructive/12"
            >
              <p className="font-medium text-destructive-foreground">Couldn’t start the task</p>
              <p className="mt-0.5 text-xs text-destructive-foreground/78">{error}</p>
              {voiceRetryAvailable ? (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  className="mt-2"
                  onClick={() => void retryVoiceSubmission()}
                >
                  Retry voice request
                </Button>
              ) : null}
            </div>
          ) : null}
        </DialogPanel>

        <div className="flex items-center justify-between gap-3 border-t border-border/70 px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="hidden font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground sm:inline">
              {clarification ? "Awaiting input" : error ? "Needs attention" : headerState.label}
            </span>
          </div>
          <Button
            type="button"
            size="sm"
            onClick={() => void submit()}
            disabled={
              !catalogReady ||
              (target === null && (catalog === null || catalog.projects.length === 0)) ||
              utterance.trim().length === 0 ||
              submitting
            }
          >
            {submitting ? <Spinner /> : <PlayIcon />}
            {submitting ? "Routing…" : "Run"}
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
