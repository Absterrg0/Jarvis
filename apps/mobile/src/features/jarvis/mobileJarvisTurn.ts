import type {
  EnvironmentId,
  JarvisExecutionResult,
  JarvisExpectedReply,
  JarvisProjectRef,
  JarvisRequestMetadata,
  JarvisTaskPendingReply,
  JarvisTaskRef,
  ModelSelection,
  ThreadId,
} from "@t3tools/contracts";
import {
  buildJarvisClientCommandContext,
  resolveJarvisLiveContextTask,
  type JarvisClientContextTask,
} from "@t3tools/jarvis-client-runtime/jarvis/commandContext";
import { sameProjectRef } from "./mobileJarvisSelection";

type MobileJarvisDraftBase = {
  readonly originInteractionId: string;
};

/** A mobile instruction before Jarvis grounds its execution project. */
export type MobileJarvisDraft = MobileJarvisDraftBase &
  (
    | {
        readonly voiceNodeId?: undefined;
        readonly inputMode: "text";
        readonly speechEnabled: false;
      }
    | {
        readonly voiceNodeId: EnvironmentId;
        readonly inputMode: "voice";
        readonly speechEnabled: true;
      }
  );

/** Ephemeral routed context for one mobile-origin interaction. T3 owns durable task state. */
export type MobileJarvisTurn = MobileJarvisDraft & {
  readonly projectRef: JarvisProjectRef;
  readonly taskRef?: JarvisTaskRef;
  readonly contextThreadId?: ThreadId;
  readonly referenceThreadId?: ThreadId;
  readonly expectedReply?: JarvisExpectedReply | null;
};

export function createMobileJarvisTurn(input: {
  readonly originInteractionId: string;
  readonly inputMode: "text";
}): MobileJarvisDraft {
  return { ...input, speechEnabled: false };
}

export function createMobileJarvisVoiceTurn(input: {
  readonly originInteractionId: string;
  readonly voiceNodeId: EnvironmentId;
}): MobileJarvisDraft {
  return { ...input, inputMode: "voice", speechEnabled: true };
}

export function routeMobileJarvisTurn(
  draft: MobileJarvisDraft,
  projectRef: JarvisProjectRef,
  task?: {
    readonly threadId: ThreadId;
    readonly taskRef?: JarvisTaskRef;
    readonly projectRef?: JarvisProjectRef;
    readonly pendingReply?: JarvisTaskPendingReply | null;
  } | null,
): MobileJarvisTurn {
  const context = buildJarvisClientCommandContext({
    projectRef,
    ...(task === undefined || task === null ? {} : { task }),
  });
  return { ...draft, projectRef, ...context };
}

export function attachMobileJarvisTask(
  turn: MobileJarvisTurn,
  taskRef: JarvisTaskRef | undefined,
): MobileJarvisTurn {
  return taskRef === undefined ? turn : { ...turn, taskRef };
}

export type MobileJarvisDeskTaskIdentity = {
  readonly threadId: ThreadId;
  readonly taskRef?: JarvisTaskRef;
  readonly projectRef?: JarvisProjectRef;
  readonly pendingReply?: JarvisTaskPendingReply | null;
};

/**
 * Merge a retained explicit focus with live desk identity through the shared
 * client policy: the desk may only enrich the SAME thread by supplying its
 * pending-request pin and never selects another task. Unknown desk state
 * leaves the retained identity alone.
 */
export function resolveMobileFocusContextTask(input: {
  readonly retained: JarvisClientContextTask | null | undefined;
  readonly deskTasks: ReadonlyArray<MobileJarvisDeskTaskIdentity>;
}): (JarvisClientContextTask & { readonly pendingReply?: JarvisTaskPendingReply | null }) | null {
  const resolved = resolveJarvisLiveContextTask({
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
  readonly retained: JarvisClientContextTask | null | undefined;
  readonly deskFocusedTask: MobileJarvisDeskTaskIdentity | null;
  readonly deskNodeId: EnvironmentId | null;
  readonly selectedDeskNodeId: EnvironmentId | null;
  readonly selectedProjectRef?: JarvisProjectRef;
  readonly preferredProjectRef?: JarvisProjectRef;
}): JarvisClientContextTask | null | undefined {
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
  result: JarvisExecutionResult | null,
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
export type MobileJarvisExecuteInput = {
  readonly kind: "control";
  readonly projectRef: JarvisProjectRef;
  readonly utterance: string;
  readonly modelSelection?: ModelSelection;
  readonly contextThreadId?: ThreadId;
  readonly referenceThreadId?: ThreadId;
  readonly expectedReply?: JarvisExpectedReply | null;
  readonly clarificationFrameId?: string;
  readonly requestMetadata: JarvisRequestMetadata;
};

/**
 * Build the exact execute input the provider sends. Context comes from the
 * routed turn snapshot, never from fresh desk state, so a delayed retry
 * answers the same conversation the user started. The caller owns requestId
 * identity and must reuse it across retries of the same turn.
 */
export function buildMobileJarvisExecuteInput(input: {
  readonly turn: MobileJarvisTurn;
  readonly projectRef: JarvisProjectRef;
  readonly utterance: string;
  readonly sourceUtterance?: string;
  readonly modelSelection?: ModelSelection;
  readonly clarificationFrameId?: string;
  readonly requestId: string;
}): MobileJarvisExecuteInput {
  return {
    kind: "control",
    projectRef: input.projectRef,
    utterance: input.utterance,
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
      ...(input.turn.inputMode === "voice"
        ? {
            inputMode: "voice" as const,
            ...(input.sourceUtterance === undefined
              ? {}
              : { sourceUtterance: input.sourceUtterance }),
          }
        : {}),
    },
  };
}
