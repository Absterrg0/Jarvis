import { EnvironmentId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createMobileSpeechGate,
  mobileSpeechThreadKey,
  type MobileSpeechRequest,
} from "./mobileSpeechGate";

const voiceNode = EnvironmentId.make("voice-node");
const executionNode = EnvironmentId.make("node-A");
const otherNode = EnvironmentId.make("node-B");

function turnId(id: string): TurnId {
  return TurnId.make(id);
}

function request(
  speechKey: string,
  threadKey: string,
  text = "Update.",
  extra?: Pick<MobileSpeechRequest, "turnId" | "requestId" | "originInteractionId" | "terminal">,
): MobileSpeechRequest {
  return { text, nodeId: voiceNode, speechKey, threadKey, ...extra };
}

function thread(threadId: string): string {
  return mobileSpeechThreadKey(executionNode, ThreadId.make(threadId));
}

describe("mobile speech gate", () => {
  it("keys task speech by its real execution node and thread", () => {
    expect(mobileSpeechThreadKey(executionNode, ThreadId.make("thread-A"))).toBe(
      `${executionNode}:thread-A`,
    );
  });

  it("rejects an exact re-delivery of a presentation id", () => {
    const gate = createMobileSpeechGate();
    const first = request("presentation-1", thread("thread-A"));
    expect(gate.arrive(first)).toBe(true);
    expect(gate.isStale(first)).toBe(false);
    expect(gate.arrive(request("presentation-1", thread("thread-A"), "Update."))).toBe(false);
  });

  it("retires a queued ack when its thread's terminal arrives", () => {
    const gate = createMobileSpeechGate();
    const ack = request("request-1:started", thread("thread-A"), "Taking a look.");
    const terminal = request("presentation-9", thread("thread-A"), "Done.");
    expect(gate.arrive(ack)).toBe(true);
    expect(gate.arrive(terminal)).toBe(true);
    expect(gate.isStale(ack)).toBe(true);
    expect(gate.isStale(terminal)).toBe(false);
  });

  it("lets a newer answer replace a clarification prompt on the same thread", () => {
    const gate = createMobileSpeechGate();
    const prompt = request("request-1:needs-input", thread("thread-A"), "Which one?");
    const answer = request("request-2:needs-input", thread("thread-A"), "Still which one?");
    expect(gate.arrive(prompt)).toBe(true);
    expect(gate.arrive(answer)).toBe(true);
    expect(gate.isStale(prompt)).toBe(true);
    expect(gate.isStale(answer)).toBe(false);
  });

  it("keeps an unrelated thread playing while another thread turns over", () => {
    const gate = createMobileSpeechGate();
    const other = request("presentation-2", mobileSpeechThreadKey(otherNode, ThreadId.make("t")));
    const first = request("presentation-1", thread("thread-A"));
    expect(gate.arrive(first)).toBe(true);
    expect(gate.arrive(other)).toBe(true);
    expect(gate.arrive(request("presentation-3", thread("thread-A")))).toBe(true);
    expect(gate.isStale(first)).toBe(true);
    expect(gate.isStale(other)).toBe(false);
  });

  it("supersedes untargeted speech when newer input arrives", () => {
    const gate = createMobileSpeechGate();
    const first = request("converse-1", "");
    const second = request("converse-2", "");
    expect(gate.arrive(first)).toBe(true);
    expect(gate.arrive(second)).toBe(true);
    expect(gate.isStale(first)).toBe(true);
    expect(gate.isStale(second)).toBe(false);
  });

  it("retires a delayed ack when its turn terminal arrived first", () => {
    const gate = createMobileSpeechGate();
    const terminal = request("presentation-9", thread("thread-A"), "Done.", {
      turnId: turnId("turn-1"),
      terminal: true,
    });
    const ack = request("request-1:started", thread("thread-A"), "Taking a look.", {
      turnId: turnId("turn-1"),
      requestId: "request-1",
    });
    expect(gate.arrive(terminal)).toBe(true);
    expect(gate.arrive(ack)).toBe(true);
    expect(gate.isStale(terminal)).toBe(false);
    expect(gate.isStale(ack)).toBe(true);
  });

  it("retires a queued ack when its turn terminal arrives after it", () => {
    const gate = createMobileSpeechGate();
    const ack = request("request-1:started", thread("thread-A"), "Taking a look.", {
      turnId: turnId("turn-1"),
      requestId: "request-1",
    });
    const terminal = request("presentation-9", thread("thread-A"), "Done.", {
      turnId: turnId("turn-1"),
      terminal: true,
    });
    expect(gate.arrive(ack)).toBe(true);
    expect(gate.arrive(terminal)).toBe(true);
    expect(gate.isStale(ack)).toBe(true);
    expect(gate.isStale(terminal)).toBe(false);
  });

  it("matches same-turn speech even when origins differ", () => {
    const gate = createMobileSpeechGate();
    const terminal = request("presentation-9", thread("thread-A"), "Done.", {
      turnId: turnId("turn-1"),
      originInteractionId: "origin-old",
      terminal: true,
    });
    const ack = request("request-1:started", thread("thread-A"), "Taking a look.", {
      turnId: turnId("turn-1"),
      originInteractionId: "origin-new",
      requestId: "request-1",
    });
    expect(gate.arrive(terminal)).toBe(true);
    expect(gate.arrive(ack)).toBe(true);
    expect(gate.isStale(ack)).toBe(true);
    expect(gate.isStale(terminal)).toBe(false);
  });

  it("allows a later legitimate turn on the same task after its terminal", () => {
    const gate = createMobileSpeechGate();
    const terminal = request("presentation-9", thread("thread-A"), "Done.", {
      turnId: turnId("turn-1"),
      terminal: true,
    });
    const nextAck = request("request-2:started", thread("thread-A"), "On the follow-up.", {
      turnId: turnId("turn-2"),
      requestId: "request-2",
    });
    expect(gate.arrive(terminal)).toBe(true);
    expect(gate.arrive(nextAck)).toBe(true);
    expect(gate.isStale(terminal)).toBe(false);
    expect(gate.isStale(nextAck)).toBe(false);
  });

  it("allows a later legitimate turn sharing one originInteractionId", () => {
    const gate = createMobileSpeechGate();
    const terminal = request("presentation-9", thread("thread-A"), "Done.", {
      turnId: turnId("turn-1"),
      originInteractionId: "origin-shared",
      terminal: true,
    });
    const nextAck = request("request-2:started", thread("thread-A"), "On the follow-up.", {
      turnId: turnId("turn-2"),
      originInteractionId: "origin-shared",
      requestId: "request-2",
    });
    expect(gate.arrive(terminal)).toBe(true);
    expect(gate.arrive(nextAck)).toBe(true);
    expect(gate.isStale(terminal)).toBe(false);
    expect(gate.isStale(nextAck)).toBe(false);
  });

  it("links a turn-less queued prompt to its turn through the shared request", () => {
    const gate = createMobileSpeechGate();
    const prompt = request("request-1:needs-input", thread("thread-A"), "Which one?", {
      requestId: "request-1",
    });
    const started = request("request-1:started", thread("thread-A"), "Taking a look.", {
      turnId: turnId("turn-1"),
      requestId: "request-1",
    });
    const terminal = request("presentation-9", thread("thread-A"), "Done.", {
      turnId: turnId("turn-1"),
      terminal: true,
    });
    expect(gate.arrive(prompt)).toBe(true);
    expect(gate.arrive(started)).toBe(true);
    expect(gate.arrive(terminal)).toBe(true);
    expect(gate.isStale(prompt)).toBe(true);
    expect(gate.isStale(started)).toBe(true);
    expect(gate.isStale(terminal)).toBe(false);
  });

  it("vetoes a delayed ack by scoped requestId when its terminal arrived first", () => {
    const gate = createMobileSpeechGate();
    const terminal = request("presentation-9", thread("thread-A"), "Done.", {
      requestId: "request-1",
      terminal: true,
    });
    const ack = request("request-1:started", thread("thread-A"), "Taking a look.", {
      requestId: "request-1",
    });
    expect(gate.arrive(terminal)).toBe(true);
    expect(gate.arrive(ack)).toBe(true);
    expect(gate.isStale(ack)).toBe(true);
    expect(gate.isStale(terminal)).toBe(false);
  });

  it("keeps a later unrelated origin on the same task speakable", () => {
    const gate = createMobileSpeechGate();
    const terminal = request("presentation-9", thread("thread-A"), "Done.", {
      requestId: "request-1",
      terminal: true,
    });
    const unrelated = request("request-2:started", thread("thread-A"), "On the follow-up.", {
      requestId: "request-2",
    });
    expect(gate.arrive(terminal)).toBe(true);
    expect(gate.arrive(unrelated)).toBe(true);
    expect(gate.isStale(unrelated)).toBe(false);
  });

  it("scopes a request terminal to its own thread", () => {
    const gate = createMobileSpeechGate();
    const terminal = request("presentation-9", thread("thread-A"), "Done.", {
      requestId: "request-shared",
      terminal: true,
    });
    const otherThreadAck = request(
      "request-shared:started",
      mobileSpeechThreadKey(otherNode, ThreadId.make("t")),
      "Other.",
      {
        requestId: "request-shared",
      },
    );
    expect(gate.arrive(terminal)).toBe(true);
    expect(gate.arrive(otherThreadAck)).toBe(true);
    expect(gate.isStale(otherThreadAck)).toBe(false);
  });

  it("keeps exact-duplicate memory across a full stop but clears thread relevance", () => {
    const gate = createMobileSpeechGate();
    const played = request("presentation-1", thread("thread-A"));
    expect(gate.arrive(played)).toBe(true);
    gate.reset();
    expect(gate.arrive(request("presentation-1", thread("thread-A")))).toBe(false);
    const fresh = request("presentation-2", thread("thread-A"));
    expect(gate.arrive(fresh)).toBe(true);
    expect(gate.isStale(fresh)).toBe(false);
  });
});
