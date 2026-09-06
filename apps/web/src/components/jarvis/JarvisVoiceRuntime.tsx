import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import {
  jarvisMeshCatalogCoverage,
  jarvisMeshNodeReadiness,
  type JarvisMeshProject,
  type JarvisMeshProjectCandidate,
} from "@t3tools/jarvis-client-runtime/jarvis/mesh";
import { buildJarvisClientCommandContext } from "@t3tools/jarvis-client-runtime/jarvis/commandContext";
import {
  answerJarvisModelChoice,
  isJarvisModelClarificationReason,
  type JarvisModelDraft,
} from "@t3tools/jarvis-core/modelChoice";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  JarvisExpectedReply,
  JarvisNeedsInput,
  JarvisProjectRef,
  JarvisTaskDeskTaskView,
  JarvisTaskPendingReply,
  JarvisTaskRef,
  ModelSelection,
  ThreadId,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { JarvisCommandTarget } from "../../jarvisBus";
import {
  onJarvisComposerCommand,
  onJarvisTargetRequest,
  publishJarvisCommandBusy,
  publishJarvisCommandFeedback,
  publishJarvisCommandPending,
  publishJarvisTargetSnapshot,
  type JarvisCommandFeedback,
  type JarvisComposerInputMode,
} from "../../jarvisBus";
import { jarvisReporterIdentity } from "../../jarvisIdentity";
import { randomUUID } from "../../lib/utils";
import { enqueueBrowserSpeech } from "./JarvisVoiceReporter.logic";
import { jarvisMeshEnvironment } from "../../state/jarvisMesh";
import { jarvisMeshCatalogAtom } from "../../state/jarvisMesh";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  groundJarvisVoiceProjectMention,
  jarvisRecognitionContextPhrases,
} from "./JarvisNativeCapture";
import {
  buildJarvisRequestMetadata,
  desktopVoiceAllowsBrowserFallback,
  jarvisErrorMessage,
  jarvisExecutionFeedback,
  resolveJarvisVoiceDefaultTarget,
  resolveJarvisVoiceMentionTarget,
  createJarvisVoiceSubmissionQueue,
  isJarvisVoiceClarificationDiscard,
  type JarvisCommandInputMode as SubmissionInputMode,
  type JarvisVoiceSubmission,
  resolveJarvisVoiceProjectChoice,
  shouldSubmitJarvisVoiceTranscript,
  isJarvisVoiceGarbageTranscript,
} from "./JarvisManager.logic";

interface JarvisVoiceRuntimeProps {
  readonly routeTarget: JarvisCommandTarget | null;
  readonly onTargetConsumed: () => void;
  readonly onThreadStarted: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) => Promise<void> | void;
  readonly onPendingChange?: (pending: boolean) => void;
}

function speakBrowserText(text: string): void {
  if (text.trim().length === 0) return;
  // Share the reporter playback lane instead of speaking straight at the
  // browser singleton: it serializes utterances and drops stale ones.
  void enqueueBrowserSpeech(text, `jarvis-interaction-${randomUUID()}`).catch(() => undefined);
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

/**
 * One visible feedback lane for every submission. Text entries stay visible
 * and never auto-speak; voice entries speak the same text aloud.
 */
function emitCommandFeedback(input: {
  readonly text: string;
  readonly kind: JarvisCommandFeedback["kind"];
  readonly inputMode: JarvisComposerInputMode;
  readonly captureId?: string;
  readonly requestId?: string;
  readonly speak?: boolean;
}): void {
  publishJarvisCommandFeedback({
    ...(input.captureId === undefined ? {} : { captureId: input.captureId }),
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    inputMode: input.inputMode,
    kind: input.kind,
    text: input.text,
  });
  if ((input.speak ?? true) && input.inputMode === "voice" && input.text.trim().length > 0) {
    speakJarvisText(input.text);
  }
}

interface JarvisDeskNodeView {
  readonly nodeId: EnvironmentId;
  readonly nodeLabel: string;
  readonly focusedThreadId: ThreadId | null;
  readonly tasks: ReadonlyArray<JarvisTaskDeskTaskView>;
}

/**
 * Narrow selected-task identity. The desk owns titles and lifecycle; the
 * runtime keeps only the node-qualified thread identity it needs to build
 * command context. Never fabricate provider/model data here.
 */
export interface JarvisSelectedTask {
  readonly projectRef: JarvisProjectRef;
  readonly threadId: ThreadId;
  readonly title?: string | undefined;
  readonly taskRef?: JarvisTaskRef | undefined;
  readonly pendingReply?: JarvisTaskPendingReply | null | undefined;
}

function toSelectedTask(input: {
  readonly projectRef: JarvisProjectRef;
  readonly threadId: ThreadId;
  readonly title?: string | undefined;
  readonly taskRef?: JarvisTaskRef | undefined;
  readonly pendingReply?: JarvisTaskPendingReply | null | undefined;
}): JarvisSelectedTask {
  return {
    projectRef: input.projectRef,
    threadId: input.threadId,
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.taskRef === undefined ? {} : { taskRef: input.taskRef }),
    ...(input.pendingReply === undefined ? {} : { pendingReply: input.pendingReply }),
  };
}

/**
 * Map a server needs-input answer pin onto the retained reply shape.
 * Approval stays approval; question input becomes a user-input reply.
 */
function retainedReplyPin(
  expectedReply: JarvisExpectedReply | null | undefined,
): JarvisTaskPendingReply | null | undefined {
  // Explicit null means the server saw no unique pending request: clear the
  // pin. Undefined means unknown: leave whatever the target holds.
  if (expectedReply === undefined) return undefined;
  if (expectedReply === null) return null;
  return {
    kind: expectedReply.kind === "approval" ? "approval" : "user-input",
    requestId: expectedReply.requestId,
  };
}

interface JarvisVoiceTarget {
  readonly projectRef: JarvisProjectRef;
  readonly projectTitle?: string;
  readonly contextThreadId?: ThreadId;
  readonly contextThreadTitle?: string;
  readonly referenceThreadId?: ThreadId;
  readonly taskRef?: JarvisTaskRef;
  readonly pendingReply?: JarvisTaskPendingReply | null;
}

interface JarvisPendingClarification {
  readonly instruction: string;
  readonly sourceUtterance: string;
  readonly clarification: JarvisNeedsInput;
  readonly target: JarvisVoiceTarget | null;
  readonly projectCandidates?: ReadonlyArray<JarvisMeshProjectCandidate>;
  readonly acceptsAffirmation?: boolean;
  readonly captureId: string;
  readonly requestId: string;
  readonly modelDraft?: JarvisModelDraft;
  readonly origin: "server" | "client";
  readonly inputMode: SubmissionInputMode;
}

/**
 * Answer pin for one target: recomputed from the shared helper so a stale
 * focused task or a project override never inherits the wrong pin. Null pins
 * an explicit snapshot of no unique pending request.
 */
function expectedReplyForTarget(
  candidate: JarvisVoiceTarget | null,
): JarvisExpectedReply | null | undefined {
  if (candidate?.contextThreadId === undefined || candidate === null) return undefined;
  const context = buildJarvisClientCommandContext({
    projectRef: candidate.projectRef,
    task: {
      threadId: candidate.contextThreadId,
      ...(candidate.taskRef === undefined ? {} : { taskRef: candidate.taskRef }),
      projectRef: candidate.projectRef,
      ...(candidate.pendingReply === undefined ? {} : { pendingReply: candidate.pendingReply }),
    },
  });
  return context.expectedReply;
}

export function JarvisVoiceRuntime({
  routeTarget,
  onTargetConsumed,
  onThreadStarted,
  onPendingChange,
}: JarvisVoiceRuntimeProps) {
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
  const currentTargetRef = useRef<JarvisVoiceTarget | null>(null);
  const voiceSubmissionSnapshotsRef = useRef(
    new Map<string, { readonly requestId: string; readonly target: JarvisVoiceTarget | null }>(),
  );
  const catalog = useAtomValue(jarvisMeshCatalogAtom);
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const [catalogPending, setCatalogPending] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [taskDesks, setTaskDesks] = useState<ReadonlyArray<JarvisDeskNodeView>>([]);
  const [selectedProjectRef, setSelectedProjectRef] = useState<JarvisProjectRef | null>(null);
  const [selectedTask, setSelectedTask] = useState<JarvisSelectedTask | null>(null);
  const selectedTaskRef = useRef<JarvisSelectedTask | null>(null);
  selectedTaskRef.current = selectedTask;
  // Bumped on every explicit target request so memoized target derivation
  // recomputes even when a ref flag is the only thing that changed.
  const [targetVersion, setTargetVersion] = useState(0);
  const submissionBusyRef = useRef(false);
  const userClearedTargetRef = useRef(false);
  const voiceClarificationRef = useRef<JarvisPendingClarification | null>(null);
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

  const syncPending = useCallback(() => {
    const pending =
      submissionBusyRef.current ||
      voiceClarificationRef.current !== null ||
      (voiceSubmissionQueueRef.current?.size() ?? 0) > 0;
    publishJarvisCommandPending(pending);
    publishJarvisCommandBusy(submissionBusyRef.current);
    onPendingChange?.(pending);
  }, [onPendingChange]);

  // Command context is owned by explicit selection and the current route.
  // Spoken reports never contribute: they are display-only. An explicit
  // clear leaves no target even when a local route is visible.
  const commandTarget: JarvisCommandTarget | null = routeTarget;
  const targetProjectRef = useMemo(() => {
    if (selectedTask) {
      return scopeProjectRef(selectedTask.projectRef.nodeId, selectedTask.projectRef.projectId);
    }
    if (selectedProjectRef) {
      return scopeProjectRef(selectedProjectRef.nodeId, selectedProjectRef.projectId);
    }
    if (userClearedTargetRef.current) return null;
    return commandTarget
      ? scopeProjectRef(commandTarget.environmentId, commandTarget.projectId)
      : null;
  }, [commandTarget, selectedProjectRef, selectedTask, targetVersion]);
  const target: JarvisVoiceTarget | null = targetProjectRef
    ? {
        projectRef: {
          nodeId: targetProjectRef.environmentId,
          projectId: targetProjectRef.projectId,
        },
        ...(selectedTask
          ? {
              ...buildJarvisClientCommandContext({
                projectRef: {
                  nodeId: targetProjectRef.environmentId,
                  projectId: targetProjectRef.projectId,
                },
                task: {
                  threadId: selectedTask.threadId,
                  projectRef: selectedTask.projectRef,
                  ...(selectedTask.taskRef === undefined ? {} : { taskRef: selectedTask.taskRef }),
                  ...(selectedTask.pendingReply === undefined
                    ? {}
                    : { pendingReply: selectedTask.pendingReply }),
                },
              }),
              ...(selectedTask.title === undefined
                ? {}
                : { contextThreadTitle: selectedTask.title }),
              ...(selectedTask.taskRef === undefined ? {} : { taskRef: selectedTask.taskRef }),
              ...(selectedTask.pendingReply === undefined
                ? {}
                : { pendingReply: selectedTask.pendingReply }),
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
  const nativeVoiceBridge = window.desktopBridge?.jarvisVoice;
  useEffect(() => {
    setTaskDesks([]);

    setSelectedProjectRef(null);
    setSelectedTask(null);

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
    });
    return () => {
      active = false;
    };
  }, [refreshMesh]);

  // Ready when any node reports a shared ready state and our own refresh
  // did not fail. The runtime's own refresh-in-flight flag does not gate:
  // submissions revalidate their explicit node before executing, so a slow
  // unrelated peer must not stall a qualified submission.
  const catalogReady =
    catalog !== null &&
    catalogError === null &&
    catalog.nodes.some((node) => jarvisMeshNodeReadiness(node).status === "ready");
  voiceSubmissionReadyRef.current = catalogReady && !submissionBusyRef.current;
  useEffect(() => {
    if (catalog === null) return;
    let active = true;
    const connectedNodes = catalog.nodes.filter((node) => node.reachability === "online");

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
    });
    return () => {
      active = false;
    };
  }, [catalog, getTaskDesk]);

  useEffect(() => {
    if (nativeVoiceBridge === undefined) return;
    nativeVoiceBridge.setRecognitionContext(
      catalog === null ? [] : jarvisRecognitionContextPhrases(catalog),
    );
    return () => nativeVoiceBridge.setRecognitionContext([]);
  }, [catalog, nativeVoiceBridge]);

  useEffect(() => {
    if (
      catalog === null ||
      routeTarget !== null ||
      selectedProjectRef !== null ||
      selectedTask !== null ||
      userClearedTargetRef.current
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
      setSelectedTask(
        toSelectedTask({
          projectRef: voiceTarget.task.projectRef,
          threadId: voiceTarget.task.threadId,
          title: voiceTarget.task.title,
          taskRef: voiceTarget.task.taskRef,
          ...(voiceTarget.task.pendingReply === undefined
            ? {}
            : { pendingReply: voiceTarget.task.pendingReply }),
        }),
      );
    } else if (voiceTarget?.kind === "project") {
      setSelectedProjectRef(voiceTarget.projectRef);
    }
  }, [catalog, primaryEnvironmentId, routeTarget, selectedProjectRef, selectedTask, taskDesks]);

  // Explicit selection is inspectable and resettable through the command bus.
  // A disconnected selection stays put and reports unavailable; it never
  // picks another project or task on its own.
  useEffect(() => {
    const node =
      target === null
        ? undefined
        : catalog?.nodes.find((candidate) => candidate.nodeId === target.projectRef.nodeId);
    const available =
      target === null
        ? false
        : node === undefined
          ? // Keep a route-driven local target visible while its catalog read
            // is still in flight; submit revalidates the node before executing.
            catalog === null && routeTarget !== null
          : jarvisMeshNodeReadiness(node).status === "ready";
    publishJarvisTargetSnapshot(
      target === null
        ? null
        : {
            projectRef: target.projectRef,
            ...(target.projectTitle === undefined ? {} : { projectTitle: target.projectTitle }),
            ...(node?.label === undefined ? {} : { nodeLabel: node.label }),
            ...(target.contextThreadId === undefined
              ? {}
              : { contextThreadId: target.contextThreadId }),
            ...(target.contextThreadTitle === undefined
              ? {}
              : { contextThreadTitle: target.contextThreadTitle }),
            ...(target.referenceThreadId === undefined
              ? {}
              : { referenceThreadId: target.referenceThreadId }),
            ...(target.taskRef === undefined ? {} : { taskRef: target.taskRef }),
            ...(target.pendingReply === undefined ? {} : { pendingReply: target.pendingReply }),
            available,
          },
    );
  }, [catalog, routeTarget, target]);

  useEffect(() => {
    // Recompute instead of publishing a raw flag: this effect reruns on
    // target identity, which must never clobber a paused clarification wait.
    syncPending();
  }, [catalogReady, syncPending, target]);

  /**
   * Store one server needs-input frame with its exact answer pin and frame
   * id. An explicitly supplied pin or frame id overrides the previous one;
   * a rejected reply that omits them never erases the known pin or frame,
   * otherwise the next answer would bypass the server guard.
   */
  const storeServerClarification = useCallback(
    (input: {
      readonly instruction: string;
      readonly sourceUtterance: string;
      readonly result: JarvisNeedsInput;
      readonly target: JarvisVoiceTarget;
      readonly captureId: string;
      readonly requestId: string;
      readonly inputMode: SubmissionInputMode;
      readonly previous: JarvisPendingClarification | null;
    }): void => {
      // An explicitly supplied pin or frame replaces the known ones. A reply
      // that omits them never erases what the paused target already holds:
      // the next answer would otherwise bypass the server guard.
      const retainedPin =
        input.result.expectedReply !== undefined
          ? retainedReplyPin(input.result.expectedReply)
          : (input.previous?.target?.pendingReply ?? input.target.pendingReply);
      const frameId =
        input.result.clarificationFrameId ?? input.previous?.clarification.clarificationFrameId;
      const clarification: JarvisNeedsInput =
        frameId === undefined || input.result.clarificationFrameId !== undefined
          ? input.result
          : { ...input.result, clarificationFrameId: frameId };
      const pinnedTarget: JarvisVoiceTarget = {
        projectRef: input.target.projectRef,
        ...(input.target.projectTitle === undefined
          ? {}
          : { projectTitle: input.target.projectTitle }),
        ...(input.target.contextThreadId === undefined
          ? {}
          : { contextThreadId: input.target.contextThreadId }),
        ...(input.target.contextThreadTitle === undefined
          ? {}
          : { contextThreadTitle: input.target.contextThreadTitle }),
        ...(input.target.referenceThreadId === undefined
          ? {}
          : { referenceThreadId: input.target.referenceThreadId }),
        ...(input.target.taskRef === undefined ? {} : { taskRef: input.target.taskRef }),
        ...(retainedPin === undefined ? {} : { pendingReply: retainedPin }),
      };
      voiceClarificationRef.current = {
        instruction: input.instruction,
        sourceUtterance: input.sourceUtterance,
        clarification,
        target: pinnedTarget,
        captureId: input.captureId,
        requestId: input.requestId,
        origin: "server",
        inputMode: input.inputMode,
      };
      if (
        selectedTask !== null &&
        input.target.contextThreadId !== undefined &&
        input.target.contextThreadId === selectedTask.threadId &&
        input.target.projectRef.nodeId === selectedTask.projectRef.nodeId &&
        input.target.projectRef.projectId === selectedTask.projectRef.projectId
      ) {
        setSelectedTask(
          toSelectedTask({
            projectRef: selectedTask.projectRef,
            threadId: selectedTask.threadId,
            ...(selectedTask.title === undefined ? {} : { title: selectedTask.title }),
            ...(selectedTask.taskRef === undefined ? {} : { taskRef: selectedTask.taskRef }),
            ...(retainedPin === undefined ? {} : { pendingReply: retainedPin }),
          }),
        );
        setTargetVersion((version) => version + 1);
      }
      const feedback = jarvisExecutionFeedback(input.result);
      emitCommandFeedback({
        text: feedback.speech,
        kind: "needs-input",
        inputMode: input.inputMode,
        captureId: input.captureId,
        requestId: input.requestId,
      });
      syncPending();
    },
    [selectedTask, syncPending],
  );

  /**
   * Read the current unique pending request (or explicit null) for one task
   * from the exact node's desk. Pins are read from the desk, never inferred.
   * Absent tasks and failed reads yield null so a stale pin can never block
   * later follow-ups forever.
   */
  const readDeskPin = useCallback(
    async (input: {
      readonly nodeId: EnvironmentId;
      readonly threadId: ThreadId;
    }): Promise<JarvisTaskPendingReply | null> => {
      try {
        const deskResult = await getTaskDesk({ nodeId: input.nodeId });
        if (deskResult._tag !== "Success") return null;
        const view =
          deskResult.value.recentTasks.find((task) => task.threadId === input.threadId) ??
          (deskResult.value.focusedTask?.threadId === input.threadId
            ? deskResult.value.focusedTask
            : undefined);
        return view === undefined ? null : (view.pendingReply ?? null);
      } catch {
        return null;
      }
    },
    [getTaskDesk],
  );

  /**
   * Re-pin the selected task from the exact node's desk after a result. An
   * answered request is complete, so its pin must not linger and block later
   * follow-ups.
   */
  const refreshTaskPin = useCallback(
    async (input: {
      readonly nodeId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly projectRef: JarvisProjectRef;
    }): Promise<void> => {
      const pin = await readDeskPin({ nodeId: input.nodeId, threadId: input.threadId });
      const current = selectedTaskRef.current;
      if (
        current !== null &&
        current.threadId === input.threadId &&
        current.projectRef.nodeId === input.projectRef.nodeId &&
        current.projectRef.projectId === input.projectRef.projectId
      ) {
        setSelectedTask(
          toSelectedTask({
            projectRef: current.projectRef,
            threadId: current.threadId,
            ...(current.title === undefined ? {} : { title: current.title }),
            ...(current.taskRef === undefined ? {} : { taskRef: current.taskRef }),
            pendingReply: pin,
          }),
        );
        setTargetVersion((version) => version + 1);
      }
      syncPending();
    },
    [readDeskPin, syncPending],
  );

  const cancelPendingClarification = useCallback(
    async (inputMode: SubmissionInputMode): Promise<void> => {
      const pending = voiceClarificationRef.current;
      if (pending === null) {
        emitCommandFeedback({
          text: "Nothing to cancel.",
          kind: "done",
          inputMode,
        });
        syncPending();
        return;
      }
      const discardLocally = (message: string): void => {
        voiceClarificationRef.current = null;
        voiceSubmissionSnapshotsRef.current.delete(pending.captureId);
        voiceSubmissionQueueRef.current?.discard(pending.captureId);
        emitCommandFeedback({
          text: message,
          kind: "done",
          inputMode,
          captureId: pending.captureId,
          requestId: pending.requestId,
        });
        syncPending();
      };
      const frameId = pending.clarification.clarificationFrameId;
      if (pending.origin === "client" || pending.target === null || frameId === undefined) {
        // Client grounding and legacy frames without an id are local-only:
        // discarding them dispatches nothing.
        discardLocally("Okay, I discarded that request.");
        return;
      }
      // Server frames carry an exact id the server verifies before any
      // cancel or answer. Send it back verbatim: a replaced or missing frame
      // is rejected server-side instead of denying someone else's approval.
      const cancelTarget = pending.target;
      submissionBusyRef.current = true;
      syncPending();
      try {
        const commandResult = await executeInstruction({
          kind: "control",
          projectRef: cancelTarget.projectRef,
          requestMetadata: buildJarvisRequestMetadata({
            requestId: pending.requestId,
            originInteractionId: jarvisReporterIdentity(),
            originNodeId,
            ...(inputMode === "voice" ? { inputMode: "voice" as const } : {}),
            sourceUtterance: pending.sourceUtterance,
          }),
          ...(cancelTarget.contextThreadId
            ? { contextThreadId: cancelTarget.contextThreadId }
            : {}),
          ...(cancelTarget.referenceThreadId
            ? { referenceThreadId: cancelTarget.referenceThreadId }
            : {}),
          clarificationFrameId: frameId,
          utterance: "cancel",
        });
        if (commandResult._tag === "Failure") {
          // Retain the prompt: a failed cancel must never falsely claim the
          // request was discarded. Answer it or try cancel again.
          const message = jarvisErrorMessage(squashAtomCommandFailure(commandResult));
          emitCommandFeedback({
            text: `Cancel didn't go through: ${message}`,
            kind: "error",
            inputMode,
            captureId: pending.captureId,
            requestId: pending.requestId,
          });
          return;
        }
        if (commandResult.value.status === "needs-input") {
          if (commandResult.value.reason === "source-output-unavailable") {
            // The exact submitted frame is gone server-side: retire the local
            // prompt without claiming a server cancel happened, and unlock
            // the surface for an explicit fresh choice.
            voiceClarificationRef.current = null;
            voiceSubmissionSnapshotsRef.current.delete(pending.captureId);
            voiceSubmissionQueueRef.current?.discard(pending.captureId);
            emitCommandFeedback({
              text: "That selection is no longer open; nothing was cancelled.",
              kind: "done",
              inputMode,
              captureId: pending.captureId,
              requestId: pending.requestId,
            });
            syncPending();
            return;
          }
          // Keep the original reply guards when cancellation needs more input.
          storeServerClarification({
            instruction: pending.instruction,
            sourceUtterance: pending.sourceUtterance,
            result: commandResult.value,
            target: cancelTarget,
            captureId: pending.captureId,
            requestId: pending.requestId,
            inputMode,
            previous: pending,
          });
          return;
        }
        voiceClarificationRef.current = null;
        voiceSubmissionSnapshotsRef.current.delete(pending.captureId);
        voiceSubmissionQueueRef.current?.discard(pending.captureId);
        const feedback = jarvisExecutionFeedback(commandResult.value);
        emitCommandFeedback({
          text: feedback.speech,
          kind: "done",
          inputMode,
          captureId: pending.captureId,
          requestId: pending.requestId,
        });
        if (
          cancelTarget.contextThreadId !== undefined &&
          commandResult.value.status === "started"
        ) {
          await refreshTaskPin({
            nodeId: cancelTarget.projectRef.nodeId,
            threadId: cancelTarget.contextThreadId,
            projectRef: cancelTarget.projectRef,
          });
        } else {
          syncPending();
        }
      } catch (cause) {
        // Transport failure retains the prompt for the same reason.
        emitCommandFeedback({
          text: `Cancel didn't go through: ${jarvisErrorMessage(cause)}`,
          kind: "error",
          inputMode,
          captureId: pending.captureId,
          requestId: pending.requestId,
        });
      } finally {
        submissionBusyRef.current = false;
        syncPending();
      }
    },
    [executeInstruction, originNodeId, refreshTaskPin, storeServerClarification, syncPending],
  );

  useEffect(
    () =>
      onJarvisTargetRequest((request) => {
        const hasPending =
          submissionBusyRef.current ||
          voiceClarificationRef.current !== null ||
          (voiceSubmissionQueueRef.current?.size() ?? 0) > 0;
        if (hasPending) {
          // Never silently re-answer an old task under a new target. Cancel
          // the current request first; the selectors stay visible but refuse
          // to switch mid-flight.
          emitCommandFeedback({
            text: "Finish or cancel the current request before switching targets.",
            kind: "error",
            inputMode: "text",
          });
          syncPending();
          return;
        }
        if (request.type === "clear") {
          userClearedTargetRef.current = true;
          setSelectedProjectRef(null);
          setSelectedTask(null);
          setTargetVersion((version) => version + 1);
          return;
        }
        userClearedTargetRef.current = false;
        if (request.type === "select-project") {
          setSelectedTask(null);
          setSelectedProjectRef(request.projectRef);
          setTargetVersion((version) => version + 1);
          return;
        }
        setSelectedProjectRef(request.projectRef);
        setSelectedTask(
          toSelectedTask({
            projectRef: request.projectRef,
            threadId: request.threadId,
            ...(request.title === undefined ? {} : { title: request.title }),
            ...(request.taskRef === undefined ? {} : { taskRef: request.taskRef }),
            ...(request.pendingReply === undefined ? {} : { pendingReply: request.pendingReply }),
          }),
        );
        setTargetVersion((version) => version + 1);
      }),
    [syncPending],
  );

  const enqueueUnifiedSubmission = (input: {
    readonly captureId: string;
    readonly transcript: string;
    readonly sourceTranscript?: string;
    readonly requestId?: string;
    readonly inputMode: SubmissionInputMode;
    readonly target?: JarvisVoiceTarget | null;
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
      ...(input.sourceTranscript === undefined ? {} : { sourceTranscript: input.sourceTranscript }),
      ...(snapshot === undefined ? {} : { requestId: snapshot.requestId }),
      inputMode: input.inputMode,
    });
    if (enqueueResult === "enqueued") void voiceSubmissionQueueRef.current?.drain();
    else if (enqueueResult === "full") {
      emitCommandFeedback({
        text: "Requests are backed up. Wait for one to finish, then try again.",
        kind: "error",
        inputMode: input.inputMode,
        captureId: input.captureId,
        ...(snapshot?.requestId === undefined ? {} : { requestId: snapshot.requestId }),
      });
    }
    syncPending();
  };

  /**
   * The single entry point for every submission: native transcripts, browser
   * speech results, and composer text share one cancel and resume policy.
   */
  const receiveSubmission = (
    text: string,
    options: {
      readonly inputMode: SubmissionInputMode;
      readonly captureId: string;
      readonly requestId?: string;
      readonly sourceTranscript?: string;
    },
  ): void => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const pendingClarification = voiceClarificationRef.current;
    if (pendingClarification !== null) {
      if (isJarvisVoiceClarificationDiscard(trimmed)) {
        void cancelPendingClarification(options.inputMode);
        return;
      }
      // Clarification answers keep the paused FIFO item; resume it with the
      // same capture so server frames stay idempotent.
      voiceSubmissionQueueRef.current?.resume(pendingClarification.captureId, {
        captureId: pendingClarification.captureId,
        transcript: trimmed,
        sourceTranscript: pendingClarification.sourceUtterance,
        requestId: options.requestId ?? pendingClarification.requestId,
        inputMode: options.inputMode,
      });
      return;
    }
    enqueueUnifiedSubmission({
      captureId: options.captureId,
      transcript: trimmed,
      sourceTranscript: options.sourceTranscript ?? trimmed,
      ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
      inputMode: options.inputMode,
    });
  };
  const receiveSubmissionRef = useRef(receiveSubmission);
  receiveSubmissionRef.current = receiveSubmission;

  useEffect(
    () =>
      onJarvisComposerCommand((command) => {
        receiveSubmissionRef.current(command.text, {
          inputMode: command.inputMode,
          captureId: command.captureId,
          ...(command.requestId === undefined ? {} : { requestId: command.requestId }),
          ...(command.sourceTranscript === undefined
            ? {}
            : { sourceTranscript: command.sourceTranscript }),
        });
      }),
    [],
  );

  useEffect(() => {
    const voice = window.desktopBridge?.jarvisVoice;
    if (voice === undefined) return;
    const unsubscribeTranscript = voice.onTranscript((transcript, event) => {
      if (!shouldSubmitJarvisVoiceTranscript(event?.purpose)) return;
      if (isJarvisVoiceGarbageTranscript(transcript)) {
        emitCommandFeedback({
          text: "I couldn't hear you. Try that again.",
          kind: "error",
          inputMode: "voice",
          ...(event?.captureId === undefined ? {} : { captureId: event.captureId }),
        });
        return;
      }
      receiveSubmissionRef.current(transcript, {
        inputMode: "voice",
        captureId: event?.captureId ?? randomUUID(),
        sourceTranscript: transcript,
      });
    });
    return () => unsubscribeTranscript();
  }, []);

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
      const result = answerJarvisModelChoice(
        providers,
        pending.modelDraft ?? pending.clarification.modelDraft ?? {},
        reason,
        answer,
      );
      if (result.status === "no-match") return null;
      if (result.status === "need-choice") {
        const next: JarvisNeedsInput = {
          status: "needs-input",
          reason: result.reason,
          modelDraft: result.draft,
          prompt: result.prompt,
          choices: [...result.choices],
        };
        voiceClarificationRef.current = {
          ...pending,
          clarification: next,
          modelDraft: result.draft,
          origin: "client",
          inputMode: pending.inputMode,
        };

        emitCommandFeedback({
          text: result.prompt,
          kind: "needs-input",
          inputMode: pending.inputMode,
          captureId: pending.captureId,
          requestId: pending.requestId,
        });
        syncPending();
        return "paused";
      }
      return { instruction: pending.instruction, selection: result.selection };
    },
    [syncPending],
  );

  const submit = useCallback(
    async (voiceSubmission: JarvisVoiceSubmission) => {
      const capturedInstruction = voiceSubmission.transcript;
      const inputMode: SubmissionInputMode = voiceSubmission.inputMode ?? "voice";
      const pendingVoiceClarification = voiceClarificationRef.current;
      const voiceSnapshot = voiceSubmissionSnapshotsRef.current.get(voiceSubmission.captureId);
      const pendingProjectChoice =
        pendingVoiceClarification?.projectCandidates === undefined
          ? null
          : resolveJarvisVoiceProjectChoice({
              instruction: pendingVoiceClarification.instruction,
              answer: capturedInstruction,
              candidates: pendingVoiceClarification.projectCandidates,
              acceptsAffirmation: pendingVoiceClarification.acceptsAffirmation === true,
            });
      let modelSelectionOverride: ModelSelection | null = null;
      let instruction: string;
      if (pendingProjectChoice?.instruction !== undefined) {
        instruction = pendingProjectChoice.instruction;
      } else if (
        pendingVoiceClarification !== null &&
        pendingVoiceClarification.projectCandidates === undefined
      ) {
        // Server frames stay server-side. A typed model answer still
        // resolves locally so the next execute carries its selection;
        // every other server-owned answer goes back raw so the Director
        // resumes its own frame. Never reconstruct the original text here.
        const modelAnswer = resolveVoiceModelAnswer(pendingVoiceClarification, capturedInstruction);
        if (modelAnswer === "paused") return "pause" as const;
        if (modelAnswer !== null) {
          instruction = modelAnswer.instruction;
          modelSelectionOverride = modelAnswer.selection;
        } else {
          instruction = capturedInstruction.trim();
        }
      } else {
        instruction = capturedInstruction.trim();
      }
      if (submissionBusyRef.current || !catalogReady || instruction.trim().length === 0) return;
      if (
        pendingVoiceClarification?.projectCandidates !== undefined &&
        pendingProjectChoice === null
      ) {
        emitCommandFeedback({
          text: "I couldn't match that project. Say its name or give its number.",
          kind: "needs-input",
          inputMode,
          captureId: voiceSubmission.captureId,
          ...(voiceSubmission.requestId === undefined
            ? {}
            : { requestId: voiceSubmission.requestId }),
        });
        return "pause" as const;
      }

      let submissionCatalog = catalog;
      if (pendingVoiceClarification === null) {
        // An already-selected target only needs its own node revalidated; a
        // slow unrelated node must not stall a qualified submission.
        const explicitNodeId = (voiceSnapshot?.target ?? target)?.projectRef.nodeId;
        const refreshed =
          explicitNodeId === undefined
            ? await refreshMesh(undefined)
            : await refreshMeshNode({ nodeId: explicitNodeId });
        if (refreshed._tag === "Failure") {
          const failure = squashAtomCommandFailure(refreshed);
          emitCommandFeedback({
            text: jarvisErrorMessage(failure),
            kind: "error",
            inputMode,
            captureId: voiceSubmission.captureId,
            ...(voiceSubmission.requestId === undefined
              ? {}
              : { requestId: voiceSubmission.requestId }),
          });
          throw failure;
        }
        submissionCatalog = refreshed.value;
      }

      let groundedVoiceProject: JarvisMeshProject | undefined;
      if (pendingVoiceClarification === null && submissionCatalog !== null) {
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
            origin: "client",
            inputMode,
          };

          emitCommandFeedback({
            text: grounding.prompt,
            kind: "needs-input",
            inputMode,
            captureId: voiceSubmission.captureId,
            requestId,
          });
          syncPending();
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
            origin: "client",
            inputMode,
          };

          emitCommandFeedback({
            text: grounding.prompt,
            kind: "needs-input",
            inputMode,
            captureId: voiceSubmission.captureId,
            requestId,
          });
          syncPending();
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
              origin: "client",
              inputMode,
            };

            emitCommandFeedback({
              text: prompt,
              kind: "needs-input",
              inputMode,
              captureId: voiceSubmission.captureId,
              requestId,
            });
            syncPending();
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
      let submissionTarget: JarvisVoiceTarget | null =
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
      if (submissionTarget === null && submissionCatalog !== null) {
        // No unsafe single-global-project fallback: an unqualified request
        // must clarify explicitly. The local-background default already
        // covers the lone-local-project case via resolveJarvisVoiceDefaultTarget.
        const candidates = submissionCatalog.projects.map((project) => ({
          ...project,
          label: `${project.title} — ${project.nodeLabel}`,
        }));
        const prompt =
          candidates.length === 0
            ? "Choose a project before running."
            : "Which project should I use? Say the project name with your instruction.";
        voiceClarificationRef.current = {
          instruction,
          sourceUtterance: voiceSubmission.sourceTranscript ?? instruction,
          clarification: {
            status: "needs-input",
            reason: "control-target-required",
            prompt,
            choices: candidates.map((candidate) => candidate.label),
          },
          projectCandidates: candidates,
          target: voiceSnapshot?.target ?? target,
          captureId: voiceSubmission?.captureId ?? randomUUID(),
          requestId: voiceSubmission?.requestId ?? voiceSnapshot?.requestId ?? randomUUID(),
          origin: "client",
          inputMode,
        };

        emitCommandFeedback({
          text: prompt,
          kind: "needs-input",
          inputMode,
          captureId: voiceSubmission.captureId,
          ...(voiceSubmission.requestId === undefined
            ? {}
            : { requestId: voiceSubmission.requestId }),
        });
        syncPending();
        return "pause" as const;
      }
      if (submissionTarget === null) {
        emitCommandFeedback({
          text: catalogPending
            ? "I'm still loading your registered projects. Try again in a moment."
            : "Choose a project before running.",
          kind: "needs-input",
          inputMode,
          captureId: voiceSubmission.captureId,
        });
        return "pause" as const;
      }

      submissionBusyRef.current = true;
      syncPending();

      try {
        const requestId =
          pendingVoiceClarification?.requestId ??
          voiceSubmission.requestId ??
          voiceSnapshot?.requestId ??
          randomUUID();
        emitCommandFeedback({
          text: "Working on it.",
          kind: "working",
          inputMode,
          captureId: voiceSubmission.captureId,
          requestId,
          speak: false,
        });
        let commandResult;
        try {
          if (inputMode === "voice") {
            void playJarvisAcknowledgement();
            void window.desktopBridge?.jarvisVoice?.prepareSpeech().catch(() => undefined);
          }
          const answerPin = expectedReplyForTarget(submissionTarget);
          const execution = executeInstruction({
            kind: "control",
            projectRef: submissionTarget.projectRef,
            requestMetadata: buildJarvisRequestMetadata({
              requestId,
              originInteractionId: jarvisReporterIdentity(),
              originNodeId,
              inputMode,
              sourceUtterance:
                pendingVoiceClarification?.sourceUtterance ??
                voiceSubmission.sourceTranscript ??
                capturedInstruction,
            }),
            ...(submissionTarget.contextThreadId
              ? { contextThreadId: submissionTarget.contextThreadId }
              : {}),
            ...(submissionTarget.referenceThreadId
              ? { referenceThreadId: submissionTarget.referenceThreadId }
              : {}),
            // Raw answers to a server frame carry its exact id; the server
            // rejects a missing or replaced frame before interpreting.
            ...(pendingVoiceClarification?.origin === "server" &&
            pendingVoiceClarification.clarification.clarificationFrameId !== undefined
              ? {
                  clarificationFrameId:
                    pendingVoiceClarification.clarification.clarificationFrameId,
                }
              : {}),
            ...(answerPin === undefined ? {} : { expectedReply: answerPin }),
            ...(modelSelectionOverride === null ? {} : { modelSelection: modelSelectionOverride }),
            utterance: instruction,
          });
          commandResult = await execution;
        } catch (cause) {
          emitCommandFeedback({
            text: jarvisErrorMessage(cause),
            kind: "error",
            inputMode,
            captureId: voiceSubmission.captureId,
            requestId,
          });
          throw cause;
        }
        if (commandResult._tag === "Failure") {
          const message = jarvisErrorMessage(squashAtomCommandFailure(commandResult));

          emitCommandFeedback({
            text: message,
            kind: "error",
            inputMode,
            captureId: voiceSubmission.captureId,
            requestId,
          });
          throw new Error(message);
        }
        const result = commandResult.value;
        if (result.status === "needs-input") {
          voiceSubmissionSnapshotsRef.current.delete(voiceSubmission.captureId);
          storeServerClarification({
            instruction,
            sourceUtterance:
              pendingVoiceClarification?.sourceUtterance ??
              voiceSubmission.sourceTranscript ??
              instruction,
            result,
            target: submissionTarget,
            captureId: pendingVoiceClarification?.captureId ?? voiceSubmission.captureId,
            requestId:
              pendingVoiceClarification?.requestId ??
              voiceSubmission.requestId ??
              voiceSnapshot?.requestId ??
              randomUUID(),
            inputMode,
            previous: pendingVoiceClarification,
          });
          return "pause" as const;
        }
        if (result.status === "acknowledged") {
          voiceSubmissionSnapshotsRef.current.delete(voiceSubmission.captureId);
          if (pendingVoiceClarification?.captureId !== undefined) {
            voiceSubmissionSnapshotsRef.current.delete(pendingVoiceClarification.captureId);
          }
          if (pendingVoiceClarification !== null) voiceClarificationRef.current = null;
          const feedback = jarvisExecutionFeedback(result);
          emitCommandFeedback({
            text: feedback.speech,
            kind: "done",
            inputMode,
            captureId: voiceSubmission.captureId,
            requestId,
          });
          if (result.action === "focused") {
            // The server binds task identity on the ack itself: a taskRef
            // means task focus, its absence means project focus. The desk is
            // never consulted to choose an identity — it only enriches the
            // exact server identity with title and pin. Without a desk match
            // the identity stays, marked with no known pin, never another
            // task. Project focus clears the thread with no desk read.
            userClearedTargetRef.current = false;
            const ackTaskRef = result.taskRef;
            if (ackTaskRef === undefined) {
              setSelectedTask(null);
              setSelectedProjectRef({
                nodeId: submissionTarget.projectRef.nodeId,
                projectId: result.projectId,
              });
              setTargetVersion((version) => version + 1);
            } else {
              const focusProjectRef: JarvisProjectRef = {
                nodeId: ackTaskRef.executionNodeId,
                projectId: result.projectId,
              };
              let focusTitle: string | undefined;
              let focusPin: JarvisTaskPendingReply | null = null;
              try {
                const deskResult = await getTaskDesk({ nodeId: focusProjectRef.nodeId });
                if (deskResult._tag === "Success") {
                  const candidates =
                    deskResult.value.focusedTask === null
                      ? deskResult.value.recentTasks
                      : [deskResult.value.focusedTask, ...deskResult.value.recentTasks];
                  const match = candidates.find(
                    (task) =>
                      task.taskRef.threadId === ackTaskRef.threadId &&
                      task.taskRef.executionNodeId === ackTaskRef.executionNodeId,
                  );
                  if (match !== undefined) {
                    focusTitle = match.title;
                    focusPin = match.pendingReply ?? null;
                  }
                }
              } catch {
                focusPin = null;
              }
              setSelectedProjectRef(focusProjectRef);
              setSelectedTask(
                toSelectedTask({
                  projectRef: focusProjectRef,
                  threadId: ackTaskRef.threadId,
                  title: focusTitle,
                  taskRef: ackTaskRef,
                  pendingReply: focusPin,
                }),
              );
              setTargetVersion((version) => version + 1);
            }
          }
          onTargetConsumed();
          if ("threadId" in result) {
            await onThreadStarted(submissionTarget.projectRef.nodeId, result.threadId);
          }
          return;
        }
        voiceSubmissionSnapshotsRef.current.delete(voiceSubmission.captureId);
        if (pendingVoiceClarification?.captureId !== undefined) {
          voiceSubmissionSnapshotsRef.current.delete(pendingVoiceClarification.captureId);
        }
        if (pendingVoiceClarification !== null) voiceClarificationRef.current = null;
        const feedback = jarvisExecutionFeedback(result);
        emitCommandFeedback({
          text: feedback.speech,
          kind: "done",
          inputMode,
          captureId: voiceSubmission.captureId,
          requestId,
        });
        // An explicit focus or a started task pins its node/thread for the
        // next interaction. Viewing a remote node alone never changes the
        // desktop local-background default because route targets stay local.
        // Identity and project come from the server's exact result: the node
        // is the task's execution node, the project the server's project id
        // when present. The pin is never carried over: the answered request
        // is complete, so the exact node desk is re-read for the current
        // unique pending request (or null), and only unresolved answers keep
        // submitting their pin.
        userClearedTargetRef.current = false;
        if (result.taskRef !== undefined) {
          const resultNodeId = result.taskRef.executionNodeId;
          const resultProjectId = result.projectId ?? submissionTarget.projectRef.projectId;
          const resultProjectRef: JarvisProjectRef = {
            nodeId: resultNodeId,
            projectId: resultProjectId,
          };
          setSelectedProjectRef(resultProjectRef);
          const deskPin = await readDeskPin({ nodeId: resultNodeId, threadId: result.threadId });
          setSelectedTask(
            toSelectedTask({
              projectRef: resultProjectRef,
              threadId: result.threadId,
              title: feedback.visual.detail.slice(0, 120) || undefined,
              taskRef: result.taskRef,
              pendingReply: deskPin,
            }),
          );
          setTargetVersion((version) => version + 1);
        } else {
          setSelectedProjectRef(submissionTarget.projectRef);
          setTargetVersion((version) => version + 1);
        }
        onTargetConsumed();
        await onThreadStarted(
          result.taskRef?.executionNodeId ?? submissionTarget.projectRef.nodeId,
          result.threadId,
        );
      } finally {
        submissionBusyRef.current = false;
        // The current item leaves the queue as this submit settles, so a raw
        // size check here still counts it. Only queued work behind this item
        // plus a paused clarification keeps the command pending.
        const behind = (voiceSubmissionQueueRef.current?.size() ?? 0) > 1;
        const pending = voiceClarificationRef.current !== null || behind;
        publishJarvisCommandPending(pending);
        publishJarvisCommandBusy(false);
        onPendingChange?.(pending);
      }
    },
    [
      catalog,
      catalogPending,
      catalogReady,
      executeInstruction,
      getTaskDesk,
      onTargetConsumed,
      onThreadStarted,
      onPendingChange,
      originNodeId,
      readDeskPin,
      refreshMesh,
      refreshMeshNode,
      resolveVoiceModelAnswer,
      storeServerClarification,
      target,
    ],
  );

  submitVoiceInstructionRef.current = (submission) => submit(submission);

  useEffect(() => {
    if (voiceSubmissionReadyRef.current) void voiceSubmissionQueueRef.current?.drain();
  }, [catalogReady, target]);

  return null;
}
