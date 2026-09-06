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
  ModelSelection,
  ThreadId,
} from "@t3tools/contracts";
import { isJarvisClarificationDiscard } from "@t3tools/jarvis-core/clarification";
import {
  answerJarvisModelChoice,
  isJarvisModelClarificationReason,
  uniqueJarvisModelCompletion,
  type JarvisModelClarificationReason,
  type JarvisModelDraft,
} from "@t3tools/jarvis-core/modelChoice";
import type {
  JarvisMeshCatalog,
  JarvisMeshProject,
} from "@t3tools/jarvis-client-runtime/jarvis/mesh";

import { uuidv4 } from "../../lib/uuid";
import { jarvisEnvironment } from "../../state/jarvis";
import { jarvisMeshCatalogAtom, jarvisMeshEnvironment } from "../../state/jarvisMesh";
import { lookupThread } from "../../state/threads";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { useAtomCommand as useMobileAtomCommand } from "../../state/use-atom-command";
import type { JarvisClientContextTask } from "@t3tools/jarvis-client-runtime/jarvis/commandContext";
import {
  attachMobileJarvisTask,
  buildMobileJarvisExecuteInput,
  classifyServerFrameCancel,
  createMobileJarvisTurn,
  resolveMobileFocusContextTask,
  resolveRetainedFrameId,
  restoreMobileFocusFromDesk,
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
  retireFinishedMobileTurns,
  groupRetainedThreadIdsByNode,
  type ReconcileMobileThreadLookup,
} from "./mobileJarvisReconcile";
import {
  resolveMobileJarvisInstructionRoute,
  resolveMobileJarvisPendingAnswer,
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
  /**
   * Retained explicit selection whose project is absent from the catalog.
   * The screen lane owns display; routing reports it unavailable and never
   * borrows another target until it returns or the user reselects.
   */
  readonly unavailableProjectKey: string | null;
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
  const lookupDurableThread = useMobileAtomCommand(lookupThread, {
    reportFailure: false,
    reportDefect: false,
  });
  const focusTaskCommand = useMobileAtomCommand(jarvisMeshEnvironment.focusTask, {
    reportFailure: false,
    reportDefect: false,
  });
  const catalog = useAtomValue(jarvisMeshCatalogAtom);
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
  // Typed answers to provider/model/effort clarification keep the executed
  // turn instead of dropping it: the next instruction answers the pending
  // question with catalog data, and the original utterance is resent with the
  // resolved selection under the same requestId.
  const pendingModelAnswer = useRef<{
    readonly turn: MobileJarvisTurn;
    readonly projectRef: JarvisMeshProject["ref"];
    readonly utterance: string;
    readonly sourceUtterance?: string;
    readonly reason: JarvisModelClarificationReason;
    readonly draft: JarvisModelDraft;
    readonly requestId: string;
  } | null>(null);
  // Server-owned project/task clarification pins its node and origin turn:
  // the next instruction is sent raw to the original node so the Host frame
  // consumes it. Only the continuation target and request identity are kept;
  // candidates stay server-side. A project or task switch cancels instead of
  // letting the next instruction be consumed unnoticed.
  const pendingServerAnswer = useRef<{
    readonly turn: MobileJarvisTurn;
    readonly projectRef: JarvisMeshProject["ref"];
    readonly expectedReply?: MobileJarvisTurn["expectedReply"];
    readonly clarificationFrameId?: string;
    readonly requestId: string;
  } | null>(null);
  // A project/task switch must await its server-frame cancel before the new
  // selection commits; otherwise the next command races the old frame and is
  // consumed as its answer. runInstruction awaits the same gate.
  const cancelInFlight = useRef<Promise<void> | null>(null);
  // Newest switch wins: an older cancellation completing late must not commit
  // a stale selection over it.
  const switchGeneration = useRef(0);
  // Exact task identity from the last explicit focus (voice ack, started
  // task, or focus-tap). Tri-state: undefined means not yet restored, null
  // means explicitly project-only with no task. Routing snapshots this; the
  // desk only enriches the same thread with its pending pin and never chooses
  // another task. Removal or disconnect keeps it like the pinned selection.
  const retainedFocusRef = useRef<JarvisClientContextTask | null | undefined>(undefined);

  const preferencesReady = AsyncResult.isSuccess(preferencesResult);
  const preferredProjectRef = preferencesReady
    ? preferencesResult.value.preferredJarvisProjectRef
    : undefined;
  // Activity and reports never choose the command target: only the explicit
  // selection (key, then persisted preference) or a first-use singleton does.
  const selectedProject =
    catalog === null || (!preferencesReady && selectedProjectKey === null)
      ? undefined
      : resolveMobileJarvisProject({
          projects: catalog.projects,
          selectedProjectKey,
          preferredProjectRef,
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
    async (nodeId: EnvironmentId): Promise<JarvisTaskDeskView | null> => {
      const generation = ++deskRequestGeneration.current;
      const result = await getTaskDesk({ nodeId });
      if (generation !== deskRequestGeneration.current || taskDeskNodeIdRef.current !== nodeId) {
        return null;
      }
      if (result._tag === "Success") {
        setDesk(result.value);
        setDeskNodeId(nodeId);
        return result.value;
      }
      setMessage(commandError(result));
      return null;
    },
    [getTaskDesk],
  );

  // Retire turns whose live ending was missed while disconnected: reconcile
  // retained task references against durable desk state instead of replaying
  // old results when their listeners resubscribe.
  const reconcileActiveTurns = useCallback(
    async (
      cataloguedNodeIds: ReadonlySet<EnvironmentId>,
      knownDesks?: ReadonlyMap<EnvironmentId, JarvisTaskDeskView>,
    ) => {
      const turns = [...activeTurnsRef.current.values()].filter(
        (turn) => turn.taskRef !== undefined,
      );
      if (turns.length === 0) return;
      const retainedTurnsByNode = groupRetainedThreadIdsByNode(turns);
      const nodeIds = [...retainedTurnsByNode.keys()];
      const desks = new Map<
        EnvironmentId,
        ReadonlyArray<{
          threadId: ThreadId;
          state:
            | "ready"
            | "failed"
            | "interrupted"
            | "running"
            | "waiting-for-input"
            | "waiting-for-approval";
        }>
      >();
      const threads = new Map<EnvironmentId, ReadonlyMap<ThreadId, ReconcileMobileThreadLookup>>();
      for (const nodeId of nodeIds) {
        if (!cataloguedNodeIds.has(nodeId)) continue;
        const nodeTurns = retainedTurnsByNode.get(nodeId) ?? [];
        // Refresh may already hold this node's desk from the pass above;
        // reuse it instead of fetching the selected desk twice per refresh.
        const knownDesk = knownDesks?.get(nodeId);
        const [deskResult, threadResults] = await Promise.all([
          knownDesk === undefined
            ? getTaskDesk({ nodeId })
            : Promise.resolve({ _tag: "Success", value: knownDesk } as const),
          Promise.all(
            nodeTurns.map((threadId) =>
              lookupDurableThread({
                environmentId: nodeId,
                input: { threadId },
              }),
            ),
          ),
        ]);
        if (deskResult._tag === "Success") {
          desks.set(nodeId, [
            ...deskResult.value.recentTasks,
            ...(deskResult.value.focusedTask === null ? [] : [deskResult.value.focusedTask]),
          ]);
        }
        const nodeThreads = new Map<ThreadId, ReconcileMobileThreadLookup>();
        nodeTurns.forEach((threadId, index) => {
          const result = threadResults[index];
          if (result?._tag === "Success") {
            nodeThreads.set(threadId, result.value);
          } else {
            nodeThreads.set(threadId, { status: "unreachable" });
          }
        });
        threads.set(nodeId, nodeThreads);
      }
      for (const originInteractionId of retireFinishedMobileTurns({
        turns,
        desks,
        threads,
        cataloguedNodeIds,
      })) {
        removeActiveTurn(originInteractionId);
        if (pendingModelAnswer.current?.turn.originInteractionId === originInteractionId) {
          pendingModelAnswer.current = null;
        }
      }
    },
    [getTaskDesk, lookupDurableThread, removeActiveTurn],
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

        setMessage(null);
        const selectedNodeId = taskDeskNodeIdRef.current;
        let knownDesks: Map<EnvironmentId, JarvisTaskDeskView> | undefined;
        if (
          selectedNodeId !== null &&
          isSelectedTaskDeskNodeCatalogued(result.value, selectedNodeId)
        ) {
          const deskView = await refreshTaskDesk(selectedNodeId);
          if (deskView !== null) knownDesks = new Map([[selectedNodeId, deskView]]);
        } else if (selectedNodeId !== null) {
          deskRequestGeneration.current += 1;
          setDesk(null);
          setDeskNodeId(null);
        }
        // Reconnect/foreground may have missed live terminal events: retire
        // finished turns against durable state without speaking old results.
        await reconcileActiveTurns(
          new Set(result.value.nodes.map((node) => node.nodeId)),
          knownDesks,
        );
      } finally {
        setRefreshing(false);
      }
    };

    const refreshPromise = runRefresh().finally(() => {
      if (refreshInFlight.current === refreshPromise) refreshInFlight.current = null;
    });
    refreshInFlight.current = refreshPromise;
    return refreshPromise;
  }, [refreshMesh, refreshTaskDesk, reconcileActiveTurns]);

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
    // The retained selection key stays pinned when its project leaves the
    // catalog: only an explicit select, focus, or route resolution retargets.
    // A node removed from the catalog takes its retained turns and listeners
    // with it; there is no durable state left to reconcile them against.
    const cataloguedNodeIds = new Set(catalog.nodes.map((node) => node.nodeId));
    for (const turn of activeTurnsRef.current.values()) {
      if (!cataloguedNodeIds.has(turn.projectRef.nodeId)) {
        removeActiveTurn(turn.originInteractionId);
      }
    }
    if (
      pendingModelAnswer.current !== null &&
      !cataloguedNodeIds.has(pendingModelAnswer.current.projectRef.nodeId)
    ) {
      pendingModelAnswer.current = null;
    }
  }, [catalog, selectedProjectKey, taskDeskNodeId, removeActiveTurn]);

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

  // First authoritative desk restores an unrestored focus: after remount or
  // reconnect the retained identity is still unknown, so the current desk's
  // focused task becomes the routing context when its project matches the
  // selected or preferred project. Explicit project-only null is never
  // overridden, and a stale-node desk is never adopted.
  useEffect(() => {
    if (retainedFocusRef.current !== undefined) return;
    const restored = restoreMobileFocusFromDesk({
      retained: retainedFocusRef.current,
      deskFocusedTask: desk?.focusedTask ?? null,
      deskNodeId,
      selectedDeskNodeId: taskDeskNodeIdRef.current,
      ...(selectedProject === undefined ? {} : { selectedProjectRef: selectedProject.ref }),
      ...(preferredProjectRef === undefined ? {} : { preferredProjectRef }),
    });
    if (restored !== undefined) retainedFocusRef.current = restored;
  }, [desk, deskNodeId, preferredProjectRef, selectedProject]);

  const selectTaskDeskNode = useCallback((nodeId: EnvironmentId) => {
    taskDeskNodeIdRef.current = nodeId;
    setTaskDeskNodeId(nodeId);
  }, []);

  /**
   * Clear a server-owned frame and report whether it is gone. Without a saved
   * frame id this is a safe no-op that sends nothing: a bare "cancel" with no
   * frame would be interpreted fresh and could deny a waiting approval. With
   * a frame id the cancel is bound to that exact frame, so no desk read can
   * race; only an acknowledgement counts as cleared.
   */
  const cancelServerFrame = useCallback(
    async (cont: {
      readonly turn: MobileJarvisTurn;
      readonly projectRef: JarvisMeshProject["ref"];
      readonly clarificationFrameId?: string;
    }): Promise<"cleared" | "retired" | "failed"> => {
      if (cont.clarificationFrameId === undefined) return "cleared";
      const result = await execute(
        buildMobileJarvisExecuteInput({
          turn: cont.turn,
          projectRef: cont.projectRef,
          utterance: "cancel",
          clarificationFrameId: cont.clarificationFrameId,
          requestId: uuidv4(),
        }),
      ).catch(() => null);
      if (result === null || result._tag !== "Success") return "failed";
      return classifyServerFrameCancel(result.value);
    },
    [execute],
  );

  /**
   * The single owner of explicit local focus: project adoption plus the exact
   * retained task identity. Voice focus acks, started results, project
   * selection, and focus taps all write through here; a project without a
   * task clears the retained thread instead of inheriting desk state.
   */
  const adoptExplicitFocus = useCallback(
    (focus: {
      readonly projectRef: JarvisMeshProject["ref"];
      readonly task?: JarvisClientContextTask | null;
    }) => {
      setSelectedProjectKey(`${focus.projectRef.nodeId}:${focus.projectRef.projectId}`);
      taskDeskNodeIdRef.current = focus.projectRef.nodeId;
      setTaskDeskNodeId(focus.projectRef.nodeId);
      savePreferences({ preferredJarvisProjectRef: focus.projectRef });
      retainedFocusRef.current = focus.task ?? null;
    },
    [savePreferences],
  );

  const selectProject = useCallback(
    (project: JarvisMeshProject) => {
      pendingModelAnswer.current = null;
      pendingRoute.current = null;
      const serverPending = pendingServerAnswer.current;
      if (serverPending === null) {
        adoptExplicitFocus({ projectRef: project.ref });
        return;
      }
      const generation = ++switchGeneration.current;
      const gate = (async () => {
        const outcome = await cancelServerFrame(serverPending);
        if (generation !== switchGeneration.current) return;
        if (outcome === "failed") {
          setMessage("That question is still waiting on its node. Answer it or try again.");
          return;
        }
        pendingServerAnswer.current = null;
        adoptExplicitFocus({ projectRef: project.ref });
      })();
      cancelInFlight.current = gate;
      void gate.finally(() => {
        if (cancelInFlight.current === gate) cancelInFlight.current = null;
      });
    },
    [adoptExplicitFocus, cancelServerFrame],
  );

  const focusTask = useCallback(
    async (task: JarvisTaskDeskView["recentTasks"][number]) => {
      pendingModelAnswer.current = null;
      pendingRoute.current = null;
      const serverPending = pendingServerAnswer.current;
      if (serverPending !== null) {
        const generation = ++switchGeneration.current;
        const cancelPromise = cancelServerFrame(serverPending);
        const gate = cancelPromise.then(() => undefined);
        cancelInFlight.current = gate;
        void gate.finally(() => {
          if (cancelInFlight.current === gate) cancelInFlight.current = null;
        });
        const outcome = await cancelPromise;
        if (generation !== switchGeneration.current) return;
        if (outcome === "failed") {
          setMessage("That question is still waiting on its node. Answer it or try again.");
          return;
        }
        pendingServerAnswer.current = null;
      }
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
      adoptExplicitFocus({
        projectRef: task.projectRef,
        task: { threadId: task.threadId, taskRef: task.taskRef, projectRef: task.projectRef },
      });
      setDesk(result.value);
      setDeskNodeId(nodeId);
    },
    [adoptExplicitFocus, cancelServerFrame, focusTaskCommand],
  );

  const createTextTurn = useCallback((): MobileJarvisDraft => {
    return createMobileJarvisTurn({
      originInteractionId: preparedOriginInteractionId,
      inputMode: "text",
    });
  }, [preparedOriginInteractionId]);

  const executeControl = useCallback(
    async (args: {
      readonly turn: MobileJarvisTurn;
      readonly projectRef: JarvisMeshProject["ref"];
      readonly utterance: string;
      readonly sourceUtterance?: string;
      readonly modelSelection?: ModelSelection;
      readonly draftForSpeech: MobileJarvisDraft;
      /** Reused across retries of one turn so a retry stays idempotent. */
      readonly requestId?: string;
      /** Binds an answer to the exact server frame it replies to. */
      readonly clarificationFrameId?: string;
    }): Promise<string> => {
      const { turn, projectRef, utterance, draftForSpeech } = args;
      // One request identity per turn: model-clarification retries resend the
      // original utterance under the same requestId instead of minting work.
      const requestId = args.requestId ?? uuidv4();
      submittingRef.current = true;
      setSubmitting(true);
      setMessage(null);
      const result = await execute(
        buildMobileJarvisExecuteInput({
          turn,
          projectRef,
          utterance,
          ...(args.sourceUtterance === undefined ? {} : { sourceUtterance: args.sourceUtterance }),
          ...(args.modelSelection === undefined ? {} : { modelSelection: args.modelSelection }),
          ...(args.clarificationFrameId === undefined
            ? {}
            : { clarificationFrameId: args.clarificationFrameId }),
          requestId,
        }),
      ).finally(() => {
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
        // A started turn pins its exact task until an explicit project or
        // task switch replaces it.
        if (result.value.taskRef !== undefined) {
          retainedFocusRef.current = {
            threadId: result.value.threadId,
            taskRef: result.value.taskRef,
            projectRef: {
              nodeId: result.value.taskRef.executionNodeId,
              projectId: result.value.projectId ?? turn.projectRef.projectId,
            },
          };
        }
        setMessage(`Started ${result.value.objective}`);
        if (
          turn.speechEnabled &&
          result.value.acknowledgement !== undefined &&
          shouldSpeakMobile("acknowledgement")
        ) {
          speechSink.current?.(result.value.acknowledgement, turn.voiceNodeId);
        }
      } else if (result.value.status === "needs-input") {
        const reason = isJarvisModelClarificationReason(result.value.reason);
        if (reason !== null) {
          const providers = (catalog?.providers ?? [])
            .filter((provider) => provider.nodeId === projectRef.nodeId)
            .map((provider) => provider.snapshot);
          const unique =
            reason === "provider-not-found" && result.value.modelDraft === undefined
              ? uniqueJarvisModelCompletion(providers)
              : null;
          if (unique !== null) {
            // Exactly one way to answer: resend the original utterance with
            // the resolved selection instead of asking the user.
            return executeControl({ ...args, modelSelection: unique, requestId });
          }
          // Keep the turn: the next instruction answers this question with a
          // typed selection instead of starting fresh work.
          pendingModelAnswer.current = {
            turn,
            projectRef,
            utterance,
            ...(args.sourceUtterance === undefined
              ? {}
              : { sourceUtterance: args.sourceUtterance }),
            reason,
            draft: result.value.modelDraft ?? {},
            requestId,
          };
          replaceActiveTurn(turn);
          const prompt =
            result.value.choices.length === 0
              ? result.value.prompt
              : `${result.value.prompt} ${result.value.choices
                  .map((choice, index) => `${index + 1}. ${choice}`)
                  .join("  ")}`;
          setMessage(prompt);
          if (draftForSpeech.speechEnabled && shouldSpeakMobile("needs-input")) {
            speechSink.current?.(prompt, draftForSpeech.voiceNodeId);
          }
        } else {
          // Server-owned clarification (project/task frame or pending-reply
          // question): pin the origin node and turn so the next instruction
          // goes back raw for the Host frame to consume. Candidates stay
          // server-side; an unmatched answer re-prompts instead of dispatching.
          const response = result.value.prompt;
          setMessage(response);
          if (turn.speechEnabled && shouldSpeakMobile("needs-input")) {
            speechSink.current?.(response, turn.voiceNodeId);
          }
          // A rejected answer omits the frame id: keep the sent one so the
          // next answer stays bound to the old frame instead of going out
          // fresh and unguarded.
          const retainedFrameId = resolveRetainedFrameId(
            result.value.clarificationFrameId,
            args.clarificationFrameId,
          );
          pendingServerAnswer.current = {
            turn,
            projectRef,
            ...(result.value.expectedReply === undefined
              ? {}
              : { expectedReply: result.value.expectedReply }),
            ...(retainedFrameId === undefined ? {} : { clarificationFrameId: retainedFrameId }),
            requestId,
          };
          replaceActiveTurn(turn);
        }
      } else if (result.value.action === "focused") {
        // Explicit spoken focus adopts the exact response identity: the task
        // node when a taskRef is present, else the execution turn node. A
        // project-only focus clears any retained thread instead of choosing
        // from the desk.
        const taskRef = result.value.taskRef;
        adoptExplicitFocus(
          taskRef === undefined
            ? { projectRef: { nodeId: turn.projectRef.nodeId, projectId: result.value.projectId } }
            : {
                projectRef: {
                  nodeId: taskRef.executionNodeId,
                  projectId: result.value.projectId,
                },
                task: {
                  threadId: taskRef.threadId,
                  taskRef,
                  projectRef: {
                    nodeId: taskRef.executionNodeId,
                    projectId: result.value.projectId,
                  },
                },
              },
        );
        setMessage(result.value.message);
        if (turn.speechEnabled && shouldSpeakMobile("acknowledgement")) {
          speechSink.current?.(result.value.message, turn.voiceNodeId);
        }
        removeActiveTurn(turn.originInteractionId);
        // The trailing refresh below covers the turn node; a focus onto
        // another node needs its own desk read for pending enrichment.
        const focusedNodeId = taskDeskNodeIdRef.current;
        if (focusedNodeId !== null && focusedNodeId !== turn.projectRef.nodeId) {
          void refreshTaskDesk(focusedNodeId);
        }
      } else {
        const response = result.value.message;
        setMessage(response);
        if (turn.speechEnabled && shouldSpeakMobile("acknowledgement")) {
          speechSink.current?.(response, turn.voiceNodeId);
        }
        removeActiveTurn(turn.originInteractionId);
      }
      if (taskDeskNodeIdRef.current === turn.projectRef.nodeId) {
        void refreshTaskDesk(turn.projectRef.nodeId);
      }
      return requestId;
    },
    [adoptExplicitFocus, catalog, execute, refreshTaskDesk, removeActiveTurn, replaceActiveTurn],
  );

  const runInstruction = useCallback(
    async (draft: MobileJarvisDraft, text: string) => {
      const utterance = text.trim();
      if (utterance.length === 0 || submittingRef.current) return;
      // A switch cancellation in flight owns the session: wait for it instead
      // of racing the old frame with a new command.
      const inFlightCancel = cancelInFlight.current;
      if (inFlightCancel !== null) {
        await inFlightCancel;
        if (cancelInFlight.current !== null || submittingRef.current) return;
      }
      // A server-owned frame intercepts any execute on its session, so its
      // raw answer goes first: the Host parses yes/no/ordinal/cancel and
      // re-prompts on anything else instead of starting new work. The pinned
      // ask identity and the original request id travel along so a replaced
      // request is rejected and the roundtrip stays idempotent.
      const serverPending = pendingServerAnswer.current;
      if (serverPending !== null) {
        // A discard never goes out raw: without a frame there is nothing to
        // answer, and a bare "cancel" would read as denying a live approval.
        if (isJarvisClarificationDiscard(utterance)) {
          pendingServerAnswer.current = null;
          const outcome = await cancelServerFrame(serverPending);
          if (outcome === "failed") {
            setMessage("That question is still waiting on its node. Answer it or try again.");
            pendingServerAnswer.current = serverPending;
            return;
          }
          removeActiveTurn(serverPending.turn.originInteractionId);
          setPreparedOriginInteractionId(nextOriginInteractionId());
          setMessage(
            outcome === "retired"
              ? "That question is no longer open."
              : "Okay, I discarded that request.",
          );
          return;
        }
        pendingServerAnswer.current = null;
        await executeControl({
          turn:
            serverPending.expectedReply === undefined
              ? serverPending.turn
              : { ...serverPending.turn, expectedReply: serverPending.expectedReply },
          projectRef: serverPending.projectRef,
          utterance,
          ...(serverPending.clarificationFrameId === undefined
            ? {}
            : { clarificationFrameId: serverPending.clarificationFrameId }),
          draftForSpeech: draft,
          requestId: serverPending.requestId,
        });
        return;
      }
      const modelPending = pendingModelAnswer.current;
      if (modelPending !== null) {
        // A discard drops the model question locally: it must never fall
        // through into a fresh command that denies an unrelated approval.
        if (isJarvisClarificationDiscard(utterance)) {
          pendingModelAnswer.current = null;
          setPreparedOriginInteractionId(nextOriginInteractionId());
          setMessage("Okay, I discarded that request.");
          return;
        }
        const providers = (catalog?.providers ?? [])
          .filter((provider) => provider.nodeId === modelPending.projectRef.nodeId)
          .map((provider) => provider.snapshot);
        const answered = answerJarvisModelChoice(
          providers,
          modelPending.draft,
          modelPending.reason,
          utterance,
        );
        if (answered.status !== "no-match") {
          if (answered.status === "need-choice") {
            pendingModelAnswer.current = {
              ...modelPending,
              draft: answered.draft,
              reason: answered.reason,
            };
            const prompt = `${answered.prompt} ${answered.choices
              .map((choice, index) => `${index + 1}. ${choice}`)
              .join("  ")}`;
            setMessage(prompt);
            if (draft.speechEnabled && shouldSpeakMobile("needs-input")) {
              speechSink.current?.(prompt, draft.voiceNodeId);
            }
            return;
          }
          pendingModelAnswer.current = null;
          await executeControl({
            turn: modelPending.turn,
            projectRef: modelPending.projectRef,
            utterance: modelPending.utterance,
            ...(modelPending.sourceUtterance === undefined
              ? {}
              : { sourceUtterance: modelPending.sourceUtterance }),
            modelSelection: answered.selection,
            draftForSpeech: draft,
            requestId: modelPending.requestId,
          });
          return;
        }
        pendingModelAnswer.current = null;
      }
      const pending = pendingRoute.current;
      const pendingAnswer =
        pending === null
          ? null
          : resolveMobileJarvisPendingAnswer({ pending: pending.route, answer: utterance });
      if (pendingAnswer?.status === "discarded") {
        pendingRoute.current = null;
        setPreparedOriginInteractionId(nextOriginInteractionId());
        setMessage("Okay. Say the project name with your next instruction.");
        return;
      }
      if (pendingAnswer?.status === "unmatched") {
        const retryMessage = "I couldn't match that project. Say its name or number.";
        setMessage(retryMessage);
        if (draft.speechEnabled && shouldSpeakMobile("needs-input")) {
          speechSink.current?.(retryMessage, draft.voiceNodeId);
        }
        return;
      }
      const route =
        pendingAnswer?.status === "resolved"
          ? pendingAnswer
          : resolveMobileJarvisInstructionRoute({
              utterance,
              inputMode: draft.inputMode,
              projects: catalog?.projects ?? [],
              ambientProject: selectedProject,
              // A pinned explicit selection absent from the catalog reports
              // unavailable for unqualified follow-ups. Either a retained key
              // or a persisted preference counts as explicit, so no
              // preferences lag can silently fall back.
              ambientUnavailable:
                selectedProject === undefined &&
                (selectedProjectKey !== null || preferredProjectRef !== undefined),
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
      // Routing context comes from the retained explicit focus, never from a
      // latest desk task. The desk only enriches the same thread with its
      // pending pin; a stale desk contributes nothing.
      const deskTasks =
        desk !== null && deskNodeId === taskDeskNodeIdRef.current
          ? [desk.focusedTask, ...desk.recentTasks].filter(
              (task): task is NonNullable<typeof task> => task !== null,
            )
          : [];
      const turn = routeMobileJarvisTurn(
        routedDraft,
        route.project.ref,
        resolveMobileFocusContextTask({ retained: retainedFocusRef.current, deskTasks }),
      );
      const projectKey = mobileJarvisProjectKey(route.project);
      setSelectedProjectKey(projectKey);
      taskDeskNodeIdRef.current = route.project.ref.nodeId;
      setTaskDeskNodeId(route.project.ref.nodeId);
      savePreferences({ preferredJarvisProjectRef: route.project.ref });
      replaceActiveTurn(turn);
      setPreparedOriginInteractionId(nextOriginInteractionId());
      // Immediate latency cue: transcription plus semantic interpretation
      // can take many seconds, and silence reads as broken. A haptic tick is
      // action-neutral — contextual wording stays Host-owned (see below).
      if (turn.speechEnabled) {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
      }
      await executeControl({
        turn,
        projectRef: route.project.ref,
        utterance: route.utterance,
        ...(route.sourceUtterance === undefined ? {} : { sourceUtterance: route.sourceUtterance }),
        draftForSpeech: routedDraft,
      });
    },
    [
      cancelServerFrame,
      catalog?.nodes,
      catalog?.projects,
      converse,
      desk,
      deskNodeId,
      executeControl,
      preferredProjectRef,
      refreshTaskDesk,
      removeActiveTurn,
      replaceActiveTurn,
      savePreferences,
      selectedProject,
      selectedProjectKey,
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
      unavailableProjectKey: selectedProject === undefined ? selectedProjectKey : null,
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
