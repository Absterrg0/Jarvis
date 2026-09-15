import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

export type ReconcileMobileThreadLookup =
  | {
      readonly status: "found";
      readonly sessionStatus:
        | "idle"
        | "starting"
        | "running"
        | "ready"
        | "interrupted"
        | "stopped"
        | "error"
        | null;
      readonly latestTurnState: "running" | "interrupted" | "completed" | "error" | null;
    }
  | { readonly status: "missing" }
  | { readonly status: "unreachable" };

/**
 * Durable reconciliation for retained mobile turns.
 *
 * Presentation listeners only retire a turn when its live terminal event
 * arrives. A completion while disconnected leaves the turn and its listener
 * behind, so reconnect and foreground reconcile retained task references
 * against ordinary durable desk state instead of replaying speech.
 *
 * A turn retires silently when its node is gone from the catalog or its task
 * reports a terminal state. Anything unknown stays: a missing desk row may
 * mean eviction rather than deletion, and an unreachable node may simply be
 * offline, so neither retires live work.
 */
export interface ReconcileMobileTaskRef {
  readonly threadId: ThreadId;
  /** Node that owns the task; a compound turn may start tasks on several. */
  readonly executionNodeId?: EnvironmentId;
}

export interface ReconcileMobileTurn {
  readonly originInteractionId: string;
  readonly projectRef: { readonly nodeId: EnvironmentId };
  readonly taskRef?: ReconcileMobileTaskRef;
  /** Every task the interaction started; retire only when all are terminal. */
  readonly taskRefs?: ReadonlyArray<ReconcileMobileTaskRef>;
}

export interface ReconcileMobileDeskTask {
  readonly threadId: ThreadId;
  readonly state:
    | "running"
    | "waiting-for-input"
    | "waiting-for-approval"
    | "ready"
    | "failed"
    | "interrupted";
}

/** Every retained task of a turn with the node that owns it. */
function retainedMobileTaskRefs(
  turn: ReconcileMobileTurn,
): ReadonlyArray<{ readonly threadId: ThreadId; readonly nodeId: EnvironmentId }> {
  const refs =
    turn.taskRefs !== undefined && turn.taskRefs.length > 0
      ? turn.taskRefs
      : turn.taskRef === undefined
        ? []
        : [turn.taskRef];
  return refs.map((ref) => ({
    threadId: ref.threadId,
    nodeId: ref.executionNodeId ?? turn.projectRef.nodeId,
  }));
}

/**
 * Group retained task references by node with one entry per distinct
 * thread. Several retained interactions can reference one thread (a retry
 * keeps its own origin while the task reference stays put); reconciling
 * each distinct thread once avoids repeating durable lookups per turn.
 */
export function groupRetainedThreadIdsByNode(
  turns: ReadonlyArray<ReconcileMobileTurn>,
): ReadonlyMap<EnvironmentId, ReadonlyArray<ThreadId>> {
  const grouped = new Map<EnvironmentId, Set<ThreadId>>();
  for (const turn of turns) {
    for (const ref of retainedMobileTaskRefs(turn)) {
      const nodeThreads = grouped.get(ref.nodeId) ?? new Set<ThreadId>();
      nodeThreads.add(ref.threadId);
      grouped.set(ref.nodeId, nodeThreads);
    }
  }
  return new Map([...grouped].map(([nodeId, threadIds]) => [nodeId, [...threadIds]] as const));
}

function isDurableThreadActive(lookup: ReconcileMobileThreadLookup | undefined): boolean {
  return (
    lookup?.status === "found" &&
    (lookup.sessionStatus === "starting" ||
      lookup.sessionStatus === "running" ||
      lookup.latestTurnState === "running")
  );
}

/** One retained task is finished when its node is gone or its live state is terminal. */
function isRetainedTaskFinished(
  ref: { readonly threadId: ThreadId; readonly nodeId: EnvironmentId },
  input: {
    readonly desks: ReadonlyMap<EnvironmentId, ReadonlyArray<ReconcileMobileDeskTask>>;
    readonly threads?: ReadonlyMap<
      EnvironmentId,
      ReadonlyMap<ThreadId, ReconcileMobileThreadLookup>
    >;
    readonly cataloguedNodeIds: ReadonlySet<EnvironmentId>;
  },
): boolean {
  if (!input.cataloguedNodeIds.has(ref.nodeId)) return true;
  const tasks = input.desks.get(ref.nodeId);
  const task = tasks?.find((candidate) => candidate.threadId === ref.threadId);
  const lookup = input.threads?.get(ref.nodeId)?.get(ref.threadId);
  // A stale desk/session terminal marker must not win over a currently
  // running session or latest turn from the ordinary durable snapshot.
  if (isDurableThreadActive(lookup)) return false;
  if (
    task !== undefined &&
    (task.state === "ready" || task.state === "failed" || task.state === "interrupted")
  ) {
    return true;
  }
  if (lookup?.status === "missing") return true;
  return (
    lookup?.status === "found" &&
    (lookup.sessionStatus === "ready" ||
      lookup.sessionStatus === "interrupted" ||
      lookup.sessionStatus === "stopped" ||
      lookup.sessionStatus === "error" ||
      lookup.latestTurnState === "interrupted" ||
      lookup.latestTurnState === "completed" ||
      lookup.latestTurnState === "error")
  );
}

export function retireFinishedMobileTurns(input: {
  readonly turns: ReadonlyArray<ReconcileMobileTurn>;
  /** Thread states by node; absent nodes were unreachable during reconcile. */
  readonly desks: ReadonlyMap<EnvironmentId, ReadonlyArray<ReconcileMobileDeskTask>>;
  /** Ordinary durable thread lookups, keyed by node and thread. */
  readonly threads?: ReadonlyMap<EnvironmentId, ReadonlyMap<ThreadId, ReconcileMobileThreadLookup>>;
  readonly cataloguedNodeIds: ReadonlySet<EnvironmentId>;
}): ReadonlyArray<string> {
  const retired: Array<string> = [];
  for (const turn of input.turns) {
    const refs = retainedMobileTaskRefs(turn);
    if (refs.length === 0) continue;
    // A compound turn retires only when every task it started has settled.
    if (refs.every((ref) => isRetainedTaskFinished(ref, input))) {
      retired.push(turn.originInteractionId);
    }
  }
  return retired;
}
