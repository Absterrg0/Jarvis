import type {
  EnvironmentId,
  CirceExecutionResult,
  CirceExpectedReply,
  CirceProjectRef,
  CirceRequestMetadata,
  CirceTaskPendingReply,
  CirceTaskRef,
  ModelSelection,
  ThreadId,
} from "@t3tools/contracts";
import {
  buildCirceClientCommandContext,
  resolveCirceLiveContextTask,
  type CirceClientContextTask,
} from "@circe/client-runtime/circe/commandContext";
import { sameProjectRef } from "./mobileCirceSelection";

type MobileCirceDraftBase = {
  readonly originInteractionId: string;
};

/** A mobile instruction before Circe grounds its execution project. Text only. */
export type MobileCirceDraft = MobileCirceDraftBase & {
  readonly inputMode: "text";
};

/** Ephemeral routed context for one mobile-origin interaction. T3 owns durable task state. */
export type MobileCirceTurn = MobileCirceDraft & {
  readonly projectRef: CirceProjectRef;
  readonly taskRef?: CirceTaskRef;
  /**
   * Every task this interaction started. A compound turn can start more than
   * one; the origin presentation listener must stay until all are terminal.
   */
  readonly taskRefs?: ReadonlyArray<CirceTaskRef>;
  readonly contextThreadId?: ThreadId;
  readonly referenceThreadId?: ThreadId;
  readonly expectedReply?: CirceExpectedReply | null;
};

export function createMobileCirceTurn(input: {
  readonly originInteractionId: string;
  readonly inputMode: "text";
}): MobileCirceDraft {
  return { ...input };
}

export function routeMobileCirceTurn(
  draft: MobileCirceDraft,
  projectRef: CirceProjectRef,
  task?: {
    readonly threadId: ThreadId;
    readonly taskRef?: CirceTaskRef;
    readonly projectRef?: CirceProjectRef;
    readonly pendingReply?: CirceTaskPendingReply | null;
  } | null,
): MobileCirceTurn {
  const context = buildCirceClientCommandContext({
    projectRef,
    ...(task === undefined || task === null ? {} : { task }),
  });
  return { ...draft, projectRef, ...context };
}

export function attachMobileCirceTask(
  turn: MobileCirceTurn,
  taskRef: CirceTaskRef | undefined,
): MobileCirceTurn {
  return attachMobileCirceTasks(turn, taskRef === undefined ? [] : [taskRef]);
}

/** Attach every task one compound turn started, in order. */
export function attachMobileCirceTasks(
  turn: MobileCirceTurn,
  taskRefs: ReadonlyArray<CirceTaskRef>,
): MobileCirceTurn {
  if (taskRefs.length === 0) return turn;
  return { ...turn, taskRef: taskRefs[0], taskRefs };
}

/** Every started task on a turn, whether recorded as one ref or many. */
export function mobileTurnTaskRefs(
  turn: Pick<MobileCirceTurn, "taskRef" | "taskRefs">,
): ReadonlyArray<CirceTaskRef> {
  if (turn.taskRefs !== undefined && turn.taskRefs.length > 0) return turn.taskRefs;
  return turn.taskRef === undefined ? [] : [turn.taskRef];
}

export type MobileCirceDeskTaskIdentity = {
  readonly threadId: ThreadId;
  readonly taskRef?: CirceTaskRef;
  readonly projectRef?: CirceProjectRef;
  readonly pendingReply?: CirceTaskPendingReply | null;
};

/**
 * Merge a retained explicit focus with live desk identity through the shared
 * client policy: the desk may only enrich the SAME thread by supplying its
 * pending-request pin and never selects another task. Unknown desk state
 * leaves the retained identity alone.
 */
export function resolveMobileFocusContextTask(input: {
  readonly retained: CirceClientContextTask | null | undefined;
  readonly deskTasks: ReadonlyArray<MobileCirceDeskTaskIdentity>;
}): (CirceClientContextTask & { readonly pendingReply?: CirceTaskPendingReply | null }) | null {
  const resolved = resolveCirceLiveContextTask({
    ...(input.retained === undefined ? {} : { selected: input.retained }),
    deskTasks: input.deskTasks,
  });
  return resolved ?? null;
}

/**
 * Restore an unrestored focus from the first authoritative desk read. Only a
 * current desk for the selected node qualifies: stale-node desks and project
 * mismatches stay unrestored, and an explicit project-only null is never
 * overridden. Callers gate on retained undefined; this helper also honors it.
 */
export function restoreMobileFocusFromDesk(input: {
  readonly retained: CirceClientContextTask | null | undefined;
  readonly deskFocusedTask: MobileCirceDeskTaskIdentity | null;
  readonly deskNodeId: EnvironmentId | null;
  readonly selectedDeskNodeId: EnvironmentId | null;
  readonly selectedProjectRef?: CirceProjectRef;
  readonly preferredProjectRef?: CirceProjectRef;
}): CirceClientContextTask | null | undefined {
  if (input.retained !== undefined) return input.retained;
  if (input.deskFocusedTask === null) return undefined;
  if (input.deskNodeId === null || input.selectedDeskNodeId === null) return undefined;
  if (input.deskNodeId !== input.selectedDeskNodeId) return undefined;
  const anchor = input.selectedProjectRef ?? input.preferredProjectRef;
  if (anchor === undefined) return undefined;
  const focused = input.deskFocusedTask;
  if (focused.projectRef === undefined || focused.taskRef === undefined) return undefined;
  if (!sameProjectRef(focused.projectRef, anchor)) return undefined;
  return { threadId: focused.threadId, taskRef: focused.taskRef, projectRef: focused.projectRef };
}

export type MobileServerFrameCancelOutcome = "cleared" | "retired" | "failed";

/**
 * Classify a bound frame-cancel response. Only an acknowledgement clears;
 * the exact-frame rejection retires the local prompt without claiming
 * success; anything else (including freshly started work) keeps the frame.
 */
export function classifyServerFrameCancel(
  result: CirceExecutionResult | null,
): MobileServerFrameCancelOutcome {
  if (result === null) return "failed";
  if (result.status === "acknowledged") return "cleared";
  if (result.status === "needs-input" && result.reason === "source-output-unavailable") {
    return "retired";
  }
  return "failed";
}

/**
 * Carry the sent frame id across a rejected answer. A needs-input response
 * that omits it (like the exact-frame rejection) must not drop the binding:
 * the next answer still carries the old frame so the Host keeps rejecting
 * instead of consuming it as fresh work.
 */
export function resolveRetainedFrameId(
  responseFrameId: string | undefined,
  sentFrameId: string | undefined,
): string | undefined {
  return responseFrameId ?? sentFrameId;
}

/** Narrow production shape for one mobile control execute: snapshot context plus identity. */
export type MobileCirceExecuteInput = {
  readonly kind: "control";
  readonly projectRef: CirceProjectRef;
  readonly utterance: string;
  readonly semanticProposal?: import("@t3tools/contracts").CirceSemanticProposal;
  readonly sourceUtterance?: string;
  readonly modelSelection?: ModelSelection;
  readonly contextThreadId?: ThreadId;
  readonly referenceThreadId?: ThreadId;
  readonly expectedReply?: CirceExpectedReply | null;
  readonly clarificationFrameId?: string;
  readonly requestMetadata: CirceRequestMetadata;
};

/**
 * Build the exact execute input the provider sends. Context comes from the
 * routed turn snapshot, never from fresh desk state, so a delayed retry
 * answers the same conversation the user started. The caller owns requestId
 * identity and must reuse it across retries of the same turn.
 */
export function buildMobileCirceExecuteInput(input: {
  readonly turn: MobileCirceTurn;
  readonly projectRef: CirceProjectRef;
  readonly utterance: string;
  readonly sourceUtterance?: string;
  readonly semanticProposal?: import("@t3tools/contracts").CirceSemanticProposal;
  readonly modelSelection?: ModelSelection;
  readonly clarificationFrameId?: string;
  readonly requestId: string;
}): MobileCirceExecuteInput {
  // One bounded copy of the utterance feeds the top-level source field when
  // a proposal travels with it: an unbounded copy would double a huge
  // payload that is logged and persisted server-side.
  const boundedSourceUtterance = input.sourceUtterance?.slice(0, 16_000);
  return {
    kind: "control",
    projectRef: input.projectRef,
    utterance: input.utterance,
    ...(input.semanticProposal === undefined ? {} : { semanticProposal: input.semanticProposal }),
    ...(input.semanticProposal === undefined || boundedSourceUtterance === undefined
      ? {}
      : { sourceUtterance: boundedSourceUtterance }),
    ...(input.turn.contextThreadId === undefined
      ? {}
      : { contextThreadId: input.turn.contextThreadId }),
    ...(input.turn.referenceThreadId === undefined
      ? {}
      : { referenceThreadId: input.turn.referenceThreadId }),
    ...(input.turn.expectedReply === undefined ? {} : { expectedReply: input.turn.expectedReply }),
    ...(input.clarificationFrameId === undefined
      ? {}
      : { clarificationFrameId: input.clarificationFrameId }),
    ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
    requestMetadata: {
      requestId: input.requestId,
      origin: { originInteractionId: input.turn.originInteractionId },
    },
  };
}
