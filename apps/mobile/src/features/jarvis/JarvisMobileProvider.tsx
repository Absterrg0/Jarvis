import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Haptics from "expo-haptics";
import { AppState, type AppStateStatus } from "react-native";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  EnvironmentId,
  JarvisPresentationEvent,
  JarvisTaskDeskView,
} from "@t3tools/contracts";
import type {
  JarvisMeshCatalog,
  JarvisMeshProject,
} from "@t3tools/jarvis-client-runtime/jarvis/mesh";

import { uuidv4 } from "../../lib/uuid";
import { useThreadShells } from "../../state/entities";
import { jarvisEnvironment } from "../../state/jarvis";
import { jarvisMeshEnvironment } from "../../state/jarvisMesh";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { useAtomCommand as useMobileAtomCommand } from "../../state/use-atom-command";
import {
  attachMobileJarvisTask,
  createMobileJarvisTurn,
  routeMobileJarvisTurn,
  type MobileJarvisDraft,
  type MobileJarvisTurn,
} from "./mobileJarvisTurn";
import {
  mobileSpeechKindForPresentation,
  mobileSpeechText,
  shouldSpeakMobile,
} from "./mobileSpeechPolicy";
import {
  hasEnvironmentConnected,
  isAppForegroundTransition,
  isSelectedTaskDeskNodeCatalogued,
} from "./jarvisMobileForegroundRefresh";
import { resolveMobileJarvisProject } from "./mobileJarvisSelection";
import {
  resolveMobileJarvisInstructionRoute,
  resolveMobileJarvisRouteChoice,
  type MobileJarvisPendingRoute,
} from "./mobileJarvisRouting";

type SpeechSink = (text: string, nodeId: EnvironmentId) => void;

export type MobileJarvisPresentation = {
  readonly event: JarvisPresentationEvent;
  readonly executionNodeId: EnvironmentId;
};

type JarvisControllerValue = {
  readonly catalog: JarvisMeshCatalog | null;
  readonly taskDeskNodeId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly selectedProject: JarvisMeshProject | undefined;
  readonly desk: JarvisTaskDeskView | null;
  readonly presentations: ReadonlyArray<MobileJarvisPresentation>;
  readonly message: string | null;
  readonly refreshing: boolean;
  readonly submitting: boolean;
  readonly preparedOriginInteractionId: string;
  readonly refresh: () => Promise<void>;
  readonly selectTaskDeskNode: (nodeId: EnvironmentId) => void;
  readonly selectProject: (project: JarvisMeshProject) => void;
  readonly focusTask: (task: JarvisTaskDeskView["recentTasks"][number]) => Promise<void>;
  readonly runInstruction: (draft: MobileJarvisDraft, text: string) => Promise<void>;
  readonly createTextTurn: () => MobileJarvisDraft;
  readonly setMessage: (message: string | null) => void;
  readonly attachSpeechSink: (sink: SpeechSink) => () => void;
};

const JarvisControllerContext = createContext<JarvisControllerValue | null>(null);

export const mobileJarvisProjectKey = (project: JarvisMeshProject): string =>
  `${project.ref.nodeId}:${project.ref.projectId}`;

function commandError(result: { readonly _tag: string; readonly cause?: unknown }): string {
  if (result._tag !== "Failure") return "";
  return result.cause instanceof Error ? result.cause.message : "The Jarvis request failed.";
}

function nextOriginInteractionId(): string {
  return `mobile-jarvis-${uuidv4()}`;
}

export function JarvisMobileProvider(props: { readonly children: ReactNode }) {
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const threadShells = useThreadShells();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const refreshMesh = useMobileAtomCommand(jarvisMeshEnvironment.refresh, {
    reportFailure: false,
    reportDefect: false,
  });
  const execute = useMobileAtomCommand(jarvisMeshEnvironment.execute, {
    reportFailure: false,
    reportDefect: false,
  });
  const converse = useMobileAtomCommand(jarvisMeshEnvironment.converse, {
    reportFailure: false,
    reportDefect: false,
  });
  const getTaskDesk = useMobileAtomCommand(jarvisMeshEnvironment.getTaskDesk, {
    reportFailure: false,
    reportDefect: false,
  });
  const focusTaskCommand = useMobileAtomCommand(jarvisMeshEnvironment.focusTask, {
    reportFailure: false,
    reportDefect: false,
  });
  const [catalog, setCatalog] = useState<JarvisMeshCatalog | null>(null);
  const [taskDeskNodeId, setTaskDeskNodeId] = useState<EnvironmentId | null>(null);
  const taskDeskNodeIdRef = useRef<EnvironmentId | null>(null);
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(null);
  const [desk, setDesk] = useState<JarvisTaskDeskView | null>(null);
  // Which desk node's snapshot `desk` belongs to. A desk snapshot is only
  // authoritative for routing while it matches the selected desk node: after
  // a node switch the previous snapshot is stale until the new one arrives.
  const [deskNodeId, setDeskNodeId] = useState<EnvironmentId | null>(null);
  const [presentations, setPresentations] = useState<MobileJarvisPresentation[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [preparedOriginInteractionId, setPreparedOriginInteractionId] =
    useState(nextOriginInteractionId);
  const [activeTurns, setActiveTurns] = useState<MobileJarvisTurn[]>([]);
  const activeTurnsRef = useRef(new Map<string, MobileJarvisTurn>());
  const deskRequestGeneration = useRef(0);
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const previousConnectionStates = useRef<ReadonlyMap<
    EnvironmentId,
    EnvironmentConnectionPhase
  > | null>(null);
  const speechSink = useRef<SpeechSink | null>(null);
  const pendingRoute = useRef<{
    readonly draft: MobileJarvisDraft;
    readonly route: MobileJarvisPendingRoute;
  } | null>(null);

  const preferencesReady = AsyncResult.isSuccess(preferencesResult);
  const preferredProjectRef = preferencesReady
    ? preferencesResult.value.preferredJarvisProjectRef
    : undefined;
  const recentThreadProjectRefs = useMemo(
    () =>
      [...threadShells]
        .filter((thread) => thread.archivedAt === null)
        .sort((left, right) =>
          (right.latestUserMessageAt ?? right.updatedAt).localeCompare(
            left.latestUserMessageAt ?? left.updatedAt,
          ),
        )
        .map((thread) => ({
          nodeId: thread.environmentId,
          projectId: thread.projectId,
        })),
    [threadShells],
  );
  const activityProjectRefs = [
    ...(desk?.focusedTask === null || desk?.focusedTask === undefined
      ? []
      : [desk.focusedTask.projectRef]),
    ...(desk?.recentTasks.map((task) => task.projectRef) ?? []),
    ...recentThreadProjectRefs,
  ];
  const selectedProject =
    catalog === null || (!preferencesReady && selectedProjectKey === null)
      ? undefined
      : resolveMobileJarvisProject({
          projects: catalog.projects,
          selectedProjectKey,
          preferredProjectRef,
          activityProjectRefs,
          projectKey: mobileJarvisProjectKey,
        });
  const resolvedSelectedProjectKey =
    selectedProject === undefined ? null : mobileJarvisProjectKey(selectedProject);

  const replaceActiveTurn = useCallback((turn: MobileJarvisTurn | null) => {
    if (turn === null) return;
    activeTurnsRef.current.set(turn.originInteractionId, turn);
    setActiveTurns(Array.from(activeTurnsRef.current.values()));
  }, []);

  const removeActiveTurn = useCallback((originInteractionId: string) => {
    activeTurnsRef.current.delete(originInteractionId);
    setActiveTurns(Array.from(activeTurnsRef.current.values()));
  }, []);

  const refreshTaskDesk = useCallback(
    async (nodeId: EnvironmentId) => {
      const generation = ++deskRequestGeneration.current;
      const result = await getTaskDesk({ nodeId });
      if (generation !== deskRequestGeneration.current || taskDeskNodeIdRef.current !== nodeId) {
        return;
      }
      if (result._tag === "Success") {
        setDesk(result.value);
        setDeskNodeId(nodeId);
      } else setMessage(commandError(result));
    },
    [getTaskDesk],
  );

  const refresh = useCallback(async () => {
    const existingRefresh = refreshInFlight.current;
    if (existingRefresh !== null) return existingRefresh;

    const runRefresh = async () => {
      setRefreshing(true);
      try {
        const result = await refreshMesh(undefined);
        if (result._tag !== "Success") {
          setMessage(commandError(result));
          return;
        }

        setCatalog(result.value);
        setMessage(null);
        const selectedNodeId = taskDeskNodeIdRef.current;
        if (
          selectedNodeId !== null &&
          isSelectedTaskDeskNodeCatalogued(result.value, selectedNodeId)
        ) {
          await refreshTaskDesk(selectedNodeId);
        } else if (selectedNodeId !== null) {
          deskRequestGeneration.current += 1;
          setDesk(null);
          setDeskNodeId(null);
        }
      } finally {
        setRefreshing(false);
      }
    };

    const refreshPromise = runRefresh().finally(() => {
      if (refreshInFlight.current === refreshPromise) refreshInFlight.current = null;
    });
    refreshInFlight.current = refreshPromise;
    return refreshPromise;
  }, [refreshMesh, refreshTaskDesk]);

  useEffect(() => {
    const nextConnectionStates = new Map(
      connectedEnvironments.map((environment) => [
        environment.environmentId,
        environment.connectionState,
      ]),
    );
    const previous = previousConnectionStates.current;
    previousConnectionStates.current = nextConnectionStates;
    if (hasEnvironmentConnected(previous, connectedEnvironments)) void refresh();
  }, [connectedEnvironments, refresh]);

  useEffect(() => {
    const previousAppState = { current: AppState.currentState };
    const subscription = AppState.addEventListener("change", (nextState: AppStateStatus) => {
      if (isAppForegroundTransition(previousAppState.current, nextState)) void refresh();
      previousAppState.current = nextState;
    });
    return () => subscription.remove();
  }, [refresh]);

  useEffect(() => {
    if (catalog === null) return;
    const selectedDeskNode = catalog.nodes.find((node) => node.nodeId === taskDeskNodeId);
    if (taskDeskNodeId === null) {
      const nextNodeId =
        catalog.nodes.find((node) => node.reachability === "online")?.nodeId ??
        catalog.nodes[0]?.nodeId ??
        null;
      taskDeskNodeIdRef.current = nextNodeId;
      setTaskDeskNodeId(nextNodeId);
    } else if (selectedDeskNode === undefined) {
      deskRequestGeneration.current += 1;
      setDesk(null);
      setDeskNodeId(null);
    }
    const project = catalog.projects.find(
      (candidate) => mobileJarvisProjectKey(candidate) === selectedProjectKey,
    );
    if (selectedProjectKey !== null && project === undefined) setSelectedProjectKey(null);
  }, [catalog, selectedProjectKey, taskDeskNodeId]);

  useEffect(() => {
    if (selectedProject === undefined) return;
    const projectKey = mobileJarvisProjectKey(selectedProject);
    if (selectedProjectKey !== projectKey) setSelectedProjectKey(projectKey);
    if (taskDeskNodeIdRef.current !== selectedProject.ref.nodeId) {
      taskDeskNodeIdRef.current = selectedProject.ref.nodeId;
      setTaskDeskNodeId(selectedProject.ref.nodeId);
    }
    if (
      preferencesReady &&
      (preferredProjectRef?.nodeId !== selectedProject.ref.nodeId ||
        preferredProjectRef?.projectId !== selectedProject.ref.projectId)
    ) {
      savePreferences({ preferredJarvisProjectRef: selectedProject.ref });
    }
  }, [preferencesReady, preferredProjectRef, savePreferences, selectedProject, selectedProjectKey]);

  useEffect(() => {
    if (taskDeskNodeId === null) {
      deskRequestGeneration.current += 1;
      setDesk(null);
      setDeskNodeId(null);
      return;
    }
    void refreshTaskDesk(taskDeskNodeId);
  }, [refreshTaskDesk, taskDeskNodeId]);

  const selectTaskDeskNode = useCallback((nodeId: EnvironmentId) => {
    taskDeskNodeIdRef.current = nodeId;
    setTaskDeskNodeId(nodeId);
  }, []);

  const selectProject = useCallback(
    (project: JarvisMeshProject) => {
      setSelectedProjectKey(mobileJarvisProjectKey(project));
      taskDeskNodeIdRef.current = project.ref.nodeId;
      setTaskDeskNodeId(project.ref.nodeId);
      savePreferences({ preferredJarvisProjectRef: project.ref });
    },
    [savePreferences],
  );

  const focusTask = useCallback(
    async (task: JarvisTaskDeskView["recentTasks"][number]) => {
      const nodeId = task.taskRef.executionNodeId;
      const generation = ++deskRequestGeneration.current;
      const result = await focusTaskCommand({
        nodeId,
        task: { threadId: task.threadId, taskRef: task.taskRef },
      });
      if (generation !== deskRequestGeneration.current) return;
      if (result._tag !== "Success") {
        if (taskDeskNodeIdRef.current !== nodeId) return;
        setMessage(commandError(result));
        return;
      }
      // A focused task becomes the ambient Jarvis context, so a follow-up
      // like "continue fixing it" routes to this task's project.
      const projectKey = `${task.projectRef.nodeId}:${task.projectRef.projectId}`;
      setSelectedProjectKey(projectKey);
      savePreferences({ preferredJarvisProjectRef: task.projectRef });
      if (taskDeskNodeIdRef.current !== nodeId) {
        taskDeskNodeIdRef.current = nodeId;
        setTaskDeskNodeId(nodeId);
      }
      setDesk(result.value);
      setDeskNodeId(nodeId);
    },
    [focusTaskCommand, savePreferences],
  );

  const createTextTurn = useCallback((): MobileJarvisDraft => {
    return createMobileJarvisTurn({
      originInteractionId: preparedOriginInteractionId,
      inputMode: "text",
    });
  }, [preparedOriginInteractionId]);

  const runInstruction = useCallback(
    async (draft: MobileJarvisDraft, text: string) => {
      const utterance = text.trim();
      if (utterance.length === 0 || submittingRef.current) return;
      const pending = pendingRoute.current;
      const chosenRoute =
        pending === null
          ? null
          : resolveMobileJarvisRouteChoice({ pending: pending.route, answer: utterance });
      if (pending !== null && chosenRoute === null) {
        const rejectedConfirmation =
          pending.route.acceptsAffirmation &&
          /^(?:no|nope|cancel|nevermind|never mind)$/iu.test(utterance);
        if (rejectedConfirmation) {
          pendingRoute.current = null;
          setPreparedOriginInteractionId(nextOriginInteractionId());
          setMessage("Okay. Say the project name with your next instruction.");
          return;
        }
        const retryMessage = "I couldn't match that project. Say its name or number.";
        setMessage(retryMessage);
        if (draft.speechEnabled && shouldSpeakMobile("needs-input")) {
          speechSink.current?.(retryMessage, draft.voiceNodeId);
        }
        return;
      }
      const route =
        chosenRoute ??
        resolveMobileJarvisInstructionRoute({
          utterance,
          inputMode: draft.inputMode,
          projects: catalog?.projects ?? [],
          ambientProject: selectedProject,
          nodes: catalog?.nodes ?? [],
          // Conservative: the converse shortcut needs a positively current
          // "no focused task" snapshot. Unknown (desk not loaded yet) or
          // stale (desk belongs to another node) defers to server execution.
          focusedTaskState:
            desk === null || deskNodeId !== taskDeskNodeIdRef.current
              ? "unknown"
              : desk.focusedTask != null
                ? "focused"
                : "unfocused",
        });
      const routedDraft = pending === null ? draft : pending.draft;
      if (route.status === "unavailable") {
        setPreparedOriginInteractionId(nextOriginInteractionId());
        setMessage(route.message);
        if (draft.speechEnabled && shouldSpeakMobile("failed")) {
          speechSink.current?.(route.message, draft.voiceNodeId);
        }
        return;
      }
      if (route.status === "needs-input") {
        pendingRoute.current = { draft, route };
        setPreparedOriginInteractionId(nextOriginInteractionId());
        const choices = route.candidates
          .map(({ label }, index) => `${index + 1}. ${label}`)
          .join("  ");
        const prompt = choices.length === 0 ? route.prompt : `${route.prompt} ${choices}`;
        setMessage(prompt);
        if (draft.speechEnabled && shouldSpeakMobile("needs-input")) {
          speechSink.current?.(prompt, draft.voiceNodeId);
        }
        return;
      }
      pendingRoute.current = null;
      if (route.status === "converse") {
        // Project-free conversation: no project selection, desk, or task
        // state is touched. Answers are best-effort, never receipt-backed.
        submittingRef.current = true;
        setSubmitting(true);
        setMessage(null);
        setPreparedOriginInteractionId(nextOriginInteractionId());
        if (routedDraft.speechEnabled) {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
        }
        const result = await converse({
          nodeId: route.nodeId,
          utterance: route.utterance,
        }).finally(() => {
          submittingRef.current = false;
          setSubmitting(false);
        });
        if (result._tag !== "Success") {
          const failure = commandError(result);
          setMessage(failure);
          if (routedDraft.speechEnabled && shouldSpeakMobile("failed")) {
            speechSink.current?.(failure, routedDraft.voiceNodeId);
          }
          return;
        }
        if (result.value.status === "needs-input") {
          setMessage(result.value.prompt);
          if (routedDraft.speechEnabled) {
            speechSink.current?.(result.value.prompt, routedDraft.voiceNodeId);
          }
          return;
        }
        if (result.value.status !== "acknowledged") {
          // Converse answers are acknowledged or needs-input; anything else
          // is unexpected, so fall back instead of guessing at its shape.
          const failure = "I couldn't answer that just now.";
          setMessage(failure);
          if (routedDraft.speechEnabled && shouldSpeakMobile("failed")) {
            speechSink.current?.(failure, routedDraft.voiceNodeId);
          }
          return;
        }
        setMessage(result.value.message);
        if (routedDraft.speechEnabled) {
          speechSink.current?.(result.value.message, routedDraft.voiceNodeId);
        }
        return;
      }
      const turn = routeMobileJarvisTurn(routedDraft, route.project.ref);
      const projectKey = mobileJarvisProjectKey(route.project);
      setSelectedProjectKey(projectKey);
      taskDeskNodeIdRef.current = route.project.ref.nodeId;
      setTaskDeskNodeId(route.project.ref.nodeId);
      savePreferences({ preferredJarvisProjectRef: route.project.ref });
      submittingRef.current = true;
      setSubmitting(true);
      setMessage(null);
      replaceActiveTurn(turn);
      setPreparedOriginInteractionId(nextOriginInteractionId());
      // Immediate latency cue: transcription plus semantic interpretation
      // can take many seconds, and silence reads as broken. A haptic tick is
      // action-neutral — contextual wording stays Host-owned (see below).
      if (turn.speechEnabled) {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
      }
      const result = await execute({
        kind: "control",
        projectRef: turn.projectRef,
        utterance: route.utterance,
        requestMetadata: {
          requestId: uuidv4(),
          origin: { originInteractionId: turn.originInteractionId },
          ...(turn.inputMode === "voice"
            ? { inputMode: "voice" as const, sourceUtterance: route.sourceUtterance }
            : {}),
        },
      }).finally(() => {
        submittingRef.current = false;
        setSubmitting(false);
      });
      if (result._tag !== "Success") {
        const failure = commandError(result);
        setMessage(failure);
        if (turn.speechEnabled && shouldSpeakMobile("failed")) {
          speechSink.current?.(failure, turn.voiceNodeId);
        }
        removeActiveTurn(turn.originInteractionId);
      } else if (result.value.status === "started") {
        replaceActiveTurn(attachMobileJarvisTask(turn, result.value.taskRef));
        setMessage(`Started ${result.value.objective}`);
        if (
          turn.speechEnabled &&
          result.value.acknowledgement !== undefined &&
          shouldSpeakMobile("acknowledgement")
        ) {
          speechSink.current?.(result.value.acknowledgement, turn.voiceNodeId);
        }
      } else {
        const response =
          result.value.status === "needs-input" ? result.value.prompt : result.value.message;
        setMessage(response);
        const speechKind =
          result.value.status === "needs-input" ? "needs-input" : "acknowledgement";
        if (turn.speechEnabled && shouldSpeakMobile(speechKind)) {
          speechSink.current?.(response, turn.voiceNodeId);
        }
        removeActiveTurn(turn.originInteractionId);
      }
      if (taskDeskNodeIdRef.current === turn.projectRef.nodeId) {
        void refreshTaskDesk(turn.projectRef.nodeId);
      }
    },
    [
      catalog?.nodes,
      catalog?.projects,
      converse,
      desk,
      deskNodeId,
      execute,
      refreshTaskDesk,
      removeActiveTurn,
      replaceActiveTurn,
      savePreferences,
      selectedProject,
    ],
  );

  const onPresentation = useCallback(
    (turn: MobileJarvisTurn, event: JarvisPresentationEvent) => {
      setMessage(event.text);
      setPresentations((current) =>
        [
          { event, executionNodeId: turn.projectRef.nodeId },
          ...current.filter((item) => item.event.presentationId !== event.presentationId),
        ].slice(0, 8),
      );
      if (taskDeskNodeIdRef.current === turn.projectRef.nodeId) {
        void refreshTaskDesk(turn.projectRef.nodeId);
      }
      if (turn.speechEnabled && shouldSpeakMobile(mobileSpeechKindForPresentation(event.kind))) {
        speechSink.current?.(mobileSpeechText(event), turn.voiceNodeId);
      }
      if (event.kind === "completed" || event.kind === "failed") {
        removeActiveTurn(turn.originInteractionId);
      }
    },
    [refreshTaskDesk, removeActiveTurn],
  );

  const attachSpeechSink = useCallback((sink: SpeechSink) => {
    speechSink.current = sink;
    return () => {
      if (speechSink.current === sink) speechSink.current = null;
    };
  }, []);

  const value = useMemo<JarvisControllerValue>(
    () => ({
      catalog,
      taskDeskNodeId,
      selectedProjectKey: resolvedSelectedProjectKey,
      selectedProject,
      desk,
      presentations,
      message,
      refreshing,
      submitting,
      preparedOriginInteractionId,
      refresh,
      selectTaskDeskNode,
      selectProject,
      focusTask,
      runInstruction,
      createTextTurn,
      setMessage,
      attachSpeechSink,
    }),
    [
      attachSpeechSink,
      catalog,
      createTextTurn,
      desk,
      focusTask,
      message,
      preparedOriginInteractionId,
      presentations,
      refresh,
      refreshing,
      runInstruction,
      selectProject,
      selectTaskDeskNode,
      selectedProject,
      resolvedSelectedProjectKey,
      submitting,
      taskDeskNodeId,
    ],
  );

  return (
    <JarvisControllerContext.Provider value={value}>
      {props.children}
      {activeTurns.map((turn) => (
        <JarvisPresentationListener
          key={turn.originInteractionId}
          turn={turn}
          onPresentation={onPresentation}
        />
      ))}
    </JarvisControllerContext.Provider>
  );
}

export function useJarvisController(): JarvisControllerValue {
  const value = useContext(JarvisControllerContext);
  if (value === null) throw new Error("useJarvisController requires JarvisMobileProvider.");
  return value;
}

function JarvisPresentationListener(props: {
  readonly turn: MobileJarvisTurn;
  readonly onPresentation: (turn: MobileJarvisTurn, event: JarvisPresentationEvent) => void;
}) {
  const result = useAtomValue(
    jarvisEnvironment.presentations({
      environmentId: props.turn.projectRef.nodeId,
      input: { originInteractionId: props.turn.originInteractionId },
    }),
  );
  const lastPresentationId = useRef<string | null>(null);
  const onPresentationRef = useRef(props.onPresentation);
  onPresentationRef.current = props.onPresentation;
  useEffect(() => {
    if (
      !AsyncResult.isSuccess(result) ||
      lastPresentationId.current === result.value.presentationId
    ) {
      return;
    }
    lastPresentationId.current = result.value.presentationId;
    onPresentationRef.current(props.turn, result.value);
  }, [props.turn, result]);
  return null;
}
