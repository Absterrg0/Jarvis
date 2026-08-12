import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolvePendingReply } from "./resolvePendingReply.ts";

const activity = (kind: string, payload: unknown, id: string): OrchestrationThreadActivity => ({
  id: EventId.make(id),
  tone: "info",
  kind,
  summary: kind,
  payload,
  turnId: null,
  createdAt: "2026-08-12T00:00:00.000Z",
});

describe("resolvePendingReply", () => {
  it("returns the latest unresolved structured question", () => {
    expect(
      resolvePendingReply([
        activity(
          "user-input.requested",
          { requestId: "request-1", questions: [{ id: "continue" }] },
          "event-1",
        ),
      ]),
    ).toEqual({ kind: "user-input", requestId: "request-1", questionIds: ["continue"] });
  });

  it("ignores requests that have already been resolved", () => {
    expect(
      resolvePendingReply([
        activity("approval.requested", { requestId: "request-1" }, "event-1"),
        activity("approval.resolved", { requestId: "request-1" }, "event-2"),
      ]),
    ).toBeNull();
  });
});
