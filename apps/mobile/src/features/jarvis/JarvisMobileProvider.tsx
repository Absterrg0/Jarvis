import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
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
import { jarvisEnvironment } from "../../state/jarvis";
import { jarvisMeshEnvironment } from "../../state/jarvisMesh";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { useAtomCommand as useMobileAtomCommand } from "../../state/use-atom-command";
import {
  attachMobileJarvisTask,
  createMobileJarvisTurn,
  type MobileJarvisTurn,
} from "./mobileJarvisTurn";
import { mobileSpeechKindForPresentation, shouldSpeakMobile } from "./mobileSpeechPolicy";
import {
  hasEnvironmentConnected,
  isAppForegroundTransition,
  isSelectedTaskDeskNodeCatalogued,
} from "./jarvisMobileForegroundRefresh";

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
  readonly runInstruction: (turn: MobileJarvisTurn, text: string) => Promise<void>;
  readonly createTextTurn: () => MobileJarvisTurn | null;
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
  const refreshMesh = useMobileAtomCommand(jarvisMeshEnvironment.refresh, {
    reportFailure: false,
    reportDefect: false,
  });
  const execute = useMobileAtomCommand(jarvisMeshEnvironment.execute, {
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

  const selectedProject = catalog?.projects.find(
    (project) => mobileJarvisProjectKey(project) === selectedProjectKey,
  );

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
      if (result._tag === "Success") setDesk(result.value);
      else setMessage(commandError(result));
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
      const nextNodeId = catalog.nodes[0]?.nodeId ?? null;
      taskDeskNodeIdRef.current = nextNodeId;
      setTaskDeskNodeId(nextNodeId);
    } else if (selectedDeskNode === undefined) {
      deskRequestGeneration.current += 1;
      setDesk(null);
    }
    const project = catalog.projects.find(
      (candidate) => mobileJarvisProjectKey(candidate) === selectedProjectKey,
    );
    if (project === undefined) setSelectedProjectKey(null);
  }, [catalog, selectedProjectKey, taskDeskNodeId]);

  useEffect(() => {
    if (taskDeskNodeId === null) {
      deskRequestGeneration.current += 1;
      setDesk(null);
      return;
    }
    void refreshTaskDesk(taskDeskNodeId);
  }, [refreshTaskDesk, taskDeskNodeId]);

  const selectTaskDeskNode = useCallback((nodeId: EnvironmentId) => {
    taskDeskNodeIdRef.current = nodeId;
    setTaskDeskNodeId(nodeId);
  }, []);

  const selectProject = useCallback((project: JarvisMeshProject) => {
    setSelectedProjectKey(mobileJarvisProjectKey(project));
  }, []);

  const focusTask = useCallback(
    async (task: JarvisTaskDeskView["recentTasks"][number]) => {
      const nodeId = task.taskRef.executionNodeId;
      const generation = ++deskRequestGeneration.current;
      const result = await focusTaskCommand({
        nodeId,
        task: { threadId: task.threadId, taskRef: task.taskRef },
      });
      if (generation !== deskRequestGeneration.current || taskDeskNodeIdRef.current !== nodeId) {
        return;
      }
      if (result._tag === "Success") setDesk(result.value);
      else setMessage(commandError(result));
    },
    [focusTaskCommand],
  );

  const createTextTurn = useCallback((): MobileJarvisTurn | null => {
    if (selectedProject === undefined) return null;
    return createMobileJarvisTurn({
      originInteractionId: preparedOriginInteractionId,
      projectRef: selectedProject.ref,
      inputMode: "text",
    });
  }, [preparedOriginInteractionId, selectedProject]);

  const runInstruction = useCallback(
    async (turn: MobileJarvisTurn, text: string) => {
      const utterance = text.trim();
      if (utterance.length === 0 || submittingRef.current) return;
      submittingRef.current = true;
      setSubmitting(true);
      setMessage(null);
      replaceActiveTurn(turn);
      setPreparedOriginInteractionId(nextOriginInteractionId());
      const result = await execute({
        projectRef: turn.projectRef,
        utterance,
        requestMetadata: {
          requestId: uuidv4(),
          origin: { originInteractionId: turn.originInteractionId },
          ...(turn.inputMode === "voice"
            ? { inputMode: "voice" as const, sourceUtterance: utterance }
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
    [execute, refreshTaskDesk, removeActiveTurn, replaceActiveTurn],
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
        speechSink.current?.(event.text, turn.voiceNodeId);
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
      selectedProjectKey,
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
      selectedProjectKey,
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
      {selectedProject === undefined ? null : (
        <JarvisPresentationListener
          key={preparedOriginInteractionId}
          turn={createMobileJarvisTurn({
            originInteractionId: preparedOriginInteractionId,
            projectRef: selectedProject.ref,
            inputMode: "text",
          })}
          onPresentation={onPresentation}
        />
      )}
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
