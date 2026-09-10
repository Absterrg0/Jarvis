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
  TurnId,
} from "@t3tools/contracts";
import { isJarvisClarificationDiscard } from "@t3tools/jarvis-core/clarification";
import {
  answerJarvisModelChoice,
  isJarvisModelClarificationReason,
  uniqueJarvisModelCompletion,
  type JarvisModelClarificationReason,
  type JarvisModelDraft,
} from "@t3tools/jarvis-core/modelChoice";
import {
  buildJarvisInterpretInput,
  selectJarvisSemanticNode,
  type JarvisMeshCatalog,
  type JarvisMeshProject,
} from "@t3tools/jarvis-client-runtime/jarvis/mesh";
import {
  resolveJarvisProposalExecuteRoute,
  resolveJarvisRouteCoverageConfirm,
} from "@t3tools/jarvis-client-runtime/jarvis/routeGrounding";

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
import { formatMobileVoiceInterpretingMessage } from "./mobilePushToTalk";
import { mobileSpeechThreadKey, type MobileSpeechRequest } from "./mobileSpeechGate";
import {
  hasEnvironmentConnected,
  isAppForegroundTransition,
  isSelectedTaskDeskNodeCatalogued,
} from "./jarvisMobileForegroundRefresh";
import { resolveMobileJarvisProject, sameProjectRef } from "./mobileJarvisSelection";
import {
  retireFinishedMobileTurns,
  groupRetainedThreadIdsByNode,
  type ReconcileMobileThreadLookup,
} from "./mobileJarvisReconcile";
import {
  resolveMobileJarvisPendingAnswer,
  type MobileJarvisPendingRoute,
} from "./mobileJarvisRouting";

type SpeechSink = (request: MobileSpeechRequest) => void;

/**
 * Accepted server turn identity for speech correlation. The integration lane
 * adds turnId to the started result; presentations already carry it. Read it
 * structurally so speech keeps working before and after that field lands.
 */
function acceptedTurnIdForSpeech(result: unknown): TurnId | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const turnId = (result as { readonly turnId?: unknown }).turnId;
  return typeof turnId === "string" && turnId.length > 0 ? (turnId as TurnId) : undefined;
}

/**
 * Thread identity for speech invalidation: the turn's pinned thread on its
 * execution node, or "" when the speech names no thread. Playback drops a
 * request once a newer request for its thread arrives.
 */
function speechThreadKeyForTurn(turn: MobileJarvisTurn): string {
  const threadId = turn.contextThreadId ?? turn.referenceThreadId ?? turn.taskRef?.threadId;
  if (threadId === undefined) return "";
  return mobileSpeechThreadKey(turn.taskRef?.executionNodeId ?? turn.projectRef.nodeId, threadId);
}

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
  readonly cancelInflightRequest: () => Promise<
    "cancelled" | "already-accepted" | "unknown" | "failed" | "idle"
  >;
  readonly createTextTurn: () => MobileJarvisDraft;
  readonly setMessage: (message: string | null) => void;
  readonly attachSpeechSink: (sink: SpeechSink) => () => void;
};

const JarvisControllerContext = createContext<JarvisControllerValue | null>(null);

export const mobileJarvisProjectKey = (project: JarvisMeshProject): string =>
  `${project.ref.nodeId}:${project.ref.projectId}`;

function commandError(result: { readonly _tag: string; readonly cause?: unknown }): string {
  if (result._tag !== "Failure") return "";
  return result.cause instanceof Error ? result.cause.message : "The ARIS request failed.";
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
  const refreshMeshNode = useMobileAtomCommand(jarvisMeshEnvironment.refreshNode, {
    reportFailure: false,
    reportDefect: false,
  });
  const execute = useMobileAtomCommand(jarvisMeshEnvironment.execute, {
    reportFailure: false,
    reportDefect: false,
  });
  const interpret = useMobileAtomCommand(jarvisMeshEnvironment.interpret, {
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
  const cancelRequestCommand = useMobileAtomCommand(jarvisMeshEnvironment.cancelRequest, {
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
  // A direct desk answer (approval/user-input) also parks its exact execute
  // payload here before dispatch: requestId pins the proposal and original
  // source so a transport failure retries the same payload instead of
  // rebuilding from a changed desk.
  const pendingServerAnswer = useRef<{
    readonly turn: MobileJarvisTurn;
    readonly projectRef: JarvisMeshProject["ref"];
    readonly expectedReply?: MobileJarvisTurn["expectedReply"];
    readonly clarificationFrameId?: string;
    readonly requestId: string;
    readonly utterance?: string;
    readonly sourceUtterance?: string;
    readonly semanticProposal?: import("@t3tools/contracts").JarvisSemanticProposal;
    readonly modelSelection?: ModelSelection;
  } | null>(null);
  // A project/task switch must await its server-frame cancel before the new
  // selection commits; otherwise the next command races the old frame and is
  // consumed as its answer. runInstruction awaits the same gate.
  const cancelInFlight = useRef<Promise<void> | null>(null);
  // The exact identity of the execute call currently awaiting its receipt.
  // Correction cancel targets this through the pre-accept wire; the receipt,
  // whenever it lands, still owns the final wording.
  const inFlightRequest = useRef<{
    readonly requestId: string;
    readonly nodeId: EnvironmentId;
    readonly originInteractionId: string;
    readonly projectId: JarvisMeshProject["ref"]["projectId"];
  } | null>(null);
  // The interpret call currently awaiting its proposal, before any execution
  // node is chosen. Explicit correction cancel targets this on the semantic
  // node; new additional input queues behind instead of cancelling it.
  const activeInterpretRef = useRef<{
    readonly requestId: string;
    readonly nodeId: EnvironmentId;
    readonly originInteractionId: string;
  } | null>(null);
  // Additional inputs arriving while one turn submits queue behind it by
  // default. Only an explicit cancel (button or typed cancel) plus a new
  // instruction replaces; a new capture never auto-cancels in-flight work.
  const queuedInputsRef = useRef<
    ReadonlyArray<{ readonly draft: MobileJarvisDraft; readonly text: string }>
  >([]);
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

  /**
   * Explicit correction cancel for the active turn. Cancels the in-flight
   * interpret on its semantic node first (proposal never dispatches), then
   * the execute on its execution node. Cancelled means nothing dispatched;
   * already-accepted pins the running identity; unknown keeps waiting.
   * Only an explicit cancel action calls this; new additional input queues
   * behind instead of cancelling.
   */
  const cancelInflightRequest = useCallback(async (): Promise<
    "cancelled" | "already-accepted" | "unknown" | "failed" | "idle"
  > => {
    const activeInterpret = activeInterpretRef.current;
    if (activeInterpret !== null) {
      const interpretOutcome = await cancelRequestCommand({
        nodeId: activeInterpret.nodeId,
        input: {
          requestId: activeInterpret.requestId,
          origin: { originInteractionId: activeInterpret.originInteractionId },
        },
      }).catch(() => null);
      if (interpretOutcome !== null && interpretOutcome._tag === "Success") {
        const decision = interpretOutcome.value;
        if (decision.status === "cancelled") {
          if (activeInterpretRef.current?.requestId === activeInterpret.requestId) {
            activeInterpretRef.current = null;
          }
          // Fall through to also cancel a concurrent execute on the same key
          // when the semantic and execution nodes match; otherwise the
          // interpret cancel alone settles the turn.
        }
      }
    }
    const inFlight = inFlightRequest.current;
    if (inFlight === null || !submittingRef.current) {
      return activeInterpret !== null ? "cancelled" : "idle";
    }
    const outcome = await cancelRequestCommand({
      nodeId: inFlight.nodeId,
      input: {
        requestId: inFlight.requestId,
        origin: { originInteractionId: inFlight.originInteractionId },
      },
    }).catch(() => null);
    if (outcome === null || outcome._tag !== "Success") {
      setMessage("Couldn't reach that request. It may still be running — check Tasks.");
      return "failed";
    }
    const decision = outcome.value;
    if (decision.status === "cancelled") {
      if (inFlightRequest.current?.requestId === inFlight.requestId) {
        inFlightRequest.current = null;
      }
      return "cancelled";
    }
    if (decision.status === "already-accepted") {
      // The interpretation won the race: pin the returned identity so the
      // follow-up routes to the running work instead of starting over.
      if (decision.taskRef !== undefined) {
        retainedFocusRef.current = {
          threadId: decision.taskRef.threadId,
          taskRef: decision.taskRef,
          projectRef: {
            nodeId: decision.taskRef.executionNodeId,
            projectId: decision.projectId ?? inFlight.projectId,
          },
        };
      }
      setMessage("That request already started and keeps running.");
      return "already-accepted";
    }
    setMessage("Couldn't confirm cancellation. Waiting for the request to answer.");
    return "unknown";
  }, [cancelRequestCommand]);

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
      readonly semanticProposal?: import("@t3tools/contracts").JarvisSemanticProposal;
      readonly modelSelection?: ModelSelection;
      readonly draftForSpeech: MobileJarvisDraft;
      /** Reused across retries of one turn so a retry stays idempotent. */
      readonly requestId?: string;
      /** Binds an answer to the exact server frame it replies to. */
      readonly clarificationFrameId?: string;
      /**
       * Parked server answer this execute consumes. Cleared only when the
       * answer lands, so a transport failure keeps it for the retry.
       */
      readonly consumeServerPending?: {
        readonly turn: MobileJarvisTurn;
        readonly projectRef: JarvisMeshProject["ref"];
        readonly expectedReply?: MobileJarvisTurn["expectedReply"];
        readonly clarificationFrameId?: string;
        readonly requestId: string;
        readonly utterance?: string;
        readonly sourceUtterance?: string;
        readonly semanticProposal?: import("@t3tools/contracts").JarvisSemanticProposal;
        readonly modelSelection?: ModelSelection;
      };
    }): Promise<string> => {
      const { turn, projectRef, utterance, draftForSpeech } = args;
      // One request identity per turn: model-clarification retries resend the
      // original utterance under the same requestId instead of minting work.
      const requestId = args.requestId ?? uuidv4();
      // A live desk approval can arrive after the original turn started. Park
      // its complete answer identity before dispatch so a transport failure
      // cannot make the retry rebind to a replacement approval from the desk.
      // Frame-bound answers already have an explicit parked owner. The exact
      // execute payload travels with the pin: requestId pins the proposal
      // and original source, never a rebuild from a changed desk.
      if (
        args.consumeServerPending === undefined &&
        args.clarificationFrameId === undefined &&
        turn.expectedReply !== undefined &&
        turn.expectedReply !== null
      ) {
        pendingServerAnswer.current = {
          turn,
          projectRef,
          expectedReply: turn.expectedReply,
          requestId,
          utterance,
          ...(args.sourceUtterance === undefined ? {} : { sourceUtterance: args.sourceUtterance }),
          ...(args.semanticProposal === undefined
            ? {}
            : { semanticProposal: args.semanticProposal }),
          ...(args.modelSelection === undefined ? {} : { modelSelection: args.modelSelection }),
        };
      }
      submittingRef.current = true;
      setSubmitting(true);
      // Truthful submission feedback through the existing message owner: the
      // request is being interpreted, not accepted, and no task progress is
      // claimed. The retained utterance travels along for correction.
      setMessage(formatMobileVoiceInterpretingMessage(utterance));
      inFlightRequest.current = {
        requestId,
        nodeId: projectRef.nodeId,
        originInteractionId: turn.originInteractionId,
        projectId: projectRef.projectId,
      };
      const result = await execute(
        buildMobileJarvisExecuteInput({
          turn,
          projectRef,
          utterance,
          ...(args.sourceUtterance === undefined ? {} : { sourceUtterance: args.sourceUtterance }),
          ...(args.semanticProposal === undefined
            ? {}
            : { semanticProposal: args.semanticProposal }),
          ...(args.modelSelection === undefined ? {} : { modelSelection: args.modelSelection }),
          ...(args.clarificationFrameId === undefined
            ? {}
            : { clarificationFrameId: args.clarificationFrameId }),
          requestId,
        }),
      ).finally(() => {
        if (inFlightRequest.current?.requestId === requestId) inFlightRequest.current = null;
        submittingRef.current = false;
        setSubmitting(false);
      });
      if (result._tag !== "Success") {
        const failure = commandError(result);
        setMessage(failure);
        if (turn.speechEnabled && turn.voiceNodeId !== undefined && shouldSpeakMobile("failed")) {
          speechSink.current?.({
            text: failure,
            nodeId: turn.voiceNodeId,
            speechKey: `${requestId}:failed`,
            threadKey: speechThreadKeyForTurn(turn),
            originInteractionId: turn.originInteractionId,
            requestId,
          });
        }
        removeActiveTurn(turn.originInteractionId);
        return requestId;
      }
      if (
        (args.consumeServerPending !== undefined &&
          pendingServerAnswer.current === args.consumeServerPending) ||
        (args.consumeServerPending === undefined &&
          pendingServerAnswer.current?.requestId === requestId)
      ) {
        // The answer landed: release the parked server answer it consumed.
        // A transport failure returns above, so the retry keeps answering the
        // same frame and pin. A successful response transfers ownership to
        // its model or server clarification below, if another answer is needed.
        pendingServerAnswer.current = null;
      }
      if (result.value.status === "cancelled") {
        // Pre-accept cancel won: nothing was dispatched, so no desk refresh,
        // no speech, and no success claim. A park created by this dispatch is
        // released; an older parked answer stays owned by its own frame.
        if (
          args.consumeServerPending === undefined &&
          pendingServerAnswer.current?.requestId === requestId
        ) {
          pendingServerAnswer.current = null;
        }
        removeActiveTurn(turn.originInteractionId);
        setMessage("Cancelled before it started.");
        return requestId;
      }
      if (result.value.status === "started") {
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
          turn.voiceNodeId !== undefined &&
          result.value.acknowledgement !== undefined &&
          shouldSpeakMobile("acknowledgement")
        ) {
          const startedTurnId = acceptedTurnIdForSpeech(result.value);
          speechSink.current?.({
            text: result.value.acknowledgement,
            nodeId: turn.voiceNodeId,
            speechKey: `${requestId}:started`,
            threadKey: mobileSpeechThreadKey(
              result.value.taskRef?.executionNodeId ?? turn.projectRef.nodeId,
              result.value.threadId,
            ),
            ...(startedTurnId === undefined ? {} : { turnId: startedTurnId }),
            originInteractionId: turn.originInteractionId,
            requestId,
          });
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
          if (
            draftForSpeech.speechEnabled &&
            draftForSpeech.voiceNodeId !== undefined &&
            shouldSpeakMobile("needs-input")
          ) {
            speechSink.current?.({
              text: prompt,
              nodeId: draftForSpeech.voiceNodeId,
              speechKey: `${requestId}:needs-input`,
              threadKey: speechThreadKeyForTurn(turn),
              originInteractionId: turn.originInteractionId,
              requestId,
            });
          }
        } else {
          // Server-owned clarification (project/task frame or pending-reply
          // question): pin the origin node and turn so the next instruction
          // goes back raw for the Host frame to consume. Candidates stay
          // server-side; an unmatched answer re-prompts instead of dispatching.
          const response = result.value.prompt;
          setMessage(response);
          if (
            turn.speechEnabled &&
            turn.voiceNodeId !== undefined &&
            shouldSpeakMobile("needs-input")
          ) {
            speechSink.current?.({
              text: response,
              nodeId: turn.voiceNodeId,
              speechKey: `${requestId}:needs-input`,
              threadKey: speechThreadKeyForTurn(turn),
              originInteractionId: turn.originInteractionId,
              requestId,
            });
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
        if (
          turn.speechEnabled &&
          turn.voiceNodeId !== undefined &&
          shouldSpeakMobile("acknowledgement")
        ) {
          const focusedTaskRef = result.value.taskRef;
          speechSink.current?.({
            text: result.value.message,
            nodeId: turn.voiceNodeId,
            speechKey: `${requestId}:focused`,
            threadKey:
              focusedTaskRef === undefined
                ? speechThreadKeyForTurn(turn)
                : mobileSpeechThreadKey(focusedTaskRef.executionNodeId, focusedTaskRef.threadId),
            originInteractionId: turn.originInteractionId,
            requestId,
          });
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
        if (
          turn.speechEnabled &&
          turn.voiceNodeId !== undefined &&
          shouldSpeakMobile("acknowledgement")
        ) {
          speechSink.current?.({
            text: response,
            nodeId: turn.voiceNodeId,
            speechKey: `${requestId}:message`,
            threadKey: speechThreadKeyForTurn(turn),
            originInteractionId: turn.originInteractionId,
            requestId,
          });
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
      // Verbatim source preserved for span authority; utterance checks trim
      // locally. New input queues behind in-flight work by default.
      const sourceUtterance = text.slice(0, 16_000);
      const utterance = text.trim();
      // Drain one queued additional input behind a settled turn, in FIFO
      // order. Every return path below that settles a submission calls this
      // so queued voice input is never stranded behind a converse, parked,
      // model, or choice answer.
      const drainQueuedInput = (): void => {
        const next = queuedInputsRef.current[0];
        if (next === undefined) return;
        queuedInputsRef.current = queuedInputsRef.current.slice(1);
        void runInstruction(next.draft, next.text);
      };
      if (utterance.length === 0) return;
      // Additional input queues by default; only an explicit cancel replaces.
      // Never auto-cancel in-flight interpret or execute on a new capture.
      if (submittingRef.current || activeInterpretRef.current !== null) {
        queuedInputsRef.current = [...queuedInputsRef.current, { draft, text }].slice(-8);
        return;
      }
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
        // The pending answer stays parked across a transport failure so
        // the retry answers the same frame and pin; executeControl clears
        // it only once an answer actually lands. A parked direct answer owns
        // its exact execute payload: requestId pins the proposal and original
        // source, so the retry resends them instead of rebuilding from the
        // changed desk or the new text. A frame-bound clarification without a
        // parked payload stays raw for the Host frame to consume.
        await executeControl({
          turn:
            serverPending.expectedReply === undefined
              ? serverPending.turn
              : { ...serverPending.turn, expectedReply: serverPending.expectedReply },
          projectRef: serverPending.projectRef,
          utterance: serverPending.utterance ?? utterance,
          ...(serverPending.utterance === undefined
            ? {}
            : serverPending.sourceUtterance === undefined
              ? {}
              : { sourceUtterance: serverPending.sourceUtterance }),
          ...(serverPending.utterance === undefined
            ? {}
            : serverPending.semanticProposal === undefined
              ? {}
              : { semanticProposal: serverPending.semanticProposal }),
          ...(serverPending.utterance === undefined
            ? {}
            : serverPending.modelSelection === undefined
              ? {}
              : { modelSelection: serverPending.modelSelection }),
          ...(serverPending.clarificationFrameId === undefined
            ? {}
            : { clarificationFrameId: serverPending.clarificationFrameId }),
          draftForSpeech: draft,
          requestId: serverPending.requestId,
          consumeServerPending: serverPending,
        });
        drainQueuedInput();
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
            if (
              draft.speechEnabled &&
              draft.voiceNodeId !== undefined &&
              shouldSpeakMobile("needs-input")
            ) {
              speechSink.current?.({
                text: prompt,
                nodeId: draft.voiceNodeId,
                speechKey: `${modelPending.requestId}:needs-input`,
                threadKey: speechThreadKeyForTurn(modelPending.turn),
                originInteractionId: modelPending.turn.originInteractionId,
                requestId: modelPending.requestId,
              });
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
          drainQueuedInput();
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
        if (
          draft.speechEnabled &&
          draft.voiceNodeId !== undefined &&
          shouldSpeakMobile("needs-input")
        ) {
          speechSink.current?.({
            text: retryMessage,
            nodeId: draft.voiceNodeId,
            speechKey: `route:${uuidv4()}`,
            threadKey: "",
            originInteractionId: draft.originInteractionId,
          });
        }
        return;
      }
      if (pendingAnswer?.status === "resolved") {
        // A proposal-grounded choice from the previous turn: the original
        // verbatim source stays authoritative, the answer only selects the
        // node-qualified project. No new inference; execute directly so the
        // execution node validates once against its authoritative catalog.
        const chosen = pendingAnswer;
        pendingRoute.current = null;
        const turn = routeMobileJarvisTurn(draft, chosen.project.ref, null);
        const projectKey = mobileJarvisProjectKey(chosen.project);
        setSelectedProjectKey(projectKey);
        taskDeskNodeIdRef.current = chosen.project.ref.nodeId;
        setTaskDeskNodeId(chosen.project.ref.nodeId);
        savePreferences({ preferredJarvisProjectRef: chosen.project.ref });
        replaceActiveTurn(turn);
        setPreparedOriginInteractionId(nextOriginInteractionId());
        if (turn.speechEnabled) {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
        }
        await executeControl({
          turn,
          projectRef: chosen.project.ref,
          utterance: chosen.utterance,
          sourceUtterance: chosen.sourceUtterance,
          draftForSpeech: draft,
        });
        drainQueuedInput();
        return;
      }
      // Fresh input: pins first, then one proposal before any routing.
      // No legacy phonetic preground reads the utterance here. Ambient comes
      // only from explicit selection, persisted preference, or a singleton;
      // a pinned task keeps its exact node and never swaps on a mention.
      // Routing context comes from the retained explicit focus, never from a
      // latest desk task. A new interaction observes the current desk for
      // the exact route node so a newly arrived approval is answered, not
      // the routing-time snapshot; an unknown desk keeps the retained pin.
      // The desk only enriches the same thread; a stale desk contributes
      // nothing and never selects another task.
      const retained = retainedFocusRef.current;
      // Pins first: resolve focus before choosing ambient or semantic nodes.
      // The desk only enriches the same retained thread; it never selects
      // another task. Start from the current desk snapshot when it belongs
      // to the retained node; the live read below refreshes the pinned node.
      let deskTasks =
        desk !== null && deskNodeId === taskDeskNodeIdRef.current
          ? [desk.focusedTask, ...desk.recentTasks].filter(
              (task): task is NonNullable<typeof task> => task !== null,
            )
          : [];
      // When retained pins a thread, refresh its exact node for the live pin
      // before any routing decision. An unknown desk keeps the retained pin.
      if (retained !== undefined && retained !== null && retained.projectRef !== undefined) {
        const live = await getTaskDesk({ nodeId: retained.projectRef.nodeId }).catch(() => null);
        if (
          live !== null &&
          live._tag === "Success" &&
          taskDeskNodeIdRef.current === retained.projectRef.nodeId
        ) {
          deskTasks = [
            ...(live.value.focusedTask === null ? [] : [live.value.focusedTask]),
            ...live.value.recentTasks,
          ];
        }
      }
      const focusContext = resolveMobileFocusContextTask({ retained, deskTasks });
      // Pinned mismatch preserves and rejects: a retained task whose project
      // left the catalog (removal or outage) reports unavailable instead of
      // borrowing ambient, singleton, or conversation targets. Explicit
      // project phrases still need a fresh instruction; they do not rescue
      // this turn because no destination has been proposed yet.
      if (
        focusContext !== null &&
        focusContext.projectRef !== undefined &&
        (catalog === null ||
          !catalog.projects.some((candidate) =>
            sameProjectRef(candidate.ref, focusContext.projectRef!),
          ))
      ) {
        const unavailableMessage =
          "The selected project is unavailable. Reconnect its node or say another project name.";
        setPreparedOriginInteractionId(nextOriginInteractionId());
        setMessage(unavailableMessage);
        if (draft.speechEnabled && draft.voiceNodeId !== undefined && shouldSpeakMobile("failed")) {
          speechSink.current?.({
            text: unavailableMessage,
            nodeId: draft.voiceNodeId,
            speechKey: `route:${uuidv4()}`,
            threadKey: "",
            originInteractionId: draft.originInteractionId,
          });
        }
        return;
      }
      // Ambient without reading the utterance: explicit selection, then
      // persisted preference, then a singleton. Anything else asks after the
      // proposal when it is not converse. Never infer from prepositions or
      // phonetics before the model.
      const ambientProject =
        selectedProject !== undefined &&
        catalog?.projects.some(
          (candidate) =>
            candidate.ref.nodeId === selectedProject.ref.nodeId &&
            candidate.ref.projectId === selectedProject.ref.projectId,
        )
          ? selectedProject
          : preferredProjectRef !== undefined
            ? (catalog?.projects.find((candidate) =>
                sameProjectRef(candidate.ref, preferredProjectRef),
              ) ?? undefined)
            : catalog?.projects.length === 1
              ? catalog.projects[0]
              : undefined;
      const ambientRef =
        focusContext?.projectRef ??
        ambientProject?.ref ??
        selectedProject?.ref ??
        preferredProjectRef;
      if (catalog === null) {
        setMessage("Connect an ARIS execution node before starting work.");
        return;
      }
      const semanticNode = selectJarvisSemanticNode(
        catalog,
        ambientRef?.nodeId ?? selectedProject?.ref.nodeId ?? preferredProjectRef?.nodeId,
      );
      if (semanticNode === undefined) {
        const anyOnline = catalog.nodes.some((node) => node.reachability === "online");
        setMessage(
          anyOnline
            ? "No ARIS conversation provider is ready. Check the node's provider setup."
            : "Connect an ARIS execution node before starting work.",
        );
        return;
      }
      // Fresh providers for the semantic inference: refresh the chosen
      // semantic node so the bounded evidence matches the node's configured
      // registry instead of a stale catalog snapshot.
      const refreshedSemantic = await refreshMeshNode({ nodeId: semanticNode.nodeId }).catch(
        () => null,
      );
      const evidenceCatalog =
        refreshedSemantic !== null && refreshedSemantic._tag === "Success"
          ? refreshedSemantic.value
          : catalog;
      const liveSemanticNode =
        evidenceCatalog.nodes.find((node) => node.nodeId === semanticNode.nodeId) ?? semanticNode;
      if (liveSemanticNode.reachability !== "online") {
        setMessage("Connect an ARIS execution node before starting work.");
        return;
      }
      // Bounded evidence matches the direct wire's 8-task window: recent desk
      // tasks (titles only, no IDs) plus focused task and pending hint. Pins
      // themselves never leave the owner node; only the hint travels.
      const evidenceTasks = deskTasks
        .filter(
          (task): task is typeof task & { readonly title: string } =>
            typeof (task as { readonly title?: unknown }).title === "string",
        )
        .slice(0, 8)
        .map((task) => {
          const projectTitle = evidenceCatalog.projects.find(
            (candidate) =>
              task.projectRef !== undefined && sameProjectRef(candidate.ref, task.projectRef),
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
      // Derive focused evidence from the retained selection without IDs: the
      // desk title for the pinned thread when known, else the ambient title.
      const focusedEvidence = (() => {
        if (focusContext?.threadId === undefined) {
          return ambientProject === undefined ? undefined : { title: ambientProject.title };
        }
        const pinned = deskTasks.find((task) => task.threadId === focusContext.threadId);
        return {
          title: (pinned?.title ?? ambientProject?.title ?? "task").slice(0, 240),
        };
      })();
      const pendingHint = (() => {
        const reply = (
          focusContext as { readonly pendingReply?: { readonly kind?: string } | null } | null
        )?.pendingReply;
        if (reply === undefined || reply === null) return undefined;
        return reply.kind === "approval" ? ("approval" as const) : ("question" as const);
      })();
      const turnRequestId = uuidv4();
      const interpretOrigin = draft.originInteractionId;
      const evidence = buildJarvisInterpretInput(evidenceCatalog, sourceUtterance, {
        ...(ambientProject === undefined ? {} : { currentProjectTitle: ambientProject.title }),
        ...(focusedEvidence === undefined ? {} : { focusedTask: focusedEvidence }),
        ...(draft.inputMode === undefined ? {} : { inputMode: draft.inputMode }),
        ...(pendingHint === undefined ? {} : { pendingHint }),
        tasks: evidenceTasks,
        requestMetadata: {
          requestId: turnRequestId,
          origin: { originInteractionId: interpretOrigin },
          ...(draft.inputMode === "voice"
            ? { inputMode: "voice" as const, sourceUtterance: sourceUtterance.slice(0, 16_000) }
            : {}),
        },
      });
      // Register the active interpret so an explicit correction cancel can
      // abort the proposal before any execution node is chosen. New
      // additional input queues behind; it never cancels here.
      activeInterpretRef.current = {
        requestId: turnRequestId,
        nodeId: semanticNode.nodeId,
        originInteractionId: interpretOrigin,
      };
      let interpreted: Awaited<ReturnType<typeof interpret>> | null = null;
      try {
        interpreted = await interpret({ nodeId: semanticNode.nodeId, interpret: evidence }).catch(
          () => null,
        );
      } finally {
        if (activeInterpretRef.current?.requestId === turnRequestId) {
          activeInterpretRef.current = null;
        }
      }
      if (interpreted === null || interpreted._tag !== "Success") {
        setMessage("ARIS couldn't interpret that request safely. Try again.");
        return;
      }
      const executionProposal = interpreted.value;
      // Converse is model-decided, never regex-shortcut before inference. Run
      // it project-free on the semantic node with the same request identity
      // so an explicit cancel aborts it; answers stay best-effort.
      if (executionProposal.action === "converse") {
        // The interpret call that classified this turn already carries the
        // spoken answer for converse; use it instead of paying a second
        // supervisor round trip. The dedicated converse call stays for
        // proposals that arrived without an answer.
        const proposalAnswer = executionProposal.answer?.trim();
        if (proposalAnswer !== undefined && proposalAnswer.length > 0) {
          setMessage(proposalAnswer);
          if (draft.speechEnabled && draft.voiceNodeId !== undefined) {
            speechSink.current?.({
              text: proposalAnswer,
              nodeId: draft.voiceNodeId,
              speechKey: `converse:${uuidv4()}`,
              threadKey: "",
              originInteractionId: draft.originInteractionId,
            });
          }
          drainQueuedInput();
          return;
        }
        submittingRef.current = true;
        setSubmitting(true);
        setMessage(formatMobileVoiceInterpretingMessage(utterance));
        setPreparedOriginInteractionId(nextOriginInteractionId());
        if (draft.speechEnabled) {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
        }
        const converseRequestId = turnRequestId;
        const converseProjectId =
          ambientProject?.ref.projectId ??
          selectedProject?.ref.projectId ??
          preferredProjectRef?.projectId;
        if (converseProjectId !== undefined) {
          inFlightRequest.current = {
            requestId: converseRequestId,
            nodeId: semanticNode.nodeId,
            originInteractionId: draft.originInteractionId,
            projectId: converseProjectId,
          };
        }
        let converseResult: Awaited<ReturnType<typeof converse>> | null = null;
        try {
          converseResult = await converse({
            nodeId: semanticNode.nodeId,
            utterance: utterance.slice(0, 16_000),
            requestMetadata: {
              requestId: converseRequestId,
              origin: { originInteractionId: draft.originInteractionId },
            },
          });
        } finally {
          if (inFlightRequest.current?.requestId === converseRequestId) {
            inFlightRequest.current = null;
          }
          submittingRef.current = false;
          setSubmitting(false);
          drainQueuedInput();
        }
        if (converseResult === null || converseResult._tag !== "Success") {
          const failure =
            converseResult === null
              ? "I couldn't answer that just now."
              : commandError(converseResult);
          setMessage(failure);
          if (
            draft.speechEnabled &&
            draft.voiceNodeId !== undefined &&
            shouldSpeakMobile("failed")
          ) {
            speechSink.current?.({
              text: failure,
              nodeId: draft.voiceNodeId,
              speechKey: `converse:${uuidv4()}`,
              threadKey: "",
              originInteractionId: draft.originInteractionId,
            });
          }
          return;
        }
        if (converseResult.value.status === "needs-input") {
          setMessage(converseResult.value.prompt);
          if (draft.speechEnabled && draft.voiceNodeId !== undefined) {
            speechSink.current?.({
              text: converseResult.value.prompt,
              nodeId: draft.voiceNodeId,
              speechKey: `converse:${uuidv4()}`,
              threadKey: "",
              originInteractionId: draft.originInteractionId,
            });
          }
          return;
        }
        if (converseResult.value.status !== "acknowledged") {
          setMessage("I couldn't answer that just now.");
          return;
        }
        setMessage(converseResult.value.message);
        if (draft.speechEnabled && draft.voiceNodeId !== undefined) {
          speechSink.current?.({
            text: converseResult.value.message,
            nodeId: draft.voiceNodeId,
            speechKey: `converse:${uuidv4()}`,
            threadKey: "",
            originInteractionId: draft.originInteractionId,
          });
        }
        return;
      }
      // Proposal-first grounding: the host grounds destination/correction
      // against the real catalog. Ambiguity parks node-qualified choices,
      // disconnected reports unavailable with no fallback, and
      // negated/malformed stays ambient for authoritative clarification.
      // Pins never leave the owner node: a pinned contextThreadId forces
      // ambient so the turn never swaps projects on a mention.
      const executeRoute = resolveJarvisProposalExecuteRoute(
        evidenceCatalog,
        sourceUtterance,
        executionProposal,
        ambientRef === undefined
          ? null
          : {
              projectRef: ambientRef,
              ...(focusContext?.threadId === undefined
                ? {}
                : { contextThreadId: focusContext.threadId }),
            },
      );
      let executionProject: JarvisMeshProject | undefined;
      if (executeRoute.status === "routed") {
        executionProject = executeRoute.project;
      } else if (executeRoute.status === "needs-choice") {
        const prompt =
          `"${utterance}" names a project on more than one device. ` +
          `Which one should I use? Say its name with your instruction.`;
        pendingRoute.current = {
          draft,
          route: {
            status: "needs-input",
            prompt,
            utterance,
            sourceUtterance,
            candidates: executeRoute.candidates.map((candidate) => ({
              project: {
                ref: candidate.ref,
                projectId: candidate.projectId,
                title: candidate.title,
                workspaceRoot: candidate.workspaceRoot,
                nodeLabel: candidate.nodeLabel,
                repositoryNames: candidate.repositoryNames,
                aliases: candidate.aliases,
                aliasDetails: candidate.aliasDetails,
              },
              label: candidate.label,
            })),
            acceptsAffirmation: false,
          },
        };
        setPreparedOriginInteractionId(nextOriginInteractionId());
        setMessage(prompt);
        if (
          draft.speechEnabled &&
          draft.voiceNodeId !== undefined &&
          shouldSpeakMobile("needs-input")
        ) {
          speechSink.current?.({
            text: prompt,
            nodeId: draft.voiceNodeId,
            speechKey: `route:${uuidv4()}`,
            threadKey: "",
            originInteractionId: draft.originInteractionId,
          });
        }
        return;
      } else if (executeRoute.status === "unavailable") {
        const unavailableMessage =
          `${executeRoute.project.title} is on ${executeRoute.nodeLabel}, ` +
          `which is disconnected. Reconnect it and try again.`;
        setPreparedOriginInteractionId(nextOriginInteractionId());
        setMessage(unavailableMessage);
        if (draft.speechEnabled && draft.voiceNodeId !== undefined && shouldSpeakMobile("failed")) {
          speechSink.current?.({
            text: unavailableMessage,
            nodeId: draft.voiceNodeId,
            speechKey: `route:${uuidv4()}`,
            threadKey: "",
            originInteractionId: draft.originInteractionId,
          });
        }
        return;
      } else {
        // Ambient covers negated-only, malformed, unknown, and pinned
        // followups. A pinned task keeps its exact project; otherwise use
        // the ambient selected above. Never fall back to another node.
        if (focusContext?.projectRef !== undefined) {
          const focusProject = evidenceCatalog.projects.find((candidate) =>
            sameProjectRef(candidate.ref, focusContext.projectRef!),
          );
          if (focusProject !== undefined) {
            executionProject = focusProject;
          } else {
            const unavailableMessage =
              "The selected project is unavailable. Reconnect its node or say another project name.";
            setMessage(unavailableMessage);
            return;
          }
        } else {
          executionProject = ambientProject;
        }
        if (executionProject === undefined) {
          // No ambient and not converse: ask explicitly with bounded
          // node-qualified candidates instead of guessing.
          const candidates = evidenceCatalog.projects.slice(0, 5).map((project) => ({
            project: {
              ref: project.ref,
              projectId: project.projectId,
              title: project.title,
              workspaceRoot: project.workspaceRoot,
              nodeLabel: project.nodeLabel,
              repositoryNames: project.repositoryNames,
              aliases: project.aliases,
              aliasDetails: project.aliasDetails,
            },
            label: `${project.title} — ${project.nodeLabel}`,
          }));
          const prompt =
            candidates.length === 0
              ? "Connect an ARIS execution node before starting work."
              : "Which project should I use? Say its name or number.";
          if (candidates.length === 0) {
            setMessage(prompt);
            return;
          }
          pendingRoute.current = {
            draft,
            route: {
              status: "needs-input",
              prompt,
              utterance,
              sourceUtterance,
              candidates,
              acceptsAffirmation: false,
            },
          };
          setPreparedOriginInteractionId(nextOriginInteractionId());
          setMessage(
            `${prompt} ${candidates.map(({ label }, index) => `${index + 1}. ${label}`).join("  ")}`,
          );
          if (
            draft.speechEnabled &&
            draft.voiceNodeId !== undefined &&
            shouldSpeakMobile("needs-input")
          ) {
            speechSink.current?.({
              text: prompt,
              nodeId: draft.voiceNodeId,
              speechKey: `route:${uuidv4()}`,
              threadKey: "",
              originInteractionId: draft.originInteractionId,
            });
          }
          return;
        }
      }
      // Uniqueness needs a complete catalog: a name-dependent route is
      // unsound while a peer catalog is unread, so confirm instead of
      // dispatching. Name-independent turns stay ambient, pinned followups
      // never interrupt, and malformed proposals proceed to authoritative
      // execution clarification.
      if (executionProject !== undefined) {
        const coverageConfirm = resolveJarvisRouteCoverageConfirm({
          catalog: evidenceCatalog,
          source: sourceUtterance,
          proposal: executionProposal,
          resolved: executionProject,
          routed: executeRoute.status === "routed",
          pinned: focusContext?.threadId !== undefined,
        });
        if (coverageConfirm.status === "confirm") {
          const label = `${coverageConfirm.project.title} — ${coverageConfirm.project.nodeLabel}`;
          const prompt =
            `${coverageConfirm.nodeLabels.join(", ")} ${coverageConfirm.nodeLabels.length === 1 ? "is" : "are"} unreachable, so I can't tell if the name is unique. ` +
            `Use ${label}?`;
          pendingRoute.current = {
            draft,
            route: {
              status: "needs-input",
              prompt,
              utterance,
              sourceUtterance,
              candidates: [
                {
                  project: {
                    ref: coverageConfirm.project.ref,
                    projectId: coverageConfirm.project.projectId,
                    title: coverageConfirm.project.title,
                    workspaceRoot: coverageConfirm.project.workspaceRoot,
                    nodeLabel: coverageConfirm.project.nodeLabel,
                    repositoryNames: coverageConfirm.project.repositoryNames,
                    aliases: coverageConfirm.project.aliases,
                    aliasDetails: coverageConfirm.project.aliasDetails,
                  },
                  label,
                },
              ],
              acceptsAffirmation: true,
            },
          };
          setPreparedOriginInteractionId(nextOriginInteractionId());
          setMessage(prompt);
          return;
        }
      }
      const turn = routeMobileJarvisTurn(draft, executionProject.ref, focusContext);
      const projectKey = mobileJarvisProjectKey(executionProject);
      setSelectedProjectKey(projectKey);
      taskDeskNodeIdRef.current = executionProject.ref.nodeId;
      setTaskDeskNodeId(executionProject.ref.nodeId);
      savePreferences({ preferredJarvisProjectRef: executionProject.ref });
      replaceActiveTurn(turn);
      setPreparedOriginInteractionId(nextOriginInteractionId());
      // Immediate latency cue: transcription plus semantic interpretation
      // can take many seconds, and silence reads as broken. A haptic tick is
      // action-neutral — contextual wording stays Host-owned (see below).
      if (turn.speechEnabled) {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
      }
      try {
        await executeControl({
          turn,
          projectRef: executionProject.ref,
          utterance,
          sourceUtterance,
          semanticProposal: executionProposal,
          draftForSpeech: draft,
          requestId: turnRequestId,
        });
      } finally {
        // Drain one queued additional input behind the settled turn. An
        // explicit replace cancels instead of queuing, so this path never
        // auto-cancels; it runs the next queued instruction in order.
        const next = queuedInputsRef.current[0];
        if (next !== undefined) {
          queuedInputsRef.current = queuedInputsRef.current.slice(1);
          void runInstruction(next.draft, next.text);
        }
      }
    },
    [
      cancelServerFrame,
      catalog,
      catalog?.nodes,
      catalog?.projects,
      converse,
      desk,
      deskNodeId,
      executeControl,
      getTaskDesk,
      interpret,
      preferredProjectRef,
      refreshMeshNode,
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
      if (
        turn.speechEnabled &&
        turn.voiceNodeId !== undefined &&
        shouldSpeakMobile(mobileSpeechKindForPresentation(event.kind))
      ) {
        speechSink.current?.({
          text: mobileSpeechText(event),
          nodeId: turn.voiceNodeId,
          speechKey: event.presentationId,
          threadKey: mobileSpeechThreadKey(
            event.taskRef?.executionNodeId ?? turn.projectRef.nodeId,
            event.threadId,
          ),
          // Accepted-result turn identity through the existing schema: the
          // presentation turnId is the primary key with the thread, and the
          // exact requestId covers terminal-before-ack when the turn is not
          // yet accepted. originInteractionId is retained for diagnostics
          // only and never decides staleness.
          // No verb filtering here: the composed ack lane owns wording.
          ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
          ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
          originInteractionId: turn.originInteractionId,
          terminal: event.kind === "completed" || event.kind === "failed",
        });
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
      unavailableProjectKey:
        catalog !== null && selectedProject === undefined ? selectedProjectKey : null,
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
      cancelInflightRequest,
      createTextTurn,
      setMessage,
      attachSpeechSink,
    }),
    [
      attachSpeechSink,
      cancelInflightRequest,
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
