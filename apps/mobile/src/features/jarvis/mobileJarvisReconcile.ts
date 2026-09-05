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
export interface ReconcileMobileTurn {
  readonly originInteractionId: string;
  readonly projectRef: { readonly nodeId: EnvironmentId };
  readonly taskRef?: { readonly threadId: ThreadId };
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

function isDurableThreadActive(lookup: ReconcileMobileThreadLookup | undefined): boolean {
  return (
    lookup?.status === "found" &&
    (lookup.sessionStatus === "starting" ||
      lookup.sessionStatus === "running" ||
      lookup.latestTurnState === "running")
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
    if (turn.taskRef === undefined) continue;
    if (!input.cataloguedNodeIds.has(turn.projectRef.nodeId)) {
      retired.push(turn.originInteractionId);
      continue;
    }
    const tasks = input.desks.get(turn.projectRef.nodeId);
    const task = tasks?.find((candidate) => candidate.threadId === turn.taskRef?.threadId);
    const lookup = input.threads?.get(turn.projectRef.nodeId)?.get(turn.taskRef.threadId);
    // A stale desk/session terminal marker must not win over a currently
    // running session or latest turn from the ordinary durable snapshot.
    if (isDurableThreadActive(lookup)) continue;
    if (
      task !== undefined &&
      (task.state === "ready" || task.state === "failed" || task.state === "interrupted")
    ) {
      retired.push(turn.originInteractionId);
      continue;
    }
    if (lookup?.status === "missing") {
      retired.push(turn.originInteractionId);
      continue;
    }
    if (
      lookup?.status === "found" &&
      (lookup.sessionStatus === "ready" ||
        lookup.sessionStatus === "interrupted" ||
        lookup.sessionStatus === "stopped" ||
        lookup.sessionStatus === "error" ||
        lookup.latestTurnState === "interrupted" ||
        lookup.latestTurnState === "completed" ||
        lookup.latestTurnState === "error")
    ) {
      retired.push(turn.originInteractionId);
    }
  }
  return retired;
}
