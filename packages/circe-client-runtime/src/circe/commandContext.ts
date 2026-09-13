import type {
  CirceExpectedReply,
  CirceProjectRef,
  CirceTaskPendingReply,
  CirceTaskRef,
  ThreadId,
} from "@t3tools/contracts";

/** Minimal node-qualified task shape shared by desk views and turn snapshots. */
export type CirceClientContextTask = {
  readonly threadId: ThreadId;
  readonly taskRef?: CirceTaskRef;
  readonly projectRef?: CirceProjectRef;
  readonly pendingReply?: CirceTaskPendingReply | null;
};

export type CirceClientCommandContext = {
  readonly contextThreadId?: ThreadId;
  readonly referenceThreadId?: ThreadId;
  readonly expectedReply?: CirceExpectedReply | null;
};

/**
 * Build execute context from the selected project and one node-qualified
 * task. The task's project and execution identities must agree with the
 * selection; any mismatch yields no context so an explicit project override
 * never inherits a stale focused task.
 *
 * Answer pin tri-state: a projected unique pending request becomes the pin,
 * an explicit null projection (snapshot saw nothing uniquely waiting)
 * becomes a null pin that rejects newly opened requests on the reply path,
 * and an absent projection stays unknown for payloads predating it.
 */
export function buildCirceClientCommandContext(input: {
  readonly projectRef: CirceProjectRef;
  readonly task?: CirceClientContextTask | null;
}): CirceClientCommandContext {
  const task = input.task;
  if (task === undefined || task === null) return {};
  const projectRef = task.projectRef;
  const taskRef = task.taskRef;
  if (projectRef === undefined || taskRef === undefined) return {};
  if (projectRef.nodeId !== input.projectRef.nodeId) return {};
  if (projectRef.projectId !== input.projectRef.projectId) return {};
  if (taskRef.executionNodeId !== input.projectRef.nodeId) return {};
  if (taskRef.threadId !== task.threadId) return {};
  const pendingReply = task.pendingReply;
  return {
    contextThreadId: task.threadId,
    referenceThreadId: taskRef.threadId,
    // Null pins an explicit snapshot of no unique pending request; absent
    // stays unknown for payloads predating the projection.
    ...(pendingReply === undefined
      ? {}
      : {
          expectedReply:
            pendingReply === null
              ? null
              : {
                  kind:
                    pendingReply.kind === "approval" ? ("approval" as const) : ("input" as const),
                  requestId: pendingReply.requestId,
                },
        }),
  };
}

/**
 * Compare two reply pins by identity. Unknown (absent) never equals an
 * observed pin: callers must not treat "not yet observed" as a change.
 */
export function isSameCirceReplyPin(
  left: CirceTaskPendingReply | null | undefined,
  right: CirceTaskPendingReply | null | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === undefined && right === undefined;
  if (left === null || right === null) return left === null && right === null;
  return left.kind === right.kind && left.requestId === right.requestId;
}

/**
 * Resolve the live pending-request pin for an explicitly selected task
 * against current authoritative desk state. Thread, execution node, and
 * project must all agree; anything else keeps the retained selection
 * untouched, so refreshing state never selects another task. A desk entry
 * without a pin is unknown rather than an authoritative none: the retained
 * pin survives. Only a present entry carrying an explicit null clears it.
 */
export function resolveCirceLiveContextTask(input: {
  readonly selected?: CirceClientContextTask | null;
  readonly deskTasks: ReadonlyArray<CirceClientContextTask>;
}): CirceClientContextTask | null | undefined {
  const selected = input.selected;
  if (selected === undefined || selected === null) return selected;
  if (selected.taskRef === undefined || selected.projectRef === undefined) return selected;
  const live = input.deskTasks.find(
    (candidate) =>
      candidate.threadId === selected.threadId &&
      candidate.taskRef !== undefined &&
      candidate.projectRef !== undefined &&
      candidate.taskRef.executionNodeId === selected.taskRef?.executionNodeId &&
      candidate.taskRef.threadId === selected.threadId &&
      candidate.projectRef.nodeId === selected.projectRef?.nodeId &&
      candidate.projectRef.projectId === selected.projectRef?.projectId,
  );
  if (live === undefined || live.pendingReply === undefined) return selected;
  return { ...selected, pendingReply: live.pendingReply };
}
