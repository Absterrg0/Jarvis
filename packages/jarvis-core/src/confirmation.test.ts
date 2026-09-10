import { describe, expect, it } from "vite-plus/test";

import { EventId } from "@t3tools/contracts";
import {
  getPendingJarvisReplyState,
  isExpectedPendingReply,
  isExplicitSpokenApprovalAnswer,
  listPendingJarvisReplies,
  resolveSpokenApprovalDecision,
  resolveVoiceConfirmation,
} from "./confirmation.ts";

describe("spoken confirmation negation", () => {
  it.each([
    "do not allow it",
    "don't approve it",
    "don't proceed",
    "can't proceed",
    "don't use that",
    "never allow that",
    "cannot approve it",
  ])("declines a negated approval answer instead of consenting: %s", (utterance) => {
    expect(resolveSpokenApprovalDecision(utterance)).toBe("decline");
  });

  it.each([
    "that's not right",
    "don't proceed",
    "can't proceed",
    "don't use that",
    "no, not that one",
    "never mind",
  ])("declines a negated voice confirmation instead of accepting: %s", (utterance) => {
    expect(resolveVoiceConfirmation(utterance)).toBe("decline");
  });

  it.each(["yes, allow it", "allow it", "go ahead", "yes, approve it"])(
    "still accepts an unnegated confirmation: %s",
    (utterance) => {
      expect(resolveSpokenApprovalDecision(utterance)).toBe("accept");
    },
  );

  it.each([
    "should I approve it?",
    "shouldn't I approve it?",
    "allow it?",
    "maybe allow it",
    "allow it only if tests pass",
    "approve it if the build passes",
    "yes if tests pass",
    "do I allow it",
    "what should I approve",
  ])("leaves an ambiguous approval answer as clarification: %s", (utterance) => {
    expect(resolveSpokenApprovalDecision(utterance)).toBe("clarify");
  });
});

describe("explicit spoken approval verdicts", () => {
  it.each(["allow it", "Allow it", "yes", "yes, allow it", "approve", "go ahead", "do it"])(
    "accepts a bare verdict: %s",
    (utterance) => {
      expect(isExplicitSpokenApprovalAnswer(utterance)).toBe("accept");
    },
  );

  it.each(["no", "No thanks", "nope", "deny it", "Deny", "decline", "don't allow it"])(
    "declines a bare verdict: %s",
    (utterance) => {
      expect(isExplicitSpokenApprovalAnswer(utterance)).toBe("decline");
    },
  );

  it.each([
    "don't stop task",
    "do not start over",
    "should I approve it?",
    "allow it?",
    "maybe allow it",
    "allow it only if tests pass",
    "never mind",
    "stop that task",
    "what's the status?",
  ])("leaves anything beyond a bare verdict undecided: %s", (utterance) => {
    expect(isExplicitSpokenApprovalAnswer(utterance)).toBeUndefined();
  });
});

describe("pending reply identity", () => {
  const requested = (
    kind: "approval.requested" | "user-input.requested",
    requestId: string,
    extraPayload: Record<string, unknown> = {},
  ) =>
    ({
      id: EventId.make(`event-${kind}-${requestId}`),
      tone: "info",
      kind,
      summary: "requested",
      payload: {
        requestId,
        ...(kind === "user-input.requested" ? { questions: [{ id: "q1" }] } : {}),
        ...extraPayload,
      },
      turnId: null,
      createdAt: "2026-08-30T00:00:00.000Z",
    }) as never;

  const resolved = (kind: "approval.resolved" | "user-input.resolved", requestId: string) =>
    ({
      id: EventId.make(`event-${kind}-${requestId}`),
      tone: "info",
      kind,
      summary: "resolved",
      payload: { requestId },
      turnId: null,
      createdAt: "2026-08-30T00:00:01.000Z",
    }) as never;

  it("does not let an approval resolution close a worker-input request with the same id", () => {
    const activities = [
      requested("user-input.requested", "shared-1"),
      resolved("approval.resolved", "shared-1"),
    ];
    expect(listPendingJarvisReplies(activities)).toHaveLength(1);
    expect(getPendingJarvisReplyState(activities)).toMatchObject({
      status: "single",
      pending: { kind: "user-input", requestId: "shared-1" },
    });
  });

  it("treats a request-closed response failure as closing its request", () => {
    const activities = [
      requested("approval.requested", "approval-1"),
      {
        id: EventId.make("event-failed"),
        tone: "info",
        kind: "provider.approval.respond.failed",
        summary: "failed",
        payload: { requestId: "approval-1", failureReason: "request-closed" },
        turnId: null,
        createdAt: "2026-08-30T00:00:01.000Z",
      },
    ];
    expect(listPendingJarvisReplies(activities as never)).toHaveLength(0);
    expect(getPendingJarvisReplyState(activities as never)).toMatchObject({ status: "none" });
  });

  it("marks two distinct unresolved requests ambiguous instead of picking the latest", () => {
    const activities = [
      requested("approval.requested", "approval-1"),
      requested("user-input.requested", "input-1"),
    ];
    expect(listPendingJarvisReplies(activities)).toHaveLength(2);
    expect(getPendingJarvisReplyState(activities)).toMatchObject({ status: "ambiguous" });
  });

  it("rejects a closed request answered after a new request opened", () => {
    const activities = [
      requested("approval.requested", "request-a"),
      resolved("approval.resolved", "request-a"),
      requested("approval.requested", "request-b"),
    ];
    const state = getPendingJarvisReplyState(activities);
    expect(state).toMatchObject({
      status: "single",
      pending: { kind: "approval", requestId: "request-b" },
    });
    expect(isExpectedPendingReply(state, { kind: "approval", requestId: "request-a" })).toBe(false);
    expect(isExpectedPendingReply(state, { kind: "approval", requestId: "request-b" })).toBe(true);
    expect(isExpectedPendingReply(state, { kind: "input", requestId: "request-b" })).toBe(false);
    expect(
      isExpectedPendingReply({ status: "none" }, { kind: "approval", requestId: "request-b" }),
    ).toBe(false);
  });
});
