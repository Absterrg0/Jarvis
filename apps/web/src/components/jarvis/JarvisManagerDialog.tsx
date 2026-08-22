import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  resolveJarvisMeshInstructionProject,
  type JarvisMeshCatalog,
  type JarvisMeshProject,
  type JarvisMeshProjectCandidate,
} from "@t3tools/client-runtime/jarvis/mesh";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  JarvisExecutionStarted,
  JarvisNeedsInput,
  JarvisProjectRef,
  JarvisTaskDeskTask,
  JarvisTaskRef,
  ThreadId,
} from "@t3tools/contracts";
import { jarvisNodeCapabilitiesForPreset } from "@t3tools/contracts";
import { AudioLinesIcon, ExternalLinkIcon, MicIcon, PlayIcon, SquareIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { JarvisAttentionTarget, JarvisCommandTarget } from "../../jarvisBus";
import { jarvisReporterIdentity } from "../../jarvisIdentity";
import { randomUUID } from "../../lib/utils";
import { isPreferredJarvisSpeaker, setPreferredJarvisSpeaker } from "../../jarvisPreferences";
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
import {
  appendJarvisChoice,
  applyJarvisClarificationChoice,
  buildJarvisRequestMetadata,
  jarvisFullSessionTarget,
  jarvisManagementTasks,
  jarvisRequestFingerprint,
  jarvisErrorMessage,
  jarvisTaskStateLabel,
  jarvisTaskStartedText,
  resolveJarvisRequestId,
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
  readonly attentionTarget: JarvisAttentionTarget | null;
  readonly routeTarget: JarvisCommandTarget | null;
  readonly onTargetConsumed: () => void;
  readonly onThreadStarted: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) => Promise<void> | void;
  readonly onOpenConnections: (environmentId?: EnvironmentId, action?: "rename" | "remove") => void;
  readonly onOpenOnboarding: () => void;
  readonly autoSubmitVoice?: boolean;
  readonly companionMode?: boolean;
  readonly initialUtterance?: string | null;
}

function speakTaskStarted(result: JarvisExecutionStarted): void {
  const text = jarvisTaskStartedText(result.modelSelection);
  if (window.jarvisCompanion?.speak) {
    void window.jarvisCompanion.speak(text);
    return;
  }
  if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = navigator.language || "en-US";
  window.speechSynthesis.speak(utterance);
}

function reportCompanionStatus(state: string, detail: string, kind: string): void {
  void window.jarvisCompanion?.taskStatus(state, detail, kind);
}

interface JarvisTaskDeskView {
  readonly nodeId: EnvironmentId;
  readonly nodeLabel: string;
  readonly tasks: ReadonlyArray<JarvisTaskDeskTask>;
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
  attentionTarget,
  routeTarget,
  onTargetConsumed,
  onThreadStarted,
  onOpenConnections,
  onOpenOnboarding,
  autoSubmitVoice = false,
  companionMode = false,
  initialUtterance = null,
}: JarvisManagerDialogProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // Companion is a controller-only interaction surface until it owns a node identity.
  const originNodeId = companionMode ? null : primaryEnvironmentId;
  const executeInstruction = useAtomCommand(jarvisMeshEnvironment.execute, {
    reportFailure: false,
    reportDefect: false,
  });
  const refreshMesh = useAtomCommand(jarvisMeshEnvironment.refresh, {
    reportFailure: false,
    reportDefect: false,
  });
  const getTaskDesk = useAtomCommand(jarvisMeshEnvironment.getTaskDesk, {
    reportFailure: false,
    reportDefect: false,
  });
  const navigateTaskDesk = useAtomCommand(jarvisMeshEnvironment.navigateTaskDesk, {
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
  const [utterance, setUtterance] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [listening, setListening] = useState(false);
  const [clarification, setClarification] = useState<JarvisNeedsInput | null>(null);
  const [projectCandidates, setProjectCandidates] =
    useState<ReadonlyArray<JarvisMeshProjectCandidate> | null>(null);
  const [catalog, setCatalog] = useState<JarvisMeshCatalog | null>(null);
  const [catalogPending, setCatalogPending] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [taskDesks, setTaskDesks] = useState<ReadonlyArray<JarvisTaskDeskView>>([]);
  const [selectedProjectRef, setSelectedProjectRef] = useState<JarvisProjectRef | null>(null);
  const [selectedTask, setSelectedTask] = useState<{
    readonly nodeId: EnvironmentId;
    readonly task: JarvisTaskDeskTask;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preferredSpeaker, setPreferredSpeakerState] = useState(isPreferredJarvisSpeaker);
  const submitVoiceTranscriptRef = useRef(false);
  const companionListeningStartedRef = useRef(false);

  const commandTarget: JarvisCommandTarget | null = attentionTarget
    ? {
        environmentId: attentionTarget.taskRef?.executionNodeId ?? attentionTarget.environmentId,
        projectId: attentionTarget.taskRef?.projectId ?? attentionTarget.projectId,
        contextThreadId: attentionTarget.threadId,
        contextThreadTitle: attentionTarget.threadTitle,
        ...(attentionTarget.taskRef === undefined ? {} : { taskRef: attentionTarget.taskRef }),
      }
    : routeTarget;
  const targetProjectRef = useMemo(() => {
    if (attentionTarget) {
      return scopeProjectRef(
        attentionTarget.taskRef?.executionNodeId ?? attentionTarget.environmentId,
        attentionTarget.taskRef?.projectId ?? attentionTarget.projectId,
      );
    }
    if (selectedTask) {
      return scopeProjectRef(
        selectedTask.task.taskRef?.executionNodeId ?? selectedTask.nodeId,
        selectedTask.task.projectId,
      );
    }
    if (selectedProjectRef) {
      return scopeProjectRef(selectedProjectRef.nodeId, selectedProjectRef.projectId);
    }
    return commandTarget
      ? scopeProjectRef(commandTarget.environmentId, commandTarget.projectId)
      : null;
  }, [attentionTarget, commandTarget, selectedProjectRef, selectedTask]);
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
        ...(attentionTarget
          ? {
              contextThreadId: attentionTarget.threadId,
              contextThreadTitle: attentionTarget.threadTitle,
              ...(attentionTarget.taskRef?.remoteThreadId === undefined
                ? { referenceThreadId: attentionTarget.threadId }
                : { referenceThreadId: attentionTarget.taskRef.remoteThreadId }),
              ...(attentionTarget.taskRef === undefined
                ? {}
                : { taskRef: attentionTarget.taskRef }),
            }
          : selectedTask
            ? {
                contextThreadId: selectedTask.task.threadId,
                contextThreadTitle: selectedTask.task.title,
                referenceThreadId:
                  selectedTask.task.taskRef?.remoteThreadId ?? selectedTask.task.threadId,
                ...(selectedTask.task.taskRef === undefined
                  ? {}
                  : { taskRef: selectedTask.task.taskRef }),
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
  const targetTitle = target?.projectTitle ?? catalogProject?.title ?? activeProject?.title;
  const hasTarget = target !== null;
  const speechAvailable = !companionMode && speechRecognitionConstructor() !== null;

  useEffect(() => {
    if (!open) return;
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

  useEffect(() => {
    if (!open || catalog === null) return;
    let active = true;
    const connectedNodes = catalog.nodes.filter((node) => node.reachability === "online");
    void Promise.all(
      connectedNodes.map(async (node) => {
        const result = await getTaskDesk({ nodeId: node.nodeId });
        return result._tag === "Success"
          ? { nodeId: node.nodeId, nodeLabel: node.label, tasks: result.value.recentTasks }
          : null;
      }),
    ).then((desks) => {
      if (!active) return;
      setTaskDesks(desks.filter((desk): desk is JarvisTaskDeskView => desk !== null));
    });
    return () => {
      active = false;
    };
  }, [catalog, getTaskDesk, open]);

  useEffect(() => {
    if (catalog === null || attentionTarget !== null) return;
    if (selectedProjectRef !== null || selectedTask !== null) return;
    if (routeTarget !== null) return;
    if (catalog.projects.length === 1) {
      setSelectedProjectRef(catalog.projects[0]!.ref);
    }
  }, [attentionTarget, catalog, routeTarget, selectedProjectRef, selectedTask]);

  /* eslint-disable unicorn/prefer-add-event-listener -- Web Speech uses nullable handler properties across Chromium versions. */
  const releaseRecognition = useCallback((abort: boolean) => {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (recognition) {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      if (abort) recognition.abort();
    }
    setListening(false);
  }, []);

  useEffect(() => () => releaseRecognition(true), [releaseRecognition]);

  useEffect(() => {
    if (!initialUtterance) return;
    setUtterance(initialUtterance);
    submitVoiceTranscriptRef.current = true;
  }, [initialUtterance]);

  const resetAndClose = useCallback(() => {
    releaseRecognition(true);
    requestIdRef.current = null;
    requestFingerprintRef.current = null;
    setUtterance("");
    setClarification(null);
    setProjectCandidates(null);
    setSelectedProjectRef(null);
    setSelectedTask(null);
    setError(null);
    onOpenChange(false);
  }, [onOpenChange, releaseRecognition]);

  const toggleListening = useCallback(() => {
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
  }, [autoSubmitVoice, releaseRecognition]);
  /* eslint-enable unicorn/prefer-add-event-listener */

  useEffect(() => {
    if (!open) {
      companionListeningStartedRef.current = false;
      return;
    }
    if (
      !companionMode ||
      companionListeningStartedRef.current ||
      !hasTarget ||
      listening ||
      submitting ||
      utterance.trim().length > 0
    ) {
      return;
    }
    companionListeningStartedRef.current = true;
    const frame = requestAnimationFrame(toggleListening);
    return () => cancelAnimationFrame(frame);
  }, [companionMode, hasTarget, listening, open, submitting, toggleListening, utterance]);

  const submit = useCallback(async () => {
    const instruction = utterance.trim();
    if (instruction.length === 0 || submitting) return;

    let submissionTarget = target;
    if (attentionTarget === null && catalog !== null) {
      const explicit = resolveJarvisMeshInstructionProject(catalog, instruction);
      if (explicit.resolution.status === "needs-clarification") {
        setProjectCandidates(explicit.resolution.candidates);
        setError(null);
        return;
      }
      if (explicit.resolution.status === "resolved") {
        setSelectedProjectRef(explicit.resolution.project.ref);
        setSelectedTask(null);
        submissionTarget = {
          projectRef: explicit.resolution.project.ref,
          projectTitle: explicit.resolution.project.title,
        };
      }
    }
    if (submissionTarget === null && catalog !== null) {
      if (catalog.projects.length === 1) {
        const project = catalog.projects[0]!;
        setSelectedProjectRef(project.ref);
        submissionTarget = { projectRef: project.ref, projectTitle: project.title };
      } else {
        setProjectCandidates(
          catalog.projects.map((project) => ({
            ...project,
            label: `${project.title} — ${project.nodeLabel}`,
          })),
        );
        setError(null);
        return;
      }
    }
    if (!submissionTarget) {
      setError(
        catalogPending ? "Loading registered projects…" : "Choose a project before running.",
      );
      return;
    }
    setSubmitting(true);
    setError(null);
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
    });
    const requestId = resolveJarvisRequestId({
      currentRequestId: requestIdRef.current,
      currentFingerprint: requestFingerprintRef.current,
      nextFingerprint: requestFingerprint,
      createRequestId: randomUUID,
    });
    requestIdRef.current = requestId;
    requestFingerprintRef.current = requestFingerprint;
    const commandResult = await executeInstruction({
      projectRef: submissionTarget.projectRef,
      requestMetadata: buildJarvisRequestMetadata({
        requestId,
        originInteractionId: jarvisReporterIdentity(),
        originNodeId,
      }),
      ...(submissionTarget.contextThreadId
        ? { contextThreadId: submissionTarget.contextThreadId }
        : {}),
      ...(submissionTarget.referenceThreadId
        ? { referenceThreadId: submissionTarget.referenceThreadId }
        : {}),
      utterance: instruction,
    });
    setSubmitting(false);
    if (commandResult._tag === "Failure") {
      const message = jarvisErrorMessage(squashAtomCommandFailure(commandResult));
      setError(message);
      if (companionMode) reportCompanionStatus("Could not start", message, "error");
      return;
    }
    const result = commandResult.value;
    if (result.status === "needs-input") {
      setClarification(result);
      if (companionMode) reportCompanionStatus("Need one detail", result.prompt, "error");
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }
    if (result.status === "acknowledged") {
      if (companionMode) reportCompanionStatus("Jarvis", result.message, "completed");
      setUtterance("");
      onTargetConsumed();
      onOpenChange(false);
      if ("threadId" in result) {
        await onThreadStarted(submissionTarget.projectRef.nodeId, result.threadId);
      }
      requestIdRef.current = null;
      requestFingerprintRef.current = null;
      return;
    }
    if (companionMode) {
      const text = jarvisTaskStartedText(result.modelSelection);
      reportCompanionStatus("Working on it", text, "started");
      speakTaskStarted(result);
    }
    setUtterance("");
    onTargetConsumed();
    onOpenChange(false);
    requestIdRef.current = null;
    requestFingerprintRef.current = null;
    await onThreadStarted(
      result.taskRef?.executionNodeId ?? submissionTarget.projectRef.nodeId,
      result.threadId,
    );
  }, [
    attentionTarget,
    catalog,
    catalogPending,
    executeInstruction,
    onOpenChange,
    onTargetConsumed,
    companionMode,
    onThreadStarted,
    originNodeId,
    setSelectedTask,
    submitting,
    target,
    utterance,
  ]);

  useEffect(() => {
    if (
      !autoSubmitVoice ||
      !submitVoiceTranscriptRef.current ||
      utterance.trim().length === 0 ||
      (target === null && (catalog === null || catalog.projects.length === 0)) ||
      submitting
    ) {
      return;
    }
    submitVoiceTranscriptRef.current = false;
    void submit();
  }, [autoSubmitVoice, catalog, submit, submitting, target, utterance]);

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
        jarvisManagementTasks(desk.tasks).map((task) => ({ ...desk, task })),
      ),
    [taskDesks],
  );

  const chooseProject = useCallback((project: JarvisMeshProject) => {
    setSelectedProjectRef(project.ref);
    setSelectedTask(null);
    setProjectCandidates(null);
    setError(null);
  }, []);

  const chooseTask = useCallback(
    (nodeId: EnvironmentId, task: JarvisTaskDeskTask) => {
      const taskNodeId = task.taskRef?.executionNodeId ?? nodeId;
      setSelectedTask({ nodeId: taskNodeId, task });
      setSelectedProjectRef({ nodeId: taskNodeId, projectId: task.projectId });
      setProjectCandidates(null);
      setError(null);
      void navigateTaskDesk({
        nodeId: taskNodeId,
        navigation: {
          action: "focus",
          threadId: task.threadId,
          ...(task.taskRef === undefined ? {} : { taskRef: task.taskRef }),
        },
      });
    },
    [navigateTaskDesk],
  );

  const openFullSession = useCallback(
    async (nodeId: EnvironmentId, task: JarvisTaskDeskTask) => {
      const sessionTarget = jarvisFullSessionTarget(nodeId, task);
      resetAndClose();
      await onThreadStarted(sessionTarget.environmentId, sessionTarget.threadId);
    },
    [onThreadStarted, resetAndClose],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !submitting) resetAndClose();
      }}
    >
      <DialogPopup
        className="w-full max-w-xl overflow-hidden rounded-xl border-border/80 p-0"
        finalFocus={() => returnFocusRef.current ?? false}
        initialFocus={() => textareaRef.current}
      >
        <header className="border-b border-border/65 bg-muted/18 px-4 py-3.5 pr-11">
          <div className="flex min-w-0 items-center gap-3">
            <span className="relative flex size-7 shrink-0 items-center justify-center rounded-md border border-info/30 bg-info/8 text-info-foreground">
              <AudioLinesIcon className="size-3.5" />
              <span className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-info shadow-[0_0_0_2px_var(--popover)]" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-baseline gap-2">
                <DialogTitle className="shrink-0 font-mono text-sm font-semibold leading-5 tracking-tight">
                  JARVIS
                </DialogTitle>
                <span className="truncate font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                  command relay
                </span>
              </div>
              <p className="mt-0.5 flex items-center gap-1.5 text-[11px] font-medium text-info-foreground">
                <span className="size-1 rounded-full bg-info" aria-hidden="true" />
                T3 is managing
              </p>
            </div>
            <div className="min-w-0 max-w-[45%] text-right font-mono text-[10px] uppercase tracking-[0.08em]">
              <p className="text-muted-foreground">Target</p>
              <p
                className={target ? "truncate text-foreground" : "text-warning-foreground"}
                title={target?.contextThreadTitle ?? targetTitle}
              >
                {target?.contextThreadTitle ?? targetTitle ?? "No project"}
              </p>
            </div>
          </div>
          <DialogDescription className="sr-only">
            Route an instruction to a provider and model through T3.
          </DialogDescription>
        </header>

        <DialogPanel className="space-y-3 p-4">
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
                      submitting ||
                      (target === null && (catalog === null || catalog.projects.length === 0))
                    }
                  >
                    {listening ? <SquareIcon /> : <MicIcon />}
                  </Button>
                ) : null}
                <span className="font-mono text-[9px] uppercase tracking-[0.08em] text-muted-foreground">
                  {speechAvailable
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
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void submit();
                }
              }}
              placeholder="Use Codex Sol at high effort to review the current implementation…"
              disabled={submitting}
              aria-invalid={error ? true : undefined}
              className="rounded-md border-border/85 bg-muted/12 font-mono shadow-inner shadow-black/3 before:rounded-[calc(var(--radius-md)-1px)] dark:bg-black/12"
            />
          </Field>

          <section aria-labelledby="jarvis-devices-title" className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <h3
                id="jarvis-devices-title"
                className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground"
              >
                Devices
              </h3>
              <div className="flex items-center gap-1">
                <Button type="button" size="xs" variant="ghost" onClick={onOpenOnboarding}>
                  Setup guide
                </Button>
                <Button type="button" size="xs" variant="ghost" onClick={() => onOpenConnections()}>
                  Pair / manage
                </Button>
              </div>
            </div>
            {catalogPending && catalog === null ? (
              <p className="text-xs text-muted-foreground">Loading registered environments…</p>
            ) : catalog?.nodes.length ? (
              <div className="grid gap-1 sm:grid-cols-2">
                {catalog.nodes.map((node) => {
                  // Servers predating Jarvis capability advertisements remain visible.
                  const capabilities = node.capabilities ?? jarvisNodeCapabilitiesForPreset("full");
                  return (
                    <div
                      key={node.nodeId}
                      className="flex min-w-0 items-center justify-between gap-2 rounded-md border border-border/70 bg-muted/12 px-2.5 py-2"
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
                          {` · ${capabilities.preset}`}
                          {node.catalogError ? " · catalog unavailable" : ""}
                        </p>
                        <p className="truncate text-[10px] text-muted-foreground/80">
                          {[
                            capabilities.execution ? "execution" : "controller",
                            capabilities.projects ? "projects" : null,
                            capabilities.providers ? "providers" : null,
                          ]
                            .filter((value): value is string => value !== null)
                            .join(" · ")}
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
              <p className="text-xs text-destructive-foreground">{catalogError}</p>
            ) : null}
          </section>

          <section aria-labelledby="jarvis-projects-title" className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <h3
                id="jarvis-projects-title"
                className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground"
              >
                Projects
              </h3>
              {catalogPending ? <Spinner className="size-3" /> : null}
            </div>
            {projectsByNode.length > 0 ? (
              <div className="space-y-1">
                {projectsByNode.map(({ node, projects }) => (
                  <div
                    key={node.nodeId}
                    className="rounded-md border border-border/60 px-2.5 py-1.5"
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
                            disabled={attentionTarget !== null}
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

          <section aria-labelledby="jarvis-tasks-title" className="space-y-1.5">
            <h3
              id="jarvis-tasks-title"
              className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground"
            >
              Tasks
            </h3>
            {taskRows.length > 0 ? (
              <div className="space-y-1">
                {taskRows.map(({ nodeId, nodeLabel, task }) => (
                  <div
                    key={`${nodeId}:${task.threadId}`}
                    className="flex w-full items-center gap-1 rounded-md border border-border/60 p-1"
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-sm px-1.5 py-1 text-left hover:bg-muted/25"
                      onClick={() => chooseTask(nodeId, task)}
                    >
                      <span className="min-w-0 truncate text-xs">{task.title}</span>
                      <span className="shrink-0 font-mono text-[9px] uppercase text-muted-foreground">
                        {catalog?.projects.find(
                          (project) =>
                            project.ref.nodeId === nodeId &&
                            project.ref.projectId === task.projectId,
                        )?.title ?? task.projectId}
                        {" · "}
                        {catalog?.providers.find(
                          (provider) =>
                            provider.nodeId === nodeId &&
                            provider.snapshot.instanceId === task.taskRef?.providerId,
                        )?.snapshot.displayName ?? "provider pending"}
                        {" · "}
                        {nodeLabel} · {jarvisTaskStateLabel(task.state)}
                      </span>
                    </button>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      onClick={() => void openFullSession(nodeId, task)}
                      title={`Open ${task.title} in the full T3 session`}
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

          {projectCandidates ? (
            <section
              aria-live="polite"
              aria-labelledby="jarvis-project-clarification-title"
              className="rounded-md border border-info/20 bg-info/6 px-3 py-2.5"
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
              className="rounded-md border border-info/20 bg-info/6 px-3 py-2.5"
            >
              <h3 id="jarvis-clarification-title" className="text-xs font-semibold">
                T3 needs one detail
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
            </div>
          ) : null}
        </DialogPanel>

        <div className="flex items-center justify-between gap-3 border-t border-border/65 bg-muted/24 px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <Button
              type="button"
              size="xs"
              variant={preferredSpeaker ? "secondary" : "ghost"}
              aria-pressed={preferredSpeaker}
              title="Prefer this device when several connected devices can speak a report"
              onClick={() => {
                const next = !preferredSpeaker;
                setPreferredJarvisSpeaker(next);
                setPreferredSpeakerState(next);
              }}
            >
              <AudioLinesIcon />
              {preferredSpeaker ? "Voice device" : "Prefer voice here"}
            </Button>
            <span className="hidden font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground sm:inline">
              {clarification ? "Awaiting input" : error ? "Relay fault" : "Relay ready"}
            </span>
          </div>
          <Button
            type="button"
            size="sm"
            onClick={() => void submit()}
            disabled={
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
