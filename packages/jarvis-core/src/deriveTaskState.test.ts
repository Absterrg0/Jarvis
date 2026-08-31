import { ThreadId, type OrchestrationSessionStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveJarvisTaskState, hasActiveJarvisTurn } from "./deriveTaskState.ts";

describe("deriveJarvisTaskState", () => {
  const session = (status: OrchestrationSessionStatus) => ({
    threadId: ThreadId.make("thread-task-state"),
    status,
    providerName: null,
    runtimeMode: "full-access" as const,
    activeTurnId: null,
    lastError: null,
    updatedAt: "2026-08-31T00:00:00.000Z",
  });
  const idle = {
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    latestTurn: null,
    session: null,
  } as const;

  it("uses one precedence order for pending, terminal, ready, and active states", () => {
    expect(deriveJarvisTaskState({ ...idle, hasPendingApprovals: true })).toBe(
      "waiting-for-approval",
    );
    expect(deriveJarvisTaskState({ ...idle, hasPendingUserInput: true })).toBe("waiting-for-input");
    expect(
      deriveJarvisTaskState({
        ...idle,
        session: session("error"),
      }),
    ).toBe("failed");
    expect(
      deriveJarvisTaskState({
        ...idle,
        session: session("interrupted"),
      }),
    ).toBe("interrupted");
    expect(
      deriveJarvisTaskState({
        ...idle,
        session: session("ready"),
      }),
    ).toBe("ready");
    expect(deriveJarvisTaskState(idle)).toBe("ready");
    expect(
      deriveJarvisTaskState({
        ...idle,
        session: session("running"),
      }),
    ).toBe("running");
    expect(
      deriveJarvisTaskState({
        ...idle,
        hasPendingApprovals: true,
        session: session("running"),
      }),
    ).toBe("waiting-for-approval");
    expect(
      hasActiveJarvisTurn({
        ...idle,
        hasPendingApprovals: true,
        session: session("running"),
      }),
    ).toBe(true);
  });
});
