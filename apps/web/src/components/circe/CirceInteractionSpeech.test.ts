import { describe, expect, it, vi, beforeEach } from "vite-plus/test";
import { EnvironmentId, ThreadId, TurnId } from "@t3tools/contracts";

import { createCirceInteractionSpeech, matchesCirceSpeechTerminal } from "./CirceInteractionSpeech";
import {
  circeSpeechThreadKey,
  noteCirceSpeechTerminal,
  resetCirceSpeechRelevanceForTests,
} from "./CirceVoiceReporter.logic";

const threadId = ThreadId.make("thread-voice");
const taskRef = {
  executionNodeId: EnvironmentId.make("node-execution"),
  threadId,
} as never;

function turnIdentity(turn: string, requestId?: string) {
  return {
    threadKey: circeSpeechThreadKey({ taskRef, threadId }),
    taskRef,
    threadId,
    turnId: TurnId.make(turn),
    ...(requestId === undefined ? {} : { requestId }),
  };
}

describe("Circe interaction speech ownership", () => {
  beforeEach(() => {
    resetCirceSpeechRelevanceForTests();
  });
  it("retains the delivery identity it speaks", () => {
    const sink = { speak: vi.fn(), cancel: vi.fn() };
    const speech = createCirceInteractionSpeech(sink);
    speech.speak("Which effort?");
    expect(sink.speak).toHaveBeenCalledTimes(1);
    expect(speech.currentDeliveryId()).toBe(sink.speak.mock.calls[0]?.[1]);
  });

  it("supersedes the previous utterance before speaking the next", () => {
    const sink = { speak: vi.fn(), cancel: vi.fn() };
    const speech = createCirceInteractionSpeech(sink);
    speech.speak("First.");
    const first = sink.speak.mock.calls[0]?.[1] as string;
    speech.speak("Second.");
    expect(sink.cancel).toHaveBeenCalledWith(first);
    expect(sink.speak).toHaveBeenCalledTimes(2);
    expect(speech.currentDeliveryId()).toBe(sink.speak.mock.calls[1]?.[1]);
    expect(speech.currentDeliveryId()).not.toBe(first);
  });

  it("cancels the current utterance and stays silent afterwards", () => {
    const sink = { speak: vi.fn(), cancel: vi.fn() };
    const speech = createCirceInteractionSpeech(sink);
    speech.speak("Which effort?");
    const deliveryId = speech.currentDeliveryId() as string;
    speech.cancel();
    expect(sink.cancel).toHaveBeenCalledWith(deliveryId);
    expect(speech.currentDeliveryId()).toBeNull();
    speech.cancel();
    expect(sink.cancel).toHaveBeenCalledTimes(1);
  });

  it("ignores empty text without touching the lane", () => {
    const sink = { speak: vi.fn(), cancel: vi.fn() };
    const speech = createCirceInteractionSpeech(sink);
    speech.speak("   ");
    expect(sink.speak).not.toHaveBeenCalled();
    expect(speech.currentDeliveryId()).toBeNull();
  });

  it("keeps speaking normally after a cancel", () => {
    const sink = { speak: vi.fn(), cancel: vi.fn() };
    const speech = createCirceInteractionSpeech(sink);
    speech.speak("First.");
    speech.cancel();
    speech.speak("Second.");
    expect(sink.speak).toHaveBeenCalledTimes(2);
    expect(speech.currentDeliveryId()).toBe(sink.speak.mock.calls[1]?.[1]);
  });

  it("drops a delayed ack once its turn terminal arrived first", () => {
    const sink = { speak: vi.fn(), cancel: vi.fn() };
    const speech = createCirceInteractionSpeech(sink);
    noteCirceSpeechTerminal({ threadId, taskRef, turnId: TurnId.make("turn-1") });
    speech.speak("Taking a look.", turnIdentity("turn-1", "request-1"));
    expect(sink.speak).not.toHaveBeenCalled();
    expect(speech.currentDeliveryId()).toBeNull();
  });

  it("speaks a later legitimate turn after its task terminal", () => {
    const sink = { speak: vi.fn(), cancel: vi.fn() };
    const speech = createCirceInteractionSpeech(sink);
    noteCirceSpeechTerminal({ threadId, taskRef, turnId: TurnId.make("turn-1") });
    speech.speak("On the follow-up.", turnIdentity("turn-2", "request-2"));
    expect(sink.speak).toHaveBeenCalledTimes(1);
  });

  it("retracts the live ack when its turn terminal lands mid-playback", () => {
    const sink = { speak: vi.fn(), cancel: vi.fn() };
    const speech = createCirceInteractionSpeech(sink);
    speech.speak("Taking a look.", turnIdentity("turn-1", "request-1"));
    const live = speech.currentDeliveryId() as string;
    expect(sink.speak).toHaveBeenCalledTimes(1);
    for (const deliveryId of noteCirceSpeechTerminal({
      threadId,
      taskRef,
      turnId: TurnId.make("turn-1"),
    })) {
      sink.cancel(deliveryId);
    }
    expect(sink.cancel).toHaveBeenCalledWith(live);
    speech.cancel();
    expect(speech.currentDeliveryId()).toBeNull();
  });

  it("matches a terminal only to its own turn on its own thread", () => {
    const turn1 = TurnId.make("turn-1");
    const identity = { taskRef, threadId, turnId: turn1, requestId: "request-1" };
    expect(matchesCirceSpeechTerminal(identity, { threadId, taskRef, turnId: turn1 })).toBe(true);
    expect(
      matchesCirceSpeechTerminal(identity, { threadId, taskRef, turnId: TurnId.make("turn-2") }),
    ).toBe(false);
    expect(
      matchesCirceSpeechTerminal(identity, {
        threadId: ThreadId.make("other-thread"),
        taskRef: {
          executionNodeId: EnvironmentId.make("node-execution"),
          threadId: ThreadId.make("other-thread"),
        } as never,
        turnId: turn1,
      }),
    ).toBe(false);
    expect(
      matchesCirceSpeechTerminal(identity, {
        threadId,
        taskRef: {
          executionNodeId: EnvironmentId.make("node-other"),
          threadId,
        } as never,
        turnId: turn1,
      }),
    ).toBe(false);
    expect(matchesCirceSpeechTerminal({ requestId: "request-1" }, { turnId: turn1 })).toBe(false);
    expect(matchesCirceSpeechTerminal(identity, { threadId, taskRef })).toBe(false);
  });

  it("matches a terminal by scoped requestId without cross-speaking", () => {
    const requestIdentity = { taskRef, threadId, requestId: "request-1" };
    expect(
      matchesCirceSpeechTerminal(requestIdentity, { threadId, taskRef, requestId: "request-1" }),
    ).toBe(true);
    expect(
      matchesCirceSpeechTerminal(requestIdentity, { threadId, taskRef, requestId: "request-2" }),
    ).toBe(false);
    expect(
      matchesCirceSpeechTerminal(requestIdentity, {
        threadId: ThreadId.make("other-thread"),
        taskRef: {
          executionNodeId: EnvironmentId.make("node-execution"),
          threadId: ThreadId.make("other-thread"),
        } as never,
        requestId: "request-1",
      }),
    ).toBe(false);
  });
});
