import { circeLiveVoiceEnvironment } from "../../state/circeLiveVoice";
import { openCirceWebsite } from "./CirceQuickActions.logic";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import {
  buildCirceInterpretInput,
  circeMeshCatalogCoverage,
  circeMeshNodeReadiness,
  selectCirceSemanticNode,
  type CirceMeshProject,
  type CirceMeshProjectCandidate,
} from "@circe/client-runtime/circe/mesh";
import {
  buildCirceClientCommandContext,
  isSameCirceReplyPin,
  resolveCirceLiveContextTask,
  type CirceClientContextTask,
} from "@circe/client-runtime/circe/commandContext";
import {
  formatCirceVoiceDispatching,
  formatCirceVoiceReceipt,
  resolveCirceVoiceCancelMessage,
  shouldEmitCirceVoiceReceipt,
} from "@circe/client-runtime/circe/voiceWaiting";
import {
  resolveCirceProposalExecuteRoute,
  resolveCirceRouteCoverageConfirm,
} from "@circe/client-runtime/circe/routeGrounding";
import {
  answerCirceModelChoice,
  isCirceModelClarificationReason,
  type CirceModelDraft,
} from "@circe/core/modelChoice";
import { circeClarificationAnswerHasCommandRemainder } from "@circe/core/clarification";
import { tryBoundedLocalGrammarForEvidence } from "@circe/core/localGrammar";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  CirceExpectedReply,
  CirceNeedsInput,
  CirceProjectRef,
  CirceRequestMetadata,
  CirceTaskDeskTaskView,
  CirceTaskPendingReply,
  CirceTaskRef,
  ModelSelection,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CirceCommandTarget } from "../../circeBus";
import {
  onInterruptCirceInteractionSpeech,
  onCirceSpeechTerminal,
  interruptCirceReportSpeech,
  onCirceComposerCommand,
  onCirceTargetRequest,
  onCirceCommandAction,
  publishCirceCommandState,
  publishCirceCommandFeedback,
  publishCirceTargetSnapshot,
  type CirceCommandFeedback,
  type CirceComposerInputMode,
} from "../../circeBus";
import { circeReporterIdentity } from "../../circeIdentity";
import { randomUUID } from "../../lib/utils";
import {
  cancelBrowserSpeech,
  enqueueBrowserSpeech,
  isCirceSpeechRequestStale,
  noteCirceSpeechRequestTurn,
  noteCirceSpeechTerminal,
} from "./CirceVoiceReporter.logic";
import {
  createCirceInteractionSpeech,
  type CirceInteractionSpeech,
} from "./CirceInteractionSpeech";
import { getCirceLiveVoiceSink, registerCirceLiveVoiceDelegate } from "./CirceLiveVoice.bridge";
import { circeMeshEnvironment } from "../../state/circeMesh";
import { circeMeshCatalogAtom } from "../../state/circeMesh";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { groundCirceVoiceProjectMention } from "./CirceProjectGrounding";
import {
  buildCirceRequestMetadata,
  circeErrorMessage,
  circeExecutionFeedback,
  resolveCirceConversationProjectRef,
  resolveCirceVoiceDefaultTarget,
  resolveCirceVoiceMentionTarget,
  createCirceVoiceSubmissionQueue,
  createCirceConversationAnswerCache,
  isCirceVoiceClarificationDiscard,
  type CirceCommandInputMode as SubmissionInputMode,
  type CirceVoiceSubmission,
  resolveCirceVoiceProjectChoice,
} from "./CirceManager.logic";

interface CirceVoiceRuntimeProps {
  readonly routeTarget: CirceCommandTarget | null;
  readonly onTargetConsumed: () => void;
  readonly onThreadStarted: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) => Promise<void> | void;
  readonly onPendingChange?: (pending: boolean) => void;
}

/**
 * Whether an utterance that arrived while a project clarification was parked
 * is actually a fresh request. A matched target with command content left
 * over, or an unmatched bounded command shape, both mean the paused
 * instruction must not run under the newly named project.
 */
function isFreshRequestDuringClarification(input: {
  readonly answer: string;
  readonly matchedText: string | undefined;
  readonly projects: ReadonlyArray<CirceMeshProject> | null;
}): boolean {
  if (input.answer.trim().length === 0) return false;
  if (input.matchedText !== undefined) {
    return circeClarificationAnswerHasCommandRemainder({
      answer: input.answer,
      matchedText: input.matchedText,
    });
  }
  return (
    tryBoundedLocalGrammarForEvidence({
      source: input.answer,
      projects: (input.projects ?? []).map((project) => ({
        title: project.title,
        names: [
          project.workspaceRoot.trim().split(/[\\/]/u).at(-1) ?? "",
          ...project.repositoryNames,
          ...project.aliases,
        ].filter((name) => name.trim().length > 0),
      })),
      tasks: [],
    }).status === "proposal"
  );
}

interface CirceCommandFeedbackInput {
  readonly text: string;
  readonly kind: CirceCommandFeedback["kind"];
  readonly inputMode: CirceComposerInputMode;
  readonly captureId?: string;
  readonly requestId?: string;
  readonly speak?: boolean;
  readonly threadId?: ThreadId;
  readonly taskRef?: CirceTaskRef;
  readonly turnId?: TurnId;
}

interface CirceDeskNodeView {
  readonly nodeId: EnvironmentId;
  readonly nodeLabel: string;
  readonly focusedThreadId: ThreadId | null;
  readonly tasks: ReadonlyArray<CirceTaskDeskTaskView>;
}

/**
 * Narrow selected-task identity. The desk owns titles and lifecycle; the
 * runtime keeps only the node-qualified thread identity it needs to build
 * command context. Never fabricate provider/model data here.
 */
export interface CirceSelectedTask {
  readonly projectRef: CirceProjectRef;
  readonly threadId: ThreadId;
  readonly title?: string | undefined;
  readonly taskRef?: CirceTaskRef | undefined;
  readonly pendingReply?: CirceTaskPendingReply | null | undefined;
}

function toSelectedTask(input: {
  readonly projectRef: CirceProjectRef;
  readonly threadId: ThreadId;
  readonly title?: string | undefined;
  readonly taskRef?: CirceTaskRef | undefined;
  readonly pendingReply?: CirceTaskPendingReply | null | undefined;
}): CirceSelectedTask {
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
  expectedReply: CirceExpectedReply | null | undefined,
): CirceTaskPendingReply | null | undefined {
  // Explicit null means the server saw no unique pending request: clear the
  // pin. Undefined means unknown: leave whatever the target holds.
  if (expectedReply === undefined) return undefined;
  if (expectedReply === null) return null;
  return {
    kind: expectedReply.kind === "approval" ? "approval" : "user-input",
    requestId: expectedReply.requestId,
  };
}

interface CirceVoiceTarget {
  readonly projectRef: CirceProjectRef;
  readonly projectTitle?: string;
  readonly contextThreadId?: ThreadId;
  readonly contextThreadTitle?: string;
  readonly referenceThreadId?: ThreadId;
  readonly taskRef?: CirceTaskRef;
  readonly pendingReply?: CirceTaskPendingReply | null;
}

interface CircePendingClarification {
  readonly instruction: string;
  readonly sourceUtterance: string;
  readonly clarification: CirceNeedsInput;
  readonly target: CirceVoiceTarget | null;
  readonly projectCandidates?: ReadonlyArray<CirceMeshProjectCandidate>;
  readonly acceptsAffirmation?: boolean;
  readonly captureId: string;
  readonly requestId: string;
  readonly modelDraft?: CirceModelDraft;
  readonly origin: "server" | "client";
  readonly inputMode: SubmissionInputMode;
}

/**
 * Answer pin for one target: recomputed from the shared helper so a stale
 * focused task or a project override never inherits the wrong pin. Null pins
 * an explicit snapshot of no unique pending request.
 */
function expectedReplyForTarget(
  candidate: CirceVoiceTarget | null,
): CirceExpectedReply | null | undefined {
  if (candidate?.contextThreadId === undefined || candidate === null) return undefined;
  const context = buildCirceClientCommandContext({
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

export function CirceVoiceRuntime({
  routeTarget,
  onTargetConsumed,
  onThreadStarted,
  onPendingChange,
}: CirceVoiceRuntimeProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const originNodeId = primaryEnvironmentId;
  const quickLookup = useAtomCommand(circeLiveVoiceEnvironment.lookup, {
    reportFailure: false,
    reportDefect: false,
  });
  const executeInstruction = useAtomCommand(circeMeshEnvironment.execute, {
    reportFailure: false,
    reportDefect: false,
  });
  const refreshMesh = useAtomCommand(circeMeshEnvironment.refresh, {
    reportFailure: false,
    reportDefect: false,
  });
  const refreshMeshNode = useAtomCommand(circeMeshEnvironment.refreshNode, {
    reportFailure: false,
    reportDefect: false,
  });
  const getTaskDesk = useAtomCommand(circeMeshEnvironment.getTaskDesk, {
    reportFailure: false,
    reportDefect: false,
  });
  const interpretInstruction = useAtomCommand(circeMeshEnvironment.interpret, {
    reportFailure: false,
    reportDefect: false,
  });
  const converseInstruction = useAtomCommand(circeMeshEnvironment.converse, {
    reportFailure: false,
    reportDefect: false,
  });
  const cancelRequest = useAtomCommand(circeMeshEnvironment.cancelRequest, {
    reportFailure: false,
    reportDefect: false,
  });
  // Active interpret before any execution node is chosen. Explicit correction
  // cancel targets its semantic node; new additional input queues behind.
  const activeInterpretRef = useRef<{
    readonly captureId: string;
    readonly requestId: string;
    readonly nodeId: EnvironmentId;
    readonly origin?: CirceRequestMetadata["origin"];
  } | null>(null);
  // Repeated conversational turns reuse their answer instead of paying the
  // supervisor round trip again; command proposals are never cached.
  const conversationCacheRef = useRef(createCirceConversationAnswerCache());
  const currentTargetRef = useRef<CirceVoiceTarget | null>(null);
  const voiceSubmissionSnapshotsRef = useRef(
    new Map<
      string,
      {
        readonly requestId: string;
        readonly target: CirceVoiceTarget | null;
        readonly execution?: Parameters<typeof executeInstruction>[0];
      }
    >(),
  );
  const catalog = useAtomValue(circeMeshCatalogAtom);
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const [catalogPending, setCatalogPending] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [taskDesks, setTaskDesks] = useState<ReadonlyArray<CirceDeskNodeView>>([]);
  const [selectedProjectRef, setSelectedProjectRef] = useState<CirceProjectRef | null>(null);
  const [selectedTask, setSelectedTask] = useState<CirceSelectedTask | null>(null);
  const selectedTaskRef = useRef<CirceSelectedTask | null>(null);
  selectedTaskRef.current = selectedTask;
  // Bumped on every explicit target request so memoized target derivation
  // recomputes even when a ref flag is the only thing that changed.
  const [targetVersion, setTargetVersion] = useState(0);
  const submissionBusyRef = useRef(false);
  const userClearedTargetRef = useRef(false);
  /**
   * The exact pre-accept identity of the submission currently on the wire:
   * capture, request id, execution node, and origin as sent. Cancel and
   * correction address this identity verbatim so the server recomputes the
   * same acceptance key. Cleared the moment the submission settles.
   */
  const activeRequestRef = useRef<{
    readonly captureId: string;
    readonly requestId: string;
    readonly nodeId: EnvironmentId;
    readonly origin?: CirceRequestMetadata["origin"];
  } | null>(null);
  // Owned interaction speech on the shared browser lane. Speaking supersedes
  // the previous utterance; cancellation, new submissions, and disposal
  // retract it by its retained delivery identity.
  const interactionSpeechRef = useRef<CirceInteractionSpeech | null>(null);
  if (interactionSpeechRef.current === null) {
    interactionSpeechRef.current = createCirceInteractionSpeech({
      // Share the reporter playback lane instead of speaking straight at the
      // browser singleton: it serializes utterances and drops stale ones.
      speak: (text, deliveryId) => {
        void enqueueBrowserSpeech(text, deliveryId).catch(() => undefined);
      },
      cancel: (deliveryId) => cancelBrowserSpeech(deliveryId),
    });
  }
  const cancelInteractionSpeech = useCallback(() => {
    interactionSpeechRef.current?.cancel();
  }, []);
  const speakFeedbackText = useCallback(
    (
      text: string,
      identity?: {
        readonly threadId?: ThreadId;
        readonly taskRef?: CirceTaskRef;
        readonly turnId?: TurnId;
        readonly requestId?: string;
      },
    ) => {
      if (text.trim().length === 0) return;
      // A live conversation owns speech: the model speaks backend feedback
      // instead of the browser lane.
      const liveSink = getCirceLiveVoiceSink();
      if (liveSink !== null) {
        liveSink.speak(text);
        return;
      }
      const interactionIdentity =
        identity === undefined ||
        (identity.threadId === undefined &&
          identity.requestId === undefined &&
          identity.turnId === undefined)
          ? undefined
          : {
              ...(identity.threadId === undefined ? {} : { threadId: identity.threadId }),
              ...(identity.taskRef === undefined ? {} : { taskRef: identity.taskRef }),
              ...(identity.turnId === undefined ? {} : { turnId: identity.turnId }),
              ...(identity.requestId === undefined ? {} : { requestId: identity.requestId }),
            };
      if (
        interactionIdentity !== undefined &&
        (interactionIdentity.turnId !== undefined || interactionIdentity.requestId !== undefined) &&
        isCirceSpeechRequestStale(interactionIdentity)
      ) {
        return;
      }
      if (
        interactionIdentity?.requestId !== undefined &&
        interactionIdentity.turnId !== undefined &&
        interactionIdentity.threadId !== undefined
      ) {
        noteCirceSpeechRequestTurn(interactionIdentity.requestId, {
          ...(interactionIdentity.taskRef === undefined
            ? {}
            : { taskRef: interactionIdentity.taskRef }),
          threadId: interactionIdentity.threadId,
          turnId: interactionIdentity.turnId,
        });
      }
      interactionSpeechRef.current?.speak(text, interactionIdentity);
    },
    [],
  );
  /**
   * One visible feedback lane for every submission. Text entries stay visible
   * and never auto-speak; voice entries speak the same text aloud with the
   * accepted-turn identity so a terminal outranks its own ack either order.
   */
  const emitFeedback = useCallback(
    (input: CirceCommandFeedbackInput) => {
      publishCirceCommandFeedback({
        ...(input.captureId === undefined ? {} : { captureId: input.captureId }),
        ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
        inputMode: input.inputMode,
        kind: input.kind,
        text: input.text,
      });
      if ((input.speak ?? true) && input.inputMode === "voice") {
        speakFeedbackText(input.text, {
          ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
          ...(input.taskRef === undefined ? {} : { taskRef: input.taskRef }),
          ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
          ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
        });
      }
    },
    [speakFeedbackText],
  );
  const voiceClarificationRef = useRef<CircePendingClarification | null>(null);
  const voiceSubmissionReadyRef = useRef(false);
  const submitVoiceInstructionRef = useRef<
    (submission: CirceVoiceSubmission) => Promise<void | "complete" | "pause">
  >(async () => undefined);
  const syncPendingRef = useRef<() => void>(() => undefined);
  const voiceSubmissionQueueRef = useRef<ReturnType<typeof createCirceVoiceSubmissionQueue> | null>(
    null,
  );
  if (voiceSubmissionQueueRef.current === null) {
    voiceSubmissionQueueRef.current = createCirceVoiceSubmissionQueue({
      canSubmit: () => voiceSubmissionReadyRef.current && !submissionBusyRef.current,
      submit: (submission) => submitVoiceInstructionRef.current(submission),
      onChange: () => syncPendingRef.current(),
    });
  }

  const syncPending = useCallback(() => {
    const queue = voiceSubmissionQueueRef.current;
    const busy = submissionBusyRef.current || (queue?.isRunning() ?? false);
    const awaitingAnswer = voiceClarificationRef.current !== null;
    const pending = busy || awaitingAnswer || (queue?.size() ?? 0) > 0;
    publishCirceCommandState({
      pending,
      busy,
      awaitingAnswer,
      canRetry: !busy && !awaitingAnswer && queue?.failed() != null,
    });
    onPendingChange?.(pending);
  }, [onPendingChange]);
  syncPendingRef.current = syncPending;

  // Command context is owned by explicit selection and the current route.
  // Spoken reports never contribute: they are display-only. An explicit
  // clear leaves no target even when a local route is visible.
  const commandTarget: CirceCommandTarget | null = routeTarget;
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
  const target: CirceVoiceTarget | null = targetProjectRef
    ? {
        projectRef: {
          nodeId: targetProjectRef.environmentId,
          projectId: targetProjectRef.projectId,
        },
        ...(selectedTask
          ? {
              ...buildCirceClientCommandContext({
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
        setCatalogError(circeErrorMessage(squashAtomCommandFailure(result)));
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
    catalog.nodes.some((node) => circeMeshNodeReadiness(node).status === "ready");
  voiceSubmissionReadyRef.current = catalogReady;
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
      setTaskDesks(desks.filter((desk): desk is CirceDeskNodeView => desk !== null));
    });
    return () => {
      active = false;
    };
  }, [catalog, getTaskDesk]);

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
    const voiceTarget = resolveCirceVoiceDefaultTarget({
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
          : circeMeshNodeReadiness(node).status === "ready";
    const recentTasks = taskDesks
      .flatMap((desk) => desk.tasks)
      .filter(
        (task): task is typeof task & { readonly title: string } =>
          typeof (task as { readonly title?: unknown }).title === "string",
      )
      .slice(0, 6)
      .map((task) => {
        const projectTitle =
          task.projectRef === undefined
            ? undefined
            : catalog?.projects.find(
                (candidate) =>
                  candidate.ref.nodeId === task.projectRef?.nodeId &&
                  candidate.ref.projectId === task.projectRef?.projectId,
              )?.title;
        const state =
          typeof (task as { readonly state?: unknown }).state === "string"
            ? (task.state as string)
            : undefined;
        const providerInstance =
          typeof (task as { readonly modelSelection?: { readonly instanceId?: unknown } })
            .modelSelection?.instanceId === "string"
            ? (task.modelSelection as { readonly instanceId: string }).instanceId
            : undefined;
        return {
          title: task.title.slice(0, 120),
          ...(projectTitle === undefined ? {} : { project: projectTitle.slice(0, 80) }),
          ...(state === undefined ? {} : { state: state.slice(0, 32) }),
          ...(providerInstance === undefined ? {} : { provider: providerInstance.slice(0, 40) }),
        };
      });
    publishCirceTargetSnapshot(
      target === null
        ? null
        : {
            projectRef: target.projectRef,
            ...(recentTasks.length === 0 ? {} : { recentTasks }),
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
  }, [catalog, routeTarget, target, taskDesks]);

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
      readonly result: CirceNeedsInput;
      readonly target: CirceVoiceTarget;
      readonly captureId: string;
      readonly requestId: string;
      readonly inputMode: SubmissionInputMode;
      readonly previous: CircePendingClarification | null;
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
      const clarification: CirceNeedsInput =
        frameId === undefined || input.result.clarificationFrameId !== undefined
          ? input.result
          : { ...input.result, clarificationFrameId: frameId };
      const pinnedTarget: CirceVoiceTarget = {
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
      const feedback = circeExecutionFeedback(input.result);
      emitFeedback({
        text: feedback.speech,
        kind: "needs-input",
        inputMode: input.inputMode,
        captureId: input.captureId,
        requestId: input.requestId,
      });
      syncPending();
    },
    [emitFeedback, selectedTask, syncPending],
  );

  /**
   * Read the current desk tasks for one node. Unknown on transport failure
   * so callers keep their retained state instead of inventing a pin.
   */
  const readDeskTasks = useCallback(
    async (nodeId: EnvironmentId): Promise<ReadonlyArray<CirceClientContextTask> | undefined> => {
      try {
        const deskResult = await getTaskDesk({ nodeId });
        if (deskResult._tag !== "Success") return undefined;
        const tasks: CirceClientContextTask[] = deskResult.value.recentTasks.map((task) => ({
          threadId: task.threadId,
          ...(task.taskRef === undefined ? {} : { taskRef: task.taskRef }),
          ...(task.projectRef === undefined ? {} : { projectRef: task.projectRef }),
          ...(task.pendingReply === undefined ? {} : { pendingReply: task.pendingReply }),
        }));
        const focused = deskResult.value.focusedTask;
        if (
          focused !== null &&
          focused !== undefined &&
          !tasks.some((task) => task.threadId === focused.threadId)
        ) {
          tasks.push({
            threadId: focused.threadId,
            ...(focused.taskRef === undefined ? {} : { taskRef: focused.taskRef }),
            ...(focused.projectRef === undefined ? {} : { projectRef: focused.projectRef }),
            ...(focused.pendingReply === undefined ? {} : { pendingReply: focused.pendingReply }),
          });
        }
        return tasks;
      } catch {
        return undefined;
      }
    },
    [getTaskDesk],
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
    }): Promise<CirceTaskPendingReply | null> => {
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
      readonly projectRef: CirceProjectRef;
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
        emitFeedback({
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
        // Cancelling the interaction retracts its speech: the prompt must
        // not keep playing after the request is gone.
        cancelInteractionSpeech();
        emitFeedback({
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
          requestMetadata: buildCirceRequestMetadata({
            requestId: pending.requestId,
            originInteractionId: circeReporterIdentity(),
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
          const message = circeErrorMessage(squashAtomCommandFailure(commandResult));
          emitFeedback({
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
            cancelInteractionSpeech();
            emitFeedback({
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
        // The cancelled interaction's speech stops with the request; the
        // confirmation below speaks fresh through the same owned lane.
        cancelInteractionSpeech();
        const feedback = circeExecutionFeedback(commandResult.value);
        emitFeedback({
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
        emitFeedback({
          text: `Cancel didn't go through: ${circeErrorMessage(cause)}`,
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
    [
      cancelInteractionSpeech,
      emitFeedback,
      executeInstruction,
      originNodeId,
      refreshTaskPin,
      storeServerClarification,
      syncPending,
    ],
  );

  const handleCommandAction = useCallback(
    async (action: {
      readonly type: "cancel" | "retry";
      readonly inputMode: SubmissionInputMode;
    }) => {
      const queue = voiceSubmissionQueueRef.current;
      if (action.type === "retry") {
        if (
          submissionBusyRef.current ||
          queue?.isRunning() ||
          voiceClarificationRef.current !== null
        )
          return;
        await queue?.retryFailed();
        syncPending();
        return;
      }
      cancelInteractionSpeech();
      if (voiceClarificationRef.current !== null) {
        if (submissionBusyRef.current || queue?.isRunning()) return;
        await cancelPendingClarification(action.inputMode);
        return;
      }
      const discarded = queue?.discardWaiting() ?? [];
      for (const captureId of discarded) voiceSubmissionSnapshotsRef.current.delete(captureId);
      // Explicit correction cancels the active interpret first (proposal never
      // dispatches), then the active execute. New additional input queues
      // behind and never reaches here.
      const activeInterpret = activeInterpretRef.current;
      if (activeInterpret !== null) {
        try {
          await cancelRequest({
            nodeId: activeInterpret.nodeId,
            input: {
              requestId: activeInterpret.requestId,
              ...(activeInterpret.origin === undefined ? {} : { origin: activeInterpret.origin }),
            },
          });
        } catch {
          // Interpret cancel is best-effort; the awaiting interpret observes
          // its own cancelled outcome and stays ambient.
        }
        if (activeInterpretRef.current?.requestId === activeInterpret.requestId) {
          activeInterpretRef.current = null;
        }
      }
      const active = activeRequestRef.current;
      if ((queue?.isRunning() ?? false) && active !== null) {
        // Real pre-accept cancel by the exact identity on the wire. The
        // awaiting execute call resolves cancelled with no dispatch, or its
        // acknowledgement arrives when acceptance already won.
        emitFeedback({
          inputMode: action.inputMode,
          kind: "working",
          text: "Cancelling…",
          captureId: active.captureId,
          requestId: active.requestId,
          speak: false,
        });
        syncPending();
        try {
          const cancelResult = await cancelRequest({
            nodeId: active.nodeId,
            input: {
              requestId: active.requestId,
              ...(active.origin === undefined ? {} : { origin: active.origin }),
            },
          });
          if (cancelResult._tag === "Failure") {
            emitFeedback({
              text: `Cancel didn't go through: ${circeErrorMessage(squashAtomCommandFailure(cancelResult))}`,
              kind: "error",
              inputMode: action.inputMode,
              captureId: active.captureId,
              requestId: active.requestId,
            });
          } else if (cancelResult.value.status === "already-accepted") {
            emitFeedback({
              text: "That request was already accepted. Watching for its result.",
              kind: "working",
              inputMode: action.inputMode,
              captureId: active.captureId,
              requestId: active.requestId,
              speak: false,
            });
          }
          // Cancelled and unknown both resolve through the awaiting execute
          // call: cancelled emits its notice, unknown keeps waiting for the
          // receipt, so no further message here.
        } catch (cause) {
          emitFeedback({
            text: `Cancel didn't go through: ${circeErrorMessage(cause)}`,
            kind: "error",
            inputMode: action.inputMode,
            captureId: active.captureId,
            requestId: active.requestId,
          });
        }
        syncPending();
        return;
      }
      emitFeedback({
        inputMode: action.inputMode,
        kind: "done",
        // No tracked in-flight request here: only queued items were dropped.
        text: resolveCirceVoiceCancelMessage({
          inFlight: queue?.isRunning() ?? false,
          discardedQueued: discarded.length,
        }),
        speak: false,
      });
      syncPending();
    },
    [cancelInteractionSpeech, cancelPendingClarification, cancelRequest, emitFeedback, syncPending],
  );
  useEffect(
    () =>
      onCirceCommandAction((action) => {
        void handleCommandAction(action);
      }),
    [handleCommandAction],
  );

  useEffect(
    () =>
      onCirceTargetRequest((request) => {
        const hasPending =
          submissionBusyRef.current ||
          voiceClarificationRef.current !== null ||
          (voiceSubmissionQueueRef.current?.size() ?? 0) > 0;
        if (hasPending) {
          // Never silently re-answer an old task under a new target. Cancel
          // the current request first; the selectors stay visible but refuse
          // to switch mid-flight.
          emitFeedback({
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
    [emitFeedback, syncPending],
  );

  const enqueueUnifiedSubmission = (input: {
    readonly captureId: string;
    readonly transcript: string;
    readonly sourceTranscript?: string;
    readonly requestId?: string;
    readonly inputMode: SubmissionInputMode;
    readonly target?: CirceVoiceTarget | null;
  }): void => {
    // A new capture takes the floor at receipt time, not only at dispatch:
    // stale interaction speech must stop while the semantic call is pending.
    cancelInteractionSpeech();
    // Live report speech is invalidated the same way: a stale completion
    // must never speak over the next acknowledgement.
    interruptCirceReportSpeech();
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
    if (enqueueResult === "enqueued") {
      // A new input is an additional request, never an automatic correction:
      // only an explicit typed user action (cancel button, or a semantic
      // correction role after interpretation) cancels prior work. Queued work
      // runs behind the in-flight request instead of being silently dropped.
      // Immediate receipt while the semantic call is still unanswered. Silent
      // by design: the waiting window gets no filler speech, only this text.
      const receipt = formatCirceVoiceReceipt(input.transcript);
      if (receipt !== null && shouldEmitCirceVoiceReceipt(enqueueResult)) {
        emitFeedback({
          text: receipt,
          kind: "working",
          inputMode: input.inputMode,
          captureId: input.captureId,
          ...(snapshot?.requestId === undefined ? {} : { requestId: snapshot.requestId }),
          speak: false,
        });
      }
      void voiceSubmissionQueueRef.current?.drain();
    } else if (enqueueResult === "full") {
      emitFeedback({
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
      if (isCirceVoiceClarificationDiscard(trimmed)) {
        void handleCommandAction({ type: "cancel", inputMode: options.inputMode });
        return;
      }
      // Clarification answers keep the paused FIFO item; resume it with the
      // same capture so server frames stay idempotent.
      const resumeResult = voiceSubmissionQueueRef.current?.resume(pendingClarification.captureId, {
        captureId: pendingClarification.captureId,
        transcript: trimmed,
        sourceTranscript: pendingClarification.sourceUtterance,
        requestId: options.requestId ?? pendingClarification.requestId,
        inputMode: options.inputMode,
      });
      if (resumeResult !== "resumed") {
        // The parked slot is gone (a superseded pause). Do not drop the
        // utterance: retire the stale clarification and run it fresh; the
        // live server frame still binds reply-capable continuations.
        voiceClarificationRef.current = null;
        enqueueUnifiedSubmission({
          captureId: options.captureId,
          transcript: trimmed,
          sourceTranscript: options.sourceTranscript ?? trimmed,
          ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
          inputMode: options.inputMode,
        });
      }
      return;
    }
    if (
      isCirceVoiceClarificationDiscard(trimmed) &&
      (voiceSubmissionQueueRef.current?.size() ?? 0) > 0
    ) {
      void handleCommandAction({ type: "cancel", inputMode: options.inputMode });
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

  // A GPT-Live delegation reuses this exact submission path, so grounding,
  // clarification, and queue policy stay in one place for live and
  // push-to-talk speech.
  useEffect(
    () =>
      registerCirceLiveVoiceDelegate((utterance, delegationId) => {
        receiveSubmissionRef.current(utterance, {
          inputMode: "voice",
          captureId: `circe-live-${delegationId}`,
          sourceTranscript: utterance,
        });
        return true;
      }),
    [],
  );

  useEffect(
    () =>
      onCirceComposerCommand((command) => {
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

  const resolveVoiceModelAnswer = useCallback(
    (
      pending: NonNullable<typeof voiceClarificationRef.current>,
      answer: string,
    ): { readonly instruction: string; readonly selection: ModelSelection } | "paused" | null => {
      const reason = isCirceModelClarificationReason(pending.clarification.reason);
      const catalog = catalogRef.current;
      if (reason === null || catalog === null) return null;
      const nodeId = pending.target?.projectRef.nodeId;
      const providers = (
        nodeId === undefined
          ? catalog.providers
          : catalog.providers.filter((provider) => provider.nodeId === nodeId)
      ).map((provider) => provider.snapshot);
      const result = answerCirceModelChoice(
        providers,
        pending.modelDraft ?? pending.clarification.modelDraft ?? {},
        reason,
        answer,
      );
      if (result.status === "no-match") return null;
      if (result.status === "need-choice") {
        const next: CirceNeedsInput = {
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

        emitFeedback({
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
    [emitFeedback, syncPending],
  );

  const submit = useCallback(
    async (voiceSubmission: CirceVoiceSubmission) => {
      // A new submission takes the floor: retract any interaction speech
      // still playing before this instruction runs.
      cancelInteractionSpeech();
      const capturedInstruction = voiceSubmission.transcript;
      const inputMode: SubmissionInputMode = voiceSubmission.inputMode ?? "voice";
      const pendingVoiceClarification = voiceClarificationRef.current;
      const voiceSnapshot = voiceSubmissionSnapshotsRef.current.get(voiceSubmission.captureId);
      const pendingProjectChoice =
        pendingVoiceClarification?.projectCandidates === undefined
          ? null
          : resolveCirceVoiceProjectChoice({
              instruction: pendingVoiceClarification.instruction,
              answer: capturedInstruction,
              candidates: pendingVoiceClarification.projectCandidates,
              acceptsAffirmation: pendingVoiceClarification.acceptsAffirmation === true,
            });
      if (
        pendingVoiceClarification !== null &&
        isFreshRequestDuringClarification({
          answer: capturedInstruction,
          matchedText: pendingProjectChoice?.matchedText,
          projects: catalog?.projects ?? null,
        })
      ) {
        // The user stated a new request while a clarification was parked. The
        // paused instruction must never run under the newly named target:
        // retire the frame and run the new wording fresh with its own identity.
        voiceClarificationRef.current = null;
        emitFeedback({
          text: "Starting a new request.",
          kind: "working",
          inputMode,
          captureId: voiceSubmission.captureId,
          speak: false,
        });
        enqueueUnifiedSubmission({
          captureId: randomUUID(),
          transcript: capturedInstruction,
          sourceTranscript: capturedInstruction,
          inputMode,
        });
        return;
      }
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
      if (submissionBusyRef.current || instruction.trim().length === 0) return;
      if (
        pendingVoiceClarification?.projectCandidates !== undefined &&
        pendingProjectChoice === null
      ) {
        emitFeedback({
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

      if (!catalogReady) {
        emitFeedback({
          text: "I'm still connecting. Try again in a moment.",
          kind: "needs-input",
          inputMode,
          captureId: voiceSubmission.captureId,
          ...(voiceSubmission.requestId === undefined
            ? {}
            : { requestId: voiceSubmission.requestId }),
        });
        return;
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
          emitFeedback({
            text: circeErrorMessage(failure),
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

      let groundedVoiceProject: CirceMeshProject | undefined;
      // A general question never demands a project. When no explicit target is
      // pinned, the focused task's project (or a lone local project) hosts the
      // durable conversation thread instead of asking the user to choose one.
      let conversationDefaultProjectRef: CirceProjectRef | undefined;
      // Proposal-first routing: one interpret call on the semantic node
      // (ambient online preferred, never preposition-selected) produces typed
      // refs over verbatim source; the host grounds destination/correction
      // against the real catalog. Clarification answers, bound retries, and
      // pinned followups never re-route here. Negated (excluded-only) and
      // malformed proposals stay ambient for authoritative clarification.
      let meshRoutedProject: CirceMeshProject | undefined;
      let meshProposal: import("@t3tools/contracts").CirceSemanticProposal | undefined;
      const meshSource = voiceSubmission.sourceTranscript ?? capturedInstruction;
      // One request identity for interpret plus execute so an explicit
      // correction cancel aborts either phase on its node. New additional
      // input queues behind and never cancels here.
      const turnRequestId = voiceSubmission.requestId ?? voiceSnapshot?.requestId ?? randomUUID();
      const turnOrigin = circeReporterIdentity();
      if (
        pendingVoiceClarification === null &&
        voiceSnapshot?.execution === undefined &&
        submissionCatalog !== null
      ) {
        const routeCurrent = voiceSnapshot?.target ?? target;
        if (routeCurrent === null) {
          conversationDefaultProjectRef =
            resolveCirceConversationProjectRef({
              originNodeId: primaryEnvironmentId,
              nodes: submissionCatalog.nodes,
              projects: submissionCatalog.projects,
              taskDesks,
            }) ?? undefined;
        }
        // Deterministic fast path: a bounded full-turn command over the real
        // catalog never needs a model call. The execution node revalidates the
        // proposal, so this removes inference latency without moving authority.
        if (meshSource.trim().length > 0) {
          const grammar = tryBoundedLocalGrammarForEvidence({
            source: meshSource,
            projects: submissionCatalog.projects.map((project) => ({
              title: project.title,
              names: [
                project.workspaceRoot.trim().split(/[\\/]/u).at(-1) ?? "",
                ...project.repositoryNames,
                ...project.aliases,
              ].filter((name) => name.trim().length > 0),
            })),
            tasks: taskDesks
              .flatMap((deskEntry) => deskEntry.tasks)
              .slice(0, 8)
              .map((task) => ({ title: task.title })),
          });
          if (grammar.status === "proposal") {
            meshProposal = grammar.proposal;
          }
        }
        const semanticNode = selectCirceSemanticNode(
          submissionCatalog,
          routeCurrent?.projectRef.nodeId,
        );
        if (
          meshProposal === undefined &&
          semanticNode !== undefined &&
          meshSource.trim().length > 0
        ) {
          // Fresh providers for the inference: refresh the semantic node when
          // it differs from the already-refreshed explicit node, so bounded
          // evidence matches the node's configured registry.
          if (
            routeCurrent?.projectRef.nodeId === undefined ||
            routeCurrent.projectRef.nodeId !== semanticNode.nodeId
          ) {
            const freshSemantic = await refreshMeshNode({ nodeId: semanticNode.nodeId }).catch(
              () => null,
            );
            if (freshSemantic !== null && freshSemantic._tag === "Success") {
              submissionCatalog = freshSemantic.value;
            }
          }
          const currentTitle =
            routeCurrent === null || routeCurrent === undefined
              ? undefined
              : submissionCatalog.projects.find(
                  (candidate) =>
                    candidate.ref.nodeId === routeCurrent.projectRef.nodeId &&
                    candidate.ref.projectId === routeCurrent.projectRef.projectId,
                )?.title;
          // Bounded evidence matches the direct wire: recent desk tasks,
          // focused task, and pending hint travel as names only. Pins stay
          // on the owner node.
          const evidenceTasks = taskDesks
            .flatMap((deskEntry) => deskEntry.tasks)
            .filter(
              (task): task is typeof task & { readonly title: string } =>
                typeof (task as { readonly title?: unknown }).title === "string",
            )
            .slice(0, 8)
            .map((task) => {
              const projectTitle =
                task.projectRef === undefined
                  ? undefined
                  : submissionCatalog.projects.find(
                      (candidate) =>
                        candidate.ref.nodeId === task.projectRef?.nodeId &&
                        candidate.ref.projectId === task.projectRef?.projectId,
                    )?.title;
              const objective =
                typeof (task as { readonly objective?: unknown }).objective === "string"
                  ? ((task as { readonly objective: string }).objective.slice(0, 480) as string)
                  : undefined;
              const state =
                typeof (task as { readonly state?: unknown }).state === "string"
                  ? ((task as { readonly state: string }).state.slice(0, 64) as string)
                  : undefined;
              return {
                title: task.title.slice(0, 240),
                ...(projectTitle === undefined ? {} : { project: projectTitle.slice(0, 240) }),
                ...(objective === undefined ? {} : { objective }),
                ...(state === undefined ? {} : { state }),
              };
            });
          const focusedEvidence =
            selectedTask?.title === undefined && currentTitle === undefined
              ? undefined
              : {
                  title: (selectedTask?.title ?? currentTitle ?? "task").slice(0, 240),
                };
          const pendingHintForEvidence = (() => {
            const pin = routeCurrent as {
              readonly pendingReply?: { readonly kind?: string } | null;
            } | null;
            const reply = pin?.pendingReply;
            if (reply === undefined || reply === null) return undefined;
            return reply.kind === "approval" ? ("approval" as const) : ("question" as const);
          })();
          const evidence = buildCirceInterpretInput(submissionCatalog, meshSource, {
            ...(currentTitle === undefined ? {} : { currentProjectTitle: currentTitle }),
            ...(focusedEvidence === undefined ? {} : { focusedTask: focusedEvidence }),
            ...(pendingHintForEvidence === undefined
              ? {}
              : { pendingHint: pendingHintForEvidence }),
            inputMode,
            tasks: evidenceTasks,
            requestMetadata: {
              requestId: turnRequestId,
              origin: { originInteractionId: turnOrigin },
              ...(inputMode === "voice"
                ? { inputMode: "voice" as const, sourceUtterance: meshSource.slice(0, 16_000) }
                : {}),
            },
          });
          activeInterpretRef.current = {
            captureId: voiceSubmission.captureId,
            requestId: turnRequestId,
            nodeId: semanticNode.nodeId,
            origin: { originInteractionId: turnOrigin },
          };
          // Warm-path reuse: an identical conversational turn in the same
          // catalog context answers from the short-lived memo instead of
          // calling the supervisor again. Commands never enter the memo.
          const conversationCacheKey = [
            semanticNode.nodeId,
            meshSource.trim(),
            submissionCatalog.projects.map((project) => project.title).join("\u0001"),
            selectedTask?.title ?? "",
          ].join("\u0000");
          const cachedConversation = conversationCacheRef.current.get(conversationCacheKey);
          let interpreted: Awaited<ReturnType<typeof interpretInstruction>> | null = null;
          if (cachedConversation === null) {
            try {
              interpreted = await interpretInstruction({
                nodeId: semanticNode.nodeId,
                interpret: evidence,
              }).catch(() => null);
            } finally {
              if (activeInterpretRef.current?.requestId === turnRequestId) {
                activeInterpretRef.current = null;
              }
            }
          } else {
            activeInterpretRef.current = null;
          }
          const interpretedProposal =
            cachedConversation ??
            (interpreted !== null && interpreted._tag === "Success"
              ? interpreted.value
              : undefined);
          if (interpretedProposal !== undefined) {
            meshProposal = interpretedProposal;
            conversationCacheRef.current.set(conversationCacheKey, interpretedProposal);
            // A lookup or website launch is a bounded assistant action with no
            // project, task, provider, or thread. The model proposed it; the
            // node revalidates and runs the lookup, and the asking device opens
            // the site. The spoken sentence is then voiced by the live model.
            if (
              interpretedProposal.action === "lookup" &&
              interpretedProposal.lookup !== undefined &&
              interpretedProposal.lookup !== null
            ) {
              const lookup = interpretedProposal.lookup;
              const lookupResult = await quickLookup({
                environmentId: primaryEnvironmentId ?? semanticNode.nodeId,
                input: { ...lookup, sourceUtterance: meshSource.slice(0, 16_000) },
              }).catch(() => null);
              const value =
                lookupResult !== null && lookupResult._tag === "Success"
                  ? lookupResult.value
                  : null;
              emitFeedback({
                text: value?.message ?? "I couldn't complete that lookup. Try again in a moment.",
                kind:
                  value?.status === "answer"
                    ? "done"
                    : value?.status === "needs-input"
                      ? "needs-input"
                      : "error",
                inputMode,
                captureId: voiceSubmission.captureId,
                requestId: turnRequestId,
              });
              syncPending();
              return;
            }
            if (
              interpretedProposal.action === "open-website" &&
              typeof interpretedProposal.website === "string"
            ) {
              const opened = await openCirceWebsite(interpretedProposal.website);
              emitFeedback({
                text: opened
                  ? `Opening ${interpretedProposal.website} on this device.`
                  : `I couldn't open ${interpretedProposal.website} on this device.`,
                kind: opened ? "done" : "error",
                inputMode,
                captureId: voiceSubmission.captureId,
                requestId: turnRequestId,
              });
              syncPending();
              return;
            }
            // Converse is model-decided, never a pre-inference shortcut. Run
            // it project-free on the semantic node with the same request
            // identity so an explicit cancel aborts it. Answers stay
            // best-effort and never claim task progress.
            //
            // When any project is in scope — pinned, focused, or the lone
            // local project — the question runs as a durable provider thread:
            // the provider has tools, and the exchange stays visible and
            // reportable. Only a node with no project at all answers inline.
            if (
              interpretedProposal.action === "converse" &&
              routeCurrent === null &&
              conversationDefaultProjectRef === undefined
            ) {
              // The interpret call that classified this turn already carries
              // the spoken answer for converse; use it instead of paying a
              // second supervisor round trip. The dedicated converse call is
              // only for proposals that arrived without an answer.
              const proposalAnswer = interpretedProposal.answer?.trim();
              if (proposalAnswer !== undefined && proposalAnswer.length > 0) {
                emitFeedback({
                  text: proposalAnswer,
                  kind: "done",
                  inputMode,
                  captureId: voiceSubmission.captureId,
                  requestId: turnRequestId,
                });
                syncPending();
                return;
              }
              const converseResult = await converseInstruction({
                nodeId: semanticNode.nodeId,
                utterance: instruction.slice(0, 16_000),
                requestMetadata: {
                  requestId: turnRequestId,
                  origin: { originInteractionId: turnOrigin },
                },
              }).catch(() => null);
              if (converseResult !== null && converseResult._tag === "Success") {
                const value = converseResult.value;
                // A conversation is a complete turn with no task state to
                // resume: emit the answer and let the FIFO advance. Parking
                // here (the old behavior) stranded every later capture.
                if (value.status === "acknowledged") {
                  // Memoize the fallback answer too: a repeated identical
                  // question must not pay the supervisor again just because
                  // this proposal arrived without an answer.
                  conversationCacheRef.current.set(conversationCacheKey, {
                    action: "converse",
                    refs: [],
                    model: null,
                    effort: null,
                    answer: value.message,
                  });
                  emitFeedback({
                    text: value.message,
                    kind: "done",
                    inputMode,
                    captureId: voiceSubmission.captureId,
                    requestId: turnRequestId,
                  });
                  syncPending();
                  return;
                }
                if (value.status === "needs-input") {
                  emitFeedback({
                    text: value.prompt,
                    kind: "needs-input",
                    inputMode,
                    captureId: voiceSubmission.captureId,
                    requestId: turnRequestId,
                  });
                  syncPending();
                  return;
                }
                if (value.status === "cancelled") {
                  syncPending();
                  return;
                }
              }
              // Fall through to execute with the converse proposal when the
              // dedicated converse path is unavailable; the execution node
              // validates the same proposal without a second inference.
            }
          }
        }
        if (meshProposal !== undefined) {
          const route = resolveCirceProposalExecuteRoute(
            submissionCatalog,
            meshSource,
            meshProposal,
            routeCurrent === null
              ? null
              : {
                  projectRef: routeCurrent.projectRef,
                  ...(routeCurrent.contextThreadId === undefined
                    ? {}
                    : { contextThreadId: routeCurrent.contextThreadId }),
                },
          );
          if (route.status === "routed") {
            meshRoutedProject = route.project;
            const reread = await refreshMeshNode({ nodeId: route.project.ref.nodeId });
            if (reread._tag === "Failure") {
              const failure = squashAtomCommandFailure(reread);
              emitFeedback({
                text: circeErrorMessage(failure),
                kind: "error",
                inputMode,
                captureId: voiceSubmission.captureId,
                ...(voiceSubmission.requestId === undefined &&
                voiceSnapshot?.requestId === undefined
                  ? {}
                  : {
                      requestId:
                        voiceSubmission.requestId ?? voiceSnapshot?.requestId ?? randomUUID(),
                    }),
              });
              throw failure;
            }
            submissionCatalog = reread.value;
          } else if (route.status === "needs-choice") {
            const requestId = voiceSubmission.requestId ?? voiceSnapshot?.requestId ?? randomUUID();
            const prompt =
              `"${instruction.trim()}" names a project on more than one device. ` +
              `Which one should I use? Say its name with your instruction.`;
            voiceClarificationRef.current = {
              instruction,
              sourceUtterance: meshSource,
              clarification: {
                status: "needs-input",
                reason: "control-target-required",
                prompt,
                choices: route.candidates.map((candidate) => candidate.label),
              },
              projectCandidates: [...route.candidates],
              target: voiceSnapshot?.target ?? target,
              captureId: voiceSubmission.captureId,
              requestId,
              origin: "client",
              inputMode,
            };
            emitFeedback({
              text: prompt,
              kind: "needs-input",
              inputMode,
              captureId: voiceSubmission.captureId,
              requestId,
            });
            syncPending();
            return "pause" as const;
          } else if (route.status === "unavailable") {
            const message = `${route.project.title} is on ${route.nodeLabel}, which is disconnected. Reconnect it and try again.`;
            emitFeedback({
              text: message,
              kind: "error",
              inputMode,
              captureId: voiceSubmission.captureId,
              ...(voiceSubmission.requestId === undefined
                ? {}
                : { requestId: voiceSubmission.requestId }),
            });
            throw new Error(message);
          }
          // Uniqueness needs a complete catalog: the check runs once the
          // submission target is known (see below), so composer entries
          // without an explicit target are covered too.
        }
      }

      if (
        pendingVoiceClarification === null &&
        voiceSnapshot?.execution === undefined &&
        submissionCatalog !== null &&
        meshRoutedProject === undefined &&
        meshProposal === undefined
      ) {
        const grounding = groundCirceVoiceProjectMention({
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

          emitFeedback({
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

          emitFeedback({
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
              : circeMeshCatalogCoverage(submissionCatalog);
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

            emitFeedback({
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
      let submissionTarget: CirceVoiceTarget | null =
        pendingProjectChoice === null
          ? (pendingVoiceClarification?.target ?? voiceSnapshot?.target ?? target)
          : {
              projectRef: pendingProjectChoice.projectRef,
              ...(chosenProject === undefined ? {} : { projectTitle: chosenProject.title }),
            };
      if (groundedVoiceProject !== undefined) {
        // A qualified pinned followup keeps its task even when the wording
        // names another project: the followup belongs to its task, and the
        // server grounds the mention within the pinned project's own node.
        const mentionBase = voiceSnapshot?.target ?? target;
        const pinnedElsewhere =
          mentionBase?.contextThreadId !== undefined &&
          (mentionBase.projectRef.nodeId !== groundedVoiceProject.ref.nodeId ||
            mentionBase.projectRef.projectId !== groundedVoiceProject.ref.projectId);
        if (!pinnedElsewhere) {
          submissionTarget = resolveCirceVoiceMentionTarget({
            projectRef: groundedVoiceProject.ref,
            projectTitle: groundedVoiceProject.title,
            currentTarget: submissionTarget,
          });
        }
      }
      if (meshRoutedProject !== undefined) {
        // An explicit cross-node destination overrides the ambient target.
        // Pinned task followups never arrive here: the shared grounding
        // keeps them ambient instead of swapping projects mid-task.
        submissionTarget = resolveCirceVoiceMentionTarget({
          projectRef: meshRoutedProject.ref,
          projectTitle: meshRoutedProject.title,
          currentTarget: submissionTarget,
        });
      }
      if (
        meshProposal !== undefined &&
        meshProposal.action !== "converse" &&
        submissionCatalog !== null
      ) {
        // A name-dependent route is unsound while a peer catalog is unread:
        // an unread node may hold the same name, so confirm uniqueness
        // instead of dispatching. Name-independent turns stay on their path,
        // pinned followups never interrupt, and malformed proposals proceed
        // to authoritative execution clarification. With no target yet, a
        // single mentioned visible project confirms; anything else falls
        // through to the explicit choice question below.
        const coverageTargetRef = submissionTarget?.projectRef;
        const resolvedCoverageProject =
          meshRoutedProject ??
          (coverageTargetRef === undefined
            ? undefined
            : (submissionCatalog.projects.find(
                (candidate) =>
                  candidate.ref.nodeId === coverageTargetRef.nodeId &&
                  candidate.ref.projectId === coverageTargetRef.projectId,
              ) ?? undefined));
        const coverageConfirm = resolveCirceRouteCoverageConfirm({
          catalog: submissionCatalog,
          source: meshSource,
          proposal: meshProposal,
          resolved: resolvedCoverageProject,
          routed: meshRoutedProject !== undefined,
          pinned: submissionTarget?.contextThreadId !== undefined,
        });
        if (coverageConfirm.status === "confirm") {
          const requestId = voiceSubmission.requestId ?? voiceSnapshot?.requestId ?? randomUUID();
          const candidate = {
            ...coverageConfirm.project,
            label: `${coverageConfirm.project.title} — ${coverageConfirm.project.nodeLabel}`,
          };
          const prompt =
            `${coverageConfirm.nodeLabels.join(", ")} ${coverageConfirm.nodeLabels.length === 1 ? "is" : "are"} unreachable, so I can't tell if the name is unique. ` +
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
          emitFeedback({
            text: prompt,
            kind: "needs-input",
            inputMode,
            captureId: voiceSubmission.captureId,
            requestId,
          });
          syncPending();
          return "pause" as const;
        }
      }
      if (
        submissionTarget === null &&
        conversationDefaultProjectRef !== undefined &&
        meshProposal?.action === "converse"
      ) {
        // Only a general question takes the automatic home. An unqualified
        // command keeps the explicit project question.
        submissionTarget = { projectRef: conversationDefaultProjectRef };
      }
      if (submissionTarget === null && submissionCatalog !== null) {
        // No unsafe single-global-project fallback: an unqualified request
        // must clarify explicitly. The local-background default already
        // covers the lone-local-project case via resolveCirceVoiceDefaultTarget.
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

        emitFeedback({
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
        emitFeedback({
          text: catalogPending
            ? "I'm still loading your registered projects. Try again in a moment."
            : "Choose a project before running.",
          kind: "needs-input",
          inputMode,
          captureId: voiceSubmission.captureId,
        });
        return;
      }

      if (
        pendingVoiceClarification === null &&
        voiceSnapshot?.execution === undefined &&
        submissionTarget.contextThreadId !== undefined
      ) {
        // A fresh interaction observes the current pending request from the
        // exact task's authoritative desk state. The stored snapshot may
        // predate a newly arrived approval; an unknown desk keeps the
        // retained pin instead of inventing one. Bound answers (a paused
        // clarification) keep their identity and never rebind here.
        const deskTasks = await readDeskTasks(submissionTarget.projectRef.nodeId);
        if (deskTasks !== undefined) {
          const resolved = resolveCirceLiveContextTask({
            selected: {
              threadId: submissionTarget.contextThreadId,
              ...(submissionTarget.taskRef === undefined
                ? {}
                : { taskRef: submissionTarget.taskRef }),
              projectRef: submissionTarget.projectRef,
              ...(submissionTarget.pendingReply === undefined
                ? {}
                : { pendingReply: submissionTarget.pendingReply }),
            },
            deskTasks,
          });
          if (
            resolved !== undefined &&
            resolved !== null &&
            !isSameCirceReplyPin(resolved.pendingReply, submissionTarget.pendingReply)
          ) {
            submissionTarget = {
              ...submissionTarget,
              ...(resolved.pendingReply === undefined
                ? {}
                : { pendingReply: resolved.pendingReply }),
            };
            // Keep the snapshot display current without changing identity.
            const current = selectedTaskRef.current;
            if (
              current !== null &&
              current.threadId === submissionTarget.contextThreadId &&
              current.projectRef.nodeId === submissionTarget.projectRef.nodeId &&
              current.projectRef.projectId === submissionTarget.projectRef.projectId
            ) {
              setSelectedTask(
                toSelectedTask({
                  projectRef: current.projectRef,
                  threadId: current.threadId,
                  ...(current.title === undefined ? {} : { title: current.title }),
                  ...(current.taskRef === undefined ? {} : { taskRef: current.taskRef }),
                  ...(resolved.pendingReply === undefined
                    ? {}
                    : { pendingReply: resolved.pendingReply }),
                }),
              );
              setTargetVersion((version) => version + 1);
            }
          }
        }
      }

      submissionBusyRef.current = true;
      syncPending();

      try {
        // Reuse the interpret request identity for the fresh proposal path so
        // one explicit cancel addresses both phases. Clarification answers
        // and bound retries keep their own parked identity.
        const requestId =
          pendingVoiceClarification?.requestId ??
          (voiceSnapshot?.execution !== undefined || meshProposal === undefined
            ? (voiceSubmission.requestId ?? voiceSnapshot?.requestId ?? randomUUID())
            : turnRequestId);
        emitFeedback({
          text: formatCirceVoiceDispatching(capturedInstruction),
          kind: "working",
          inputMode,
          captureId: voiceSubmission.captureId,
          requestId,
          speak: false,
        });
        let commandResult;
        try {
          const answerPin = expectedReplyForTarget(submissionTarget);
          const executeInput = voiceSnapshot?.execution ?? {
            kind: "control",
            projectRef: submissionTarget.projectRef,
            requestMetadata: buildCirceRequestMetadata({
              requestId,
              originInteractionId: circeReporterIdentity(),
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
            // A client-resolved project answer overrides the misheard name in
            // the source: the Director drops only the unknown destination ref
            // and uses this exact node-qualified identity instead of asking
            // again for the same name.
            ...(pendingProjectChoice === null
              ? {}
              : { confirmedProjectId: submissionTarget.projectRef.projectId }),
            ...(modelSelectionOverride === null ? {} : { modelSelection: modelSelectionOverride }),
            // Proposal-first handoff: the execution node schema-validates the
            // nonauthoritative proposal and revalidates every ref against its
            // authoritative catalog, tasks, providers, and pins. No second
            // inference. Verbatim source preserves span offsets.
            ...(meshProposal === undefined ? {} : { semanticProposal: meshProposal }),
            ...(meshProposal === undefined ? {} : { sourceUtterance: meshSource.slice(0, 16_000) }),
            utterance: instruction,
          };
          // A dispatch binds the full request, including an unknown/null pin.
          // A retry reuses it even if the desk or catalog has since changed.
          if (pendingVoiceClarification === null) {
            voiceSubmissionSnapshotsRef.current.set(voiceSubmission.captureId, {
              requestId,
              target: submissionTarget,
              execution: executeInput,
            });
          }
          // Track the exact identity on the wire so cancel and correction
          // address the same acceptance key the server tracks pre-accept.
          activeRequestRef.current = {
            captureId: voiceSubmission.captureId,
            requestId,
            nodeId: submissionTarget.projectRef.nodeId,
            ...(executeInput.requestMetadata.origin === undefined
              ? {}
              : { origin: executeInput.requestMetadata.origin }),
          };
          commandResult = await executeInstruction(executeInput);
        } catch (cause) {
          emitFeedback({
            text: circeErrorMessage(cause),
            kind: "error",
            inputMode,
            captureId: voiceSubmission.captureId,
            requestId,
          });
          // A failed answer keeps its clarification parked: the request is
          // still live server-side, so the retry answers the same frame and
          // pin instead of stranding in the queue's failed set.
          if (pendingVoiceClarification !== null) return "pause" as const;
          throw cause;
        }
        if (commandResult._tag === "Failure") {
          const message = circeErrorMessage(squashAtomCommandFailure(commandResult));

          emitFeedback({
            text: message,
            kind: "error",
            inputMode,
            captureId: voiceSubmission.captureId,
            requestId,
          });
          if (pendingVoiceClarification !== null) return "pause" as const;
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
        if (result.status === "cancelled") {
          // Pre-accept cancel won server-side: nothing was dispatched, so
          // the queue item completes without parking in the failed set and
          // the next queued correction runs. Speech for the obsolete request
          // is retracted on every owned lane.
          voiceSubmissionSnapshotsRef.current.delete(voiceSubmission.captureId);
          cancelInteractionSpeech();
          interruptCirceReportSpeech();
          const feedback = circeExecutionFeedback(result);
          emitFeedback({
            text: feedback.speech,
            kind: "done",
            inputMode,
            captureId: voiceSubmission.captureId,
            requestId,
            // Silent: the obsolete request must never speak over the queued
            // correction that superseded it.
            speak: false,
          });
          syncPending();
          return;
        }
        if (result.status === "acknowledged") {
          voiceSubmissionSnapshotsRef.current.delete(voiceSubmission.captureId);
          if (pendingVoiceClarification?.captureId !== undefined) {
            voiceSubmissionSnapshotsRef.current.delete(pendingVoiceClarification.captureId);
          }
          if (pendingVoiceClarification !== null) voiceClarificationRef.current = null;
          const feedback = circeExecutionFeedback(result);
          emitFeedback({
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
              const focusProjectRef: CirceProjectRef = {
                nodeId: ackTaskRef.executionNodeId,
                projectId: result.projectId,
              };
              let focusTitle: string | undefined;
              let focusPin: CirceTaskPendingReply | null = null;
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
        const feedback = circeExecutionFeedback(result);
        emitFeedback({
          text: feedback.speech,
          kind: "done",
          inputMode,
          captureId: voiceSubmission.captureId,
          requestId,
          threadId: result.threadId,
          ...(result.taskRef === undefined ? {} : { taskRef: result.taskRef }),
          ...("turnId" in result && result.turnId !== undefined ? { turnId: result.turnId } : {}),
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
          const resultProjectRef: CirceProjectRef = {
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
        activeRequestRef.current = null;
        // The queue publishes again after it removes, pauses, or retains
        // this item. Include failed items instead of guessing its next size.
        syncPending();
      }
    },
    [
      catalog,
      catalogPending,
      catalogReady,
      quickLookup,
      converseInstruction,
      executeInstruction,
      interpretInstruction,
      getTaskDesk,
      onTargetConsumed,
      onThreadStarted,
      primaryEnvironmentId,
      syncPending,
      cancelInteractionSpeech,
      emitFeedback,
      originNodeId,
      readDeskPin,
      readDeskTasks,
      refreshMesh,
      refreshMeshNode,
      resolveVoiceModelAnswer,
      storeServerClarification,
      target,
      taskDesks,
    ],
  );

  submitVoiceInstructionRef.current = (submission) => submit(submission);

  useEffect(() => {
    if (voiceSubmissionReadyRef.current) void voiceSubmissionQueueRef.current?.drain();
  }, [catalogReady, target]);

  // Disposal retracts owned interaction speech so a clarifying prompt never
  // outlives its runtime. A new capture taking the floor retracts it the
  // same way through a typed bus action, never by reaching into the lane.
  // A terminal retracts only its own turn: the browser owner drops the
  // matching utterance, so another task or turn keeps playing.
  useEffect(
    () => onInterruptCirceInteractionSpeech(() => cancelInteractionSpeech()),
    [cancelInteractionSpeech],
  );
  useEffect(
    () =>
      onCirceSpeechTerminal((event) => {
        // Record the terminal in shared relevance first so a delayed ack
        // that arrives after this event is vetoed at speak time no matter
        // which producer published it. Retract live browser deliveries for
        // the turn; the report queue does the same at enqueue, and a second
        // cancel of an already-gone delivery is a no-op.
        for (const deliveryId of noteCirceSpeechTerminal(event)) {
          cancelBrowserSpeech(deliveryId);
        }
        interactionSpeechRef.current?.cancelMatching(event);
      }),
    [],
  );
  useEffect(() => () => cancelInteractionSpeech(), [cancelInteractionSpeech]);

  return null;
}
