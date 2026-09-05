import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

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

export function retireFinishedMobileTurns(input: {
  readonly turns: ReadonlyArray<ReconcileMobileTurn>;
  /** Thread states by node; absent nodes were unreachable during reconcile. */
  readonly desks: ReadonlyMap<EnvironmentId, ReadonlyArray<ReconcileMobileDeskTask>>;
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
    if (tasks === undefined) continue;
    const task = tasks.find((candidate) => candidate.threadId === turn.taskRef?.threadId);
    if (task === undefined) continue;
    if (task.state === "ready" || task.state === "failed" || task.state === "interrupted") {
      retired.push(turn.originInteractionId);
    }
  }
  return retired;
}
