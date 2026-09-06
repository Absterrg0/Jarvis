import type {
  JarvisExpectedReply,
  JarvisProjectRef,
  JarvisTaskPendingReply,
  JarvisTaskRef,
  ThreadId,
} from "@t3tools/contracts";

/** Minimal node-qualified task shape shared by desk views and turn snapshots. */
export type JarvisClientContextTask = {
  readonly threadId: ThreadId;
  readonly taskRef?: JarvisTaskRef;
  readonly projectRef?: JarvisProjectRef;
  readonly pendingReply?: JarvisTaskPendingReply | null;
};

export type JarvisClientCommandContext = {
  readonly contextThreadId?: ThreadId;
  readonly referenceThreadId?: ThreadId;
  readonly expectedReply?: JarvisExpectedReply | null;
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
export function buildJarvisClientCommandContext(input: {
  readonly projectRef: JarvisProjectRef;
  readonly task?: JarvisClientContextTask | null;
}): JarvisClientCommandContext {
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
