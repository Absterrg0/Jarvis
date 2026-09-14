import type {
  CirceExecutionPlanStep,
  CirceProjectRef,
  CirceTaskRef,
  ThreadId,
} from "@t3tools/contracts";

/**
 * One target transition a validated plan step implies. It mirrors exactly what
 * the same result does on its own: a focus adopts its node-qualified identity,
 * a start pins the node-qualified task.
 */
export type CircePlanTargetOutcome =
  | { readonly kind: "project"; readonly projectRef: CirceProjectRef }
  | {
      readonly kind: "task";
      readonly projectRef: CirceProjectRef;
      readonly taskRef: CirceTaskRef;
    }
  | {
      readonly kind: "start";
      readonly projectRef: CirceProjectRef;
      readonly taskRef: CirceTaskRef;
      readonly threadId: ThreadId;
    };

/**
 * Ordered client target transitions for a multi-command result. Applying them
 * in order reproduces the same focus and start state an ordinary single result
 * would, so a compound turn never leaves a stale project or missing pin.
 * Later steps win, matching execution order.
 */
export function circePlanTargetOutcomes(
  steps: ReadonlyArray<CirceExecutionPlanStep>,
  fallbackProjectRef: CirceProjectRef,
): ReadonlyArray<CircePlanTargetOutcome> {
  const outcomes: Array<CircePlanTargetOutcome> = [];
  for (const step of steps) {
    if (step.status === "started" && step.threadId !== undefined) {
      const taskRef = step.taskRef ?? {
        executionNodeId: fallbackProjectRef.nodeId,
        threadId: step.threadId,
      };
      outcomes.push({
        kind: "start",
        taskRef,
        threadId: step.threadId,
        projectRef: {
          nodeId: taskRef.executionNodeId,
          projectId: step.projectId ?? fallbackProjectRef.projectId,
        },
      });
      continue;
    }
    if (step.action === "focused" && step.projectId !== undefined) {
      const projectRef: CirceProjectRef = {
        nodeId: step.taskRef?.executionNodeId ?? fallbackProjectRef.nodeId,
        projectId: step.projectId,
      };
      outcomes.push(
        step.taskRef === undefined
          ? { kind: "project", projectRef }
          : { kind: "task", projectRef, taskRef: step.taskRef },
      );
    }
  }
  return outcomes;
}
