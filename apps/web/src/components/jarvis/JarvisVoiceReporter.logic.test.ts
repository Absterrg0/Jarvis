import {
  JarvisSpeakerClaimInput,
  MessageId,
  ProjectId,
  ThreadId,
  type JarvisVoiceReport,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  companionReportStatus,
  canMountJarvisVoiceReporter,
  enqueueJarvisPresentation,
  isJarvisReportForIdentity,
  retryJarvisDelivery,
  speakerPriority,
  spokenReportText,
} from "./JarvisVoiceReporter.logic";

const decodeJarvisSpeakerClaim = Schema.decodeUnknownSync(JarvisSpeakerClaimInput);

const report: JarvisVoiceReport = {
  reportId: MessageId.make("message-1"),
  projectId: ProjectId.make("project-1"),
  threadId: ThreadId.make("thread-1"),
  kind: "completed",
  threadTitle: "Build the relay",
  providerName: "Codex",
  text: "Implemented **voice**.\n```ts\nsecret();\n```",
  createdAt: "2026-08-12T00:00:00.000Z",
};

describe("Jarvis voice reporting", () => {
  it("keeps reports on the originating Companion identity", () => {
    expect(isJarvisReportForIdentity(report, "browser-1")).toBe(true);
    expect(
      isJarvisReportForIdentity(
        { ...report, origin: { originInteractionId: "companion-1" } },
        "browser-1",
      ),
    ).toBe(false);
    expect(
      isJarvisReportForIdentity(
        { ...report, origin: { originInteractionId: "companion-1" } },
        "companion-1",
      ),
    ).toBe(true);
  });

  it("serializes overlapping batches and retries delivery until success", async () => {
    const order: string[] = [];
    let queue = Promise.resolve();
    queue = enqueueJarvisPresentation(queue, async () => {
      order.push("first:start");
      await Promise.resolve();
      order.push("first:end");
    });
    queue = enqueueJarvisPresentation(queue, async () => {
      order.push("second");
    });
    await queue;
    expect(order).toEqual(["first:start", "first:end", "second"]);

    let attempts = 0;
    const result = await retryJarvisDelivery({
      run: async () => (++attempts < 3 ? { _tag: "Failure" } : { _tag: "Success", value: 8 }),
      isActive: () => true,
      wait: async () => Promise.resolve(),
    });
    expect(result).toEqual({ status: "succeeded", value: 8, attempts: 3 });
    expect(attempts).toBe(3);
  });

  it("returns a retryable exhaustion after a bounded number of failures", async () => {
    let attempts = 0;
    const result = await retryJarvisDelivery({
      run: async () => {
        attempts += 1;
        return { _tag: "Failure" };
      },
      isActive: () => true,
      wait: async () => Promise.resolve(),
      maxAttempts: 3,
    });

    expect(result).toEqual({ status: "exhausted", attempts: 3 });
    expect(attempts).toBe(3);
  });

  it("releases the presentation queue after a report exhausts its retries", async () => {
    const order: string[] = [];
    let queue = Promise.resolve();
    queue = enqueueJarvisPresentation(queue, async () => {
      const result = await retryJarvisDelivery({
        run: async () => ({ _tag: "Failure" }),
        isActive: () => true,
        wait: async () => Promise.resolve(),
        maxAttempts: 2,
      });
      expect(result.status).toBe("exhausted");
      order.push("first:retryable");
    });
    queue = enqueueJarvisPresentation(queue, async () => {
      order.push("second:presented");
    });

    await queue;

    expect(order).toEqual(["first:retryable", "second:presented"]);
  });

  it("bounds polling by the delivery deadline even when attempts remain", async () => {
    let clock = 0;
    let attempts = 0;
    const result = await retryJarvisDelivery({
      run: async () => {
        attempts += 1;
        return { _tag: "Success", value: { granted: false, speechState: "leased" } };
      },
      accept: (claim) => claim.granted || claim.speechState === "already-spoken",
      isActive: () => true,
      wait: async () => {
        clock += 1_000;
      },
      maxAttempts: 10,
      maxDurationMs: 2_500,
      now: () => clock,
    });

    expect(result).toEqual({ status: "exhausted", attempts: 3 });
    expect(attempts).toBe(3);
  });

  it("bounds a never-settling run with the delivery deadline", async () => {
    vi.useFakeTimers();
    try {
      let receivedSignal: AbortSignal | undefined;
      const resultPromise = retryJarvisDelivery({
        run: (signal) => {
          receivedSignal = signal;
          return new Promise(() => undefined);
        },
        isActive: () => true,
        wait: () => Promise.resolve(),
        maxDurationMs: 1_000,
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(resultPromise).resolves.toEqual({ status: "exhausted", attempts: 1 });
      expect(receivedSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a never-settling wait with the delivery deadline", async () => {
    vi.useFakeTimers();
    try {
      let receivedSignal: AbortSignal | undefined;
      const resultPromise = retryJarvisDelivery({
        run: () => Promise.resolve({ _tag: "Failure" }),
        isActive: () => true,
        wait: (signal) => {
          receivedSignal = signal;
          return new Promise(() => undefined);
        },
        maxDurationMs: 1_000,
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(resultPromise).resolves.toEqual({ status: "exhausted", attempts: 1 });
      expect(receivedSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops delivery retries after unmount cancellation", async () => {
    let active = true;
    let attempts = 0;
    const result = await retryJarvisDelivery({
      run: async () => {
        attempts += 1;
        active = false;
        return { _tag: "Failure" };
      },
      isActive: () => active,
      wait: async () => Promise.resolve(),
    });
    expect(result).toEqual({ status: "cancelled", attempts: 1 });
    expect(attempts).toBe(1);
  });

  it("retries a rejected delivery while the reporter is active", async () => {
    let attempts = 0;
    const result = await retryJarvisDelivery({
      run: async () => {
        attempts += 1;
        if (attempts < 2) throw new Error("transport unavailable");
        return { _tag: "Success", value: 13 };
      },
      isActive: () => true,
      wait: async () => Promise.resolve(),
    });

    expect(result).toEqual({ status: "succeeded", value: 13, attempts: 2 });
    expect(attempts).toBe(2);
  });

  it("stops after a rejected delivery becomes inactive", async () => {
    let active = true;
    let attempts = 0;
    const result = await retryJarvisDelivery({
      run: async () => {
        attempts += 1;
        active = false;
        throw new Error("transport unavailable");
      },
      isActive: () => active,
      wait: async () => Promise.resolve(),
    });

    expect(result).toEqual({ status: "cancelled", attempts: 1 });
    expect(attempts).toBe(1);
  });

  it("mounts reporters only for authenticated operate sessions", () => {
    expect(canMountJarvisVoiceReporter(null)).toBe(false);
    expect(
      canMountJarvisVoiceReporter({ authenticated: true, scopes: ["orchestration:read"] }),
    ).toBe(false);
    expect(
      canMountJarvisVoiceReporter({ authenticated: false, scopes: ["orchestration:operate"] }),
    ).toBe(false);
    expect(
      canMountJarvisVoiceReporter({ authenticated: true, scopes: ["orchestration:operate"] }),
    ).toBe(true);
  });

  it("turns a verbose coding result into a short conversational briefing", () => {
    expect(spokenReportText(report)).toBe(
      "I've implemented voice. The code details are waiting in your workspace.",
    );
    expect(
      spokenReportText({ ...report, kind: "waiting-for-input", text: "Which database?" }),
    ).toBe("I need one quick detail. Which database?");
    expect(spokenReportText({ ...report, kind: "approval-needed", text: "Run tests" })).toBe(
      "Quick check before I continue. Run tests",
    );
    expect(spokenReportText({ ...report, kind: "failed", text: "Disconnected" })).toBe(
      "I hit a snag. Disconnected",
    );
  });

  it("uses the Host briefing instead of reinterpreting the raw provider answer", () => {
    const hostBriefing = {
      goal: "Review the admin revocation flow.",
      outcome: "I found one serious issue in the admin revocation flow.",
      findings: [],
      changeDetails: [],
      verification: ["Type-checking passed."],
      limitations: ["Lint could not run."],
      nextActions: ["Would you like me to fix it?"],
      spokenText:
        "I found one serious issue in the admin revocation flow. Type-checking passed. Lint could not run. Would you like me to fix it?",
    };
    const withBriefing = {
      ...report,
      text: "Unstructured provider prose.",
      briefing: hostBriefing,
    };

    expect(spokenReportText(withBriefing)).toBe(hostBriefing.spokenText);
    expect(companionReportStatus(withBriefing)).toMatchObject({ detail: hostBriefing.spokenText });
  });

  it("keeps the outcome and verification instead of reading a long changelog", () => {
    const verbose = [
      "Implemented explicit project targeting for the companion.",
      "",
      "- Added a persisted project picker with workspace paths.",
      "- Routed every new task through the selected project id.",
      "- Added stale-project recovery and clearer overlay context.",
      "- Updated the setup screen and tray behavior.",
      "",
      "Tests:",
      "- Focused companion tests and typecheck passed.",
    ].join("\n");

    expect(spokenReportText({ ...report, text: verbose })).toBe(
      "I've implemented explicit project targeting for the companion. Focused companion tests and typecheck passed.",
    );
  });

  it("ignores generic completion boilerplate and file-level implementation jargon", () => {
    const verbose = [
      "Done.",
      "",
      "Changed files:",
      "- `apps/server/src/jarvis/Layers/JarvisManager.ts` now dispatches the typed orchestration command.",
      "- Project questions are answered directly from the project catalog without starting Codex.",
      "",
      "Verification:",
      "- 20 focused tests passed.",
      "",
      "No migration is required.",
    ].join("\n");

    expect(spokenReportText({ ...report, text: verbose })).toBe(
      "Project questions now come directly from your project list without starting a coding agent. All 20 focused tests passed.",
    );
  });

  it("skips headings and separates outcome from verification on one line", () => {
    expect(
      spokenReportText({
        ...report,
        text: "## What changed\nImplemented explicit routing. Tests passed.\n1. Remaining caveat: the second task is untouched.",
      }),
    ).toBe(
      "I've implemented explicit routing. Tests passed. Remaining caveat: the second task is untouched.",
    );
  });

  it("presents an actionable companion state for answers, questions, approvals, and failures", () => {
    expect(companionReportStatus(report)).toEqual({
      state: "Finished — short version",
      detail: "I've implemented voice. The code details are waiting in your workspace.",
      kind: "completed",
    });
    expect(
      companionReportStatus({ ...report, kind: "waiting-for-input", text: "Which database?" }),
    ).toEqual({ state: "I need your input", detail: "Which database?", kind: "attention" });
    expect(
      companionReportStatus({ ...report, kind: "approval-needed", text: "Run tests" }),
    ).toEqual({ state: "One quick approval", detail: "Run tests", kind: "attention" });
    expect(companionReportStatus({ ...report, kind: "failed", text: "Disconnected" })).toEqual({
      state: "I hit a snag",
      detail: "Disconnected",
      kind: "error",
    });
  });

  it("always elects the paired report relay before every other surface", () => {
    expect(speakerPriority({ relay: true, preferred: true, mobile: false, electron: true })).toBe(
      200,
    );
    expect(speakerPriority({ preferred: true, mobile: true, electron: false })).toBe(100);
    expect(speakerPriority({ preferred: false, mobile: false, electron: true })).toBe(75);
    expect(speakerPriority({ preferred: false, mobile: false, electron: false })).toBe(60);
    expect(speakerPriority({ preferred: false, mobile: true, electron: false })).toBe(40);
  });

  it("sends the relay priority through the typed speaker-claim boundary", () => {
    const priority = speakerPriority({
      relay: true,
      preferred: false,
      mobile: false,
      electron: true,
    });

    expect(() =>
      decodeJarvisSpeakerClaim({
        reportId: "report-1",
        deviceId: "companion-1",
        priority,
      }),
    ).not.toThrow();
  });
});
