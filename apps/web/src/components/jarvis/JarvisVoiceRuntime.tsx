import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import {
  jarvisMeshCatalogCoverage,
  type JarvisMeshProject,
  type JarvisMeshProjectCandidate,
} from "@t3tools/jarvis-client-runtime/jarvis/mesh";
import {
  answerJarvisModelChoice,
  isJarvisModelClarificationReason,
  type JarvisModelDraft,
} from "@t3tools/jarvis-core/modelChoice";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  JarvisNeedsInput,
  JarvisProjectRef,
  JarvisTaskDeskTaskView,
  JarvisTaskRef,
  ModelSelection,
  ThreadId,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { JarvisCommandTarget } from "../../jarvisBus";
import { jarvisReporterIdentity } from "../../jarvisIdentity";
import { randomUUID } from "../../lib/utils";
import { jarvisMeshEnvironment } from "../../state/jarvisMesh";
import { jarvisMeshCatalogAtom } from "../../state/jarvisMesh";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  groundJarvisVoiceProjectMention,
  jarvisRecognitionContextPhrases,
} from "./JarvisNativeCapture";
import {
  applyJarvisClarificationChoice,
  buildJarvisRequestMetadata,
  desktopVoiceAllowsBrowserFallback,
  jarvisErrorMessage,
  jarvisExecutionFeedback,
  resolveJarvisVoiceDefaultTarget,
  resolveJarvisVoiceMentionTarget,
  jarvisManagerCatalogIsReady,
  createJarvisVoiceSubmissionQueue,
  isJarvisVoiceClarificationDiscard,
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

interface JarvisVoiceTarget {
  readonly projectRef: JarvisProjectRef;
  readonly projectTitle?: string;
  readonly contextThreadId?: ThreadId;
  readonly contextThreadTitle?: string;
  readonly referenceThreadId?: ThreadId;
  readonly taskRef?: JarvisTaskRef;
}

export function JarvisVoiceRuntime({
  routeTarget,
  onTargetConsumed,
  onThreadStarted,
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
  const [selectedTask, setSelectedTask] = useState<{
    readonly nodeId: EnvironmentId;
    readonly task: JarvisTaskDeskTaskView;
  } | null>(null);
  const submissionBusyRef = useRef(false);
  const voiceClarificationRef = useRef<{
    readonly instruction: string;
    readonly sourceUtterance: string;
    readonly clarification: JarvisNeedsInput;
    readonly target: JarvisVoiceTarget | null;
    readonly projectCandidates?: ReadonlyArray<JarvisMeshProjectCandidate>;
    readonly acceptsAffirmation?: boolean;
    readonly captureId: string;
    readonly requestId: string;
    readonly modelDraft?: JarvisModelDraft;
  } | null>(null);
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
  const target: JarvisVoiceTarget | null = targetProjectRef
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

  const catalogReady = jarvisManagerCatalogIsReady({
    catalogLoaded:
      catalog?.nodes.some(
        (node) =>
          node.reachability === "online" &&
          node.catalogPending !== true &&
          node.catalogError === undefined,
      ) === true,
    catalogPending: false,
    catalogError,
  });
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
  }, [catalog, primaryEnvironmentId, routeTarget, selectedProjectRef, selectedTask, taskDesks]);

  useEffect(() => {
    if (catalog === null) return;
    if (selectedProjectRef !== null || selectedTask !== null) return;
    if (routeTarget !== null) return;
    if (catalog.projects.length === 1) {
      setSelectedProjectRef(catalog.projects[0]!.ref);
    }
  }, [catalog, routeTarget, selectedProjectRef, selectedTask]);

  useEffect(() => {
    const voice = window.desktopBridge?.jarvisVoice;
    if (voice === undefined) return;
    const enqueueVoiceTranscript = (input: {
      readonly captureId: string;
      readonly transcript: string;
      readonly sourceTranscript?: string;
      readonly requestId?: string;
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
        ...(input.sourceTranscript === undefined
          ? {}
          : { sourceTranscript: input.sourceTranscript }),
        ...(snapshot === undefined ? {} : { requestId: snapshot.requestId }),
      });
      if (enqueueResult === "enqueued") void voiceSubmissionQueueRef.current?.drain();
      else if (enqueueResult === "full") {
        const message = "Voice requests are backed up. Wait for one to finish, then try again.";

        speakJarvisText(message);
      }
    };

    const unsubscribeTranscript = voice.onTranscript((transcript, event) => {
      if (!shouldSubmitJarvisVoiceTranscript(event?.purpose)) return;
      if (isJarvisVoiceGarbageTranscript(transcript)) {
        speakJarvisText("I couldn't hear you. Try that again.");

        return;
      }
      const captureId = event?.captureId ?? randomUUID();
      const pendingClarification = voiceClarificationRef.current;
      if (pendingClarification !== null) {
        if (isJarvisVoiceClarificationDiscard(transcript)) {
          voiceClarificationRef.current = null;
          voiceSubmissionSnapshotsRef.current.delete(pendingClarification.captureId);

          const discarded =
            voiceSubmissionQueueRef.current?.discard(pendingClarification.captureId) === true;
          speakJarvisText(
            discarded
              ? "Okay, I discarded that request."
              : "That voice request was no longer pending.",
          );

          return;
        }
        voiceSubmissionQueueRef.current?.resume(pendingClarification.captureId, {
          captureId: pendingClarification.captureId,
          transcript,
          sourceTranscript: pendingClarification.sourceUtterance,
          requestId: pendingClarification.requestId,
        });

        return;
      }
      enqueueVoiceTranscript({
        captureId,
        transcript,
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
        };

        speakJarvisText(result.prompt);
        return "paused";
      }
      return { instruction: pending.instruction, selection: result.selection };
    },
    [],
  );

  const submit = useCallback(
    async (voiceSubmission: JarvisVoiceSubmission) => {
      const capturedInstruction = voiceSubmission.transcript;
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
      if (submissionBusyRef.current || !catalogReady || instruction.trim().length === 0) return;
      if (
        pendingVoiceClarification?.projectCandidates !== undefined &&
        pendingProjectChoice === null
      ) {
        const message = "I couldn't match that project. Say its name or give its number.";

        speakJarvisText(message);
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
          const message = jarvisErrorMessage(failure);

          speakJarvisText(message);
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
          };

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

        speakJarvisText(message);
        return "pause" as const;
      }

      submissionBusyRef.current = true;

      try {
        const requestId =
          pendingVoiceClarification?.requestId ??
          voiceSubmission.requestId ??
          voiceSnapshot?.requestId ??
          randomUUID();
        let commandResult;
        try {
          void playJarvisAcknowledgement();
          void window.desktopBridge?.jarvisVoice?.prepareSpeech().catch(() => undefined);
          const execution = executeInstruction({
            kind: "control",
            projectRef: submissionTarget.projectRef,
            requestMetadata: buildJarvisRequestMetadata({
              requestId,
              originInteractionId: jarvisReporterIdentity(),
              originNodeId,
              inputMode: "voice",
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
            ...(modelSelectionOverride === null ? {} : { modelSelection: modelSelectionOverride }),
            utterance: instruction,
          });
          commandResult = await execution;
        } catch (cause) {
          const message = jarvisErrorMessage(cause);

          speakJarvisText(message);
          throw cause;
        }
        if (commandResult._tag === "Failure") {
          const message = jarvisErrorMessage(squashAtomCommandFailure(commandResult));

          speakJarvisText(message);
          throw new Error(message);
        }
        const result = commandResult.value;
        if (result.status === "needs-input") {
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

          const feedback = jarvisExecutionFeedback(result);
          speakJarvisText(feedback.speech);
          return "pause" as const;
        }
        if (result.status === "acknowledged") {
          voiceSubmissionSnapshotsRef.current.delete(voiceSubmission.captureId);
          if (pendingVoiceClarification?.captureId !== undefined) {
            voiceSubmissionSnapshotsRef.current.delete(pendingVoiceClarification.captureId);
          }
          if (pendingVoiceClarification !== null) voiceClarificationRef.current = null;
          const feedback = jarvisExecutionFeedback(result);
          speakJarvisText(feedback.speech);
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
        speakJarvisText(feedback.speech);
        onTargetConsumed();
        await onThreadStarted(
          result.taskRef?.executionNodeId ?? submissionTarget.projectRef.nodeId,
          result.threadId,
        );
      } finally {
        submissionBusyRef.current = false;
      }
    },
    [
      catalog,
      catalogPending,
      catalogReady,
      executeInstruction,
      onTargetConsumed,
      onThreadStarted,
      originNodeId,
      refreshMesh,
      refreshMeshNode,
      resolveVoiceModelAnswer,
      target,
    ],
  );

  submitVoiceInstructionRef.current = (submission) => submit(submission);

  useEffect(() => {
    if (voiceSubmissionReadyRef.current) void voiceSubmissionQueueRef.current?.drain();
  }, [catalogReady, target]);

  return null;
}
