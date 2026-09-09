import type { JarvisTaskRef, ThreadId, TurnId } from "@t3tools/contracts";

import {
  isJarvisSpeechRequestStale,
  noteJarvisSpeechRequestTurn,
  registerJarvisInteractionSpeech,
  unregisterJarvisInteractionSpeech,
} from "./JarvisVoiceReporter.logic";

export interface JarvisInteractionSpeechSink {
  readonly speak: (text: string, deliveryId: string) => void;
  readonly cancel: (deliveryId: string) => void;
}

/**
 * Turn identity for one interaction utterance. Thread plus turnId is the
 * primary key shared with the report lane; requestId links pre-accept
 * prompts to their accepted turn. Absent identity keeps the legacy
 * latest-wins behavior: speaking supersedes the previous utterance.
 * Identity without a turn or request (converse, route prompts) never
 * matches a terminal and is only retracted by new input.
 */
export interface JarvisInteractionSpeechIdentity {
  readonly threadKey?: string;
  readonly taskRef?: JarvisTaskRef;
  readonly threadId?: ThreadId;
  readonly turnId?: TurnId;
  readonly requestId?: string;
}

export interface JarvisSpeechTerminalNotice {
  readonly threadKey?: string;
  readonly taskRef?: JarvisTaskRef;
  readonly threadId?: ThreadId;
  readonly turnId?: TurnId;
  readonly requestId?: string;
}

function sameSpeechThread(
  identity: Pick<JarvisInteractionSpeechIdentity, "threadKey" | "taskRef" | "threadId">,
  notice: Pick<JarvisSpeechTerminalNotice, "threadKey" | "taskRef" | "threadId">,
): boolean {
  const identityNode = identity.taskRef?.executionNodeId;
  const noticeNode = notice.taskRef?.executionNodeId;
  if (identityNode !== undefined && noticeNode !== undefined && identityNode !== noticeNode) {
    return false;
  }
  if (identity.threadId !== undefined && notice.threadId !== undefined) {
    return identity.threadId === notice.threadId;
  }
  if (identity.threadKey !== undefined && notice.threadKey !== undefined) {
    return identity.threadKey === notice.threadKey;
  }
  return false;
}

/**
 * Exact same-turn match for terminal retraction. A terminal cancels only
 * the utterance of its own turn on its own thread; any other task or turn
 * never matches, and thread-unknown pairs never match. No wording, verb,
 * or delivery-id comparison here.
 */
export function matchesJarvisSpeechTerminal(
  identity: Pick<
    JarvisInteractionSpeechIdentity,
    "threadKey" | "taskRef" | "threadId" | "turnId" | "requestId"
  >,
  notice: Pick<
    JarvisSpeechTerminalNotice,
    "threadKey" | "taskRef" | "threadId" | "turnId" | "requestId"
  >,
): boolean {
  if (identity.turnId !== undefined && notice.turnId !== undefined) {
    return identity.turnId === notice.turnId && sameSpeechThread(identity, notice);
  }
  if (
    identity.requestId !== undefined &&
    notice.requestId !== undefined &&
    identity.requestId === notice.requestId
  ) {
    return sameSpeechThread(identity, notice);
  }
  return false;
}

/**
 * Owns one live interaction utterance on the shared browser speech lane.
 * Speaking supersedes the previous utterance, and cancel retracts whatever
 * is current — audible or still queued — by its retained delivery identity.
 * A terminal outranks its own turn's delayed ack either order: speak drops
 * an ack whose turn already finished, and the report lane retracts a live
 * ack for the finishing turn through the shared registry. Later turns stay
 * speakable. Empty text never touches the lane.
 */
export function createJarvisInteractionSpeech(sink: JarvisInteractionSpeechSink): {
  readonly speak: (text: string, identity?: JarvisInteractionSpeechIdentity) => void;
  readonly cancel: () => void;
  readonly cancelMatching: (notice: JarvisSpeechTerminalNotice) => boolean;
  readonly currentDeliveryId: () => string | null;
} {
  let current: string | null = null;
  let currentIdentity: JarvisInteractionSpeechIdentity | null = null;
  let counter = 0;
  const instancePrefix = Math.random().toString(36).slice(2);
  return {
    speak: (text: string, identity?: JarvisInteractionSpeechIdentity) => {
      if (text.trim().length === 0) return;
      if (
        identity !== undefined &&
        (identity.turnId !== undefined || identity.requestId !== undefined) &&
        isJarvisSpeechRequestStale(identity)
      ) {
        return;
      }
      if (
        identity?.requestId !== undefined &&
        identity.turnId !== undefined &&
        identity.threadId !== undefined
      ) {
        noteJarvisSpeechRequestTurn(identity.requestId, {
          ...(identity.taskRef === undefined ? {} : { taskRef: identity.taskRef }),
          threadId: identity.threadId,
          turnId: identity.turnId,
        });
      }
      if (current !== null) {
        sink.cancel(current);
        unregisterJarvisInteractionSpeech(current);
        current = null;
        currentIdentity = null;
      }
      counter += 1;
      const deliveryId = `jarvis-interaction-${instancePrefix}-${counter}`;
      current = deliveryId;
      currentIdentity = identity ?? null;
      if (
        identity !== undefined &&
        (identity.threadKey !== undefined ||
          identity.threadId !== undefined ||
          identity.requestId !== undefined)
      ) {
        registerJarvisInteractionSpeech(deliveryId, identity);
      }
      sink.speak(text, deliveryId);
    },
    cancel: () => {
      if (current === null) return;
      const deliveryId = current;
      current = null;
      currentIdentity = null;
      unregisterJarvisInteractionSpeech(deliveryId);
      sink.cancel(deliveryId);
    },
    cancelMatching: (notice: JarvisSpeechTerminalNotice) => {
      if (current === null || currentIdentity === null) return false;
      if (!matchesJarvisSpeechTerminal(currentIdentity, notice)) return false;
      const deliveryId = current;
      current = null;
      currentIdentity = null;
      unregisterJarvisInteractionSpeech(deliveryId);
      sink.cancel(deliveryId);
      return true;
    },
    currentDeliveryId: () => current,
  };
}

export type JarvisInteractionSpeech = ReturnType<typeof createJarvisInteractionSpeech>;
