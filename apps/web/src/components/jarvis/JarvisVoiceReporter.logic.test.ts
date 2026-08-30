import {
  EnvironmentId,
  JarvisSpeakerClaimInput,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type JarvisVoiceReport,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  companionReportStatus,
  canMountJarvisVoiceReporter,
  effectiveJarvisVoiceReportBatch,
  enqueueJarvisPresentation,
  foldJarvisVoiceReportBatchWithPresentation,
  foldJarvisVoicePresentation,
  isJarvisReportForIdentity,
  isJarvisVoiceReadyEdge,
  removedJarvisReportIds,
  retryJarvisDelivery,
  speakerPriority,
  spokenReportText,
  truncationStatusIds,
} from "./JarvisVoiceReporter.logic";
import { speakReport } from "./JarvisVoiceReporter";

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
  it("wakes only on a desktop voice ready edge", () => {
    expect(isJarvisVoiceReadyEdge(undefined, "ready")).toBe(true);
    expect(isJarvisVoiceReadyEdge("ready", "ready")).toBe(false);
    expect(isJarvisVoiceReadyEdge("speaking", "ready")).toBe(true);
    expect(isJarvisVoiceReadyEdge("ready", "speaking")).toBe(false);
  });

  it("finds report IDs removed from the incoming presentation batch", () => {
    expect(
      removedJarvisReportIds(
        new Map([
          ["one", report],
          ["two", report],
        ]),
        new Map([["two", report]]),
      ),
    ).toEqual(["one"]);
  });

  it("folds same-batch removals after deliveries so removed reports are not presentable", () => {
    const folded = foldJarvisVoiceReportBatchWithPresentation(new Map(), {
      acknowledgedThrough: 0,
      batchThrough: 1,
      deliveries: [{ sequence: 1, report }],
      removedReportIds: [report.reportId],
      hasMore: false,
    });
    expect(folded.reports.has(report.reportId)).toBe(false);
    expect(folded.deliveries).toHaveLength(0);
    expect(folded.removedReportIds).toEqual([report.reportId]);
  });

  it("filters only work-started reports superseded by the same task and turn", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const turn = TurnId.make("turn-1");
    const workStarted = {
      ...report,
      reportId: "working-superseded",
      kind: "work-started" as const,
      turnId: turn,
    };
    const sameTaskTerminal = {
      ...report,
      reportId: "completed-same-task",
      turnId: turn,
    };
    const otherTurn = {
      ...workStarted,
      reportId: "working-other-turn",
      turnId: TurnId.make("turn-2"),
    };
    const otherTask = {
      ...workStarted,
      reportId: "working-other-task",
      threadId: ThreadId.make("thread-2"),
    };
    const otherNode = {
      ...workStarted,
      reportId: "working-other-node",
      taskRef: {
        executionNodeId: EnvironmentId.make("environment-2"),
        remoteTaskId: "remote-task",
        remoteThreadId: ThreadId.make("remote-thread"),
      },
    };
    const effective = effectiveJarvisVoiceReportBatch(
      new Map([[workStarted.reportId, workStarted]]),
      {
        environmentId,
        batch: {
          acknowledgedThrough: 0,
          batchThrough: 5,
          deliveries: [
            { sequence: 1, report: workStarted },
            { sequence: 2, report: otherTurn },
            { sequence: 3, report: otherTask },
            { sequence: 4, report: otherNode },
            { sequence: 5, report: sameTaskTerminal },
          ],
          removedReportIds: [],
          hasMore: false,
        },
      },
    );

    expect(effective.deliveries.map(({ report: delivered }) => delivered.reportId)).toEqual([
      otherTurn.reportId,
      otherTask.reportId,
      otherNode.reportId,
      sameTaskTerminal.reportId,
    ]);
    expect(effective.batchThrough).toBe(5);
    expect(effective.removedReportIds).toEqual([workStarted.reportId]);
  });

  it("does not present another identity's report or resurrect a settled replay", () => {
    const foreign = {
      ...report,
      reportId: "foreign-report",
      origin: { originInteractionId: "companion-b" },
    };
    const first = foldJarvisVoicePresentation(new Map(), {
      batch: {
        acknowledgedThrough: 0,
        batchThrough: 2,
        deliveries: [
          { sequence: 1, report },
          { sequence: 2, report: foreign },
        ],
        removedReportIds: [],
        hasMore: false,
      },
      identity: "companion-a",
      settledReportIds: new Set(),
    });
    expect(first.deliveries.map(({ report }) => report.reportId)).toEqual([report.reportId]);
    expect([...first.reports.keys()]).toEqual([report.reportId]);

    const replay = foldJarvisVoicePresentation(new Map(), {
      batch: {
        acknowledgedThrough: 2,
        batchThrough: 2,
        deliveries: [{ sequence: 1, report }],
        removedReportIds: [],
        hasMore: false,
      },
      identity: "companion-a",
      settledReportIds: new Set([report.reportId]),
    });
    expect(replay.deliveries).toHaveLength(0);
    expect(replay.reports.size).toBe(0);
  });

  it("collects stale Working status IDs for a truncation reset", () => {
    const workStarted = { ...report, reportId: "working-stale", kind: "work-started" as const };
    expect(
      truncationStatusIds({
        reports: new Map([[workStarted.reportId, workStarted]]),
        surfacedReportStatuses: new Map([[workStarted.reportId, "Working"]]),
        surfacedDeliveryStates: new Map([["__voice_delivery__", "degraded:busy"]]),
      }),
    ).toEqual([workStarted.reportId, "__voice_delivery__"]);
  });

  it("speaks provider work-started text verbatim while presenting Working", () => {
    const workStarted = {
      ...report,
      reportId: "jarvis-work-started:thread-1:turn-1",
      kind: "work-started" as const,
      turnId: TurnId.make("turn-1"),
      text: "The provider is checking the auth boundary.",
    };
    expect(spokenReportText(workStarted)).toBe(workStarted.text);
    expect(companionReportStatus(workStarted)).toEqual({
      state: "Working",
      detail: workStarted.text,
      kind: "attention",
    });
  });

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

  it("does not confirm a native report that was deliberately declined", async () => {
    const speak = vi.fn(async () => ({ status: "deferred", reason: "superseded" }));
    const fallback = vi.fn(async () => undefined);
    let storedReports: string | null = null;
    vi.stubGlobal("localStorage", {
      getItem: () => storedReports,
      setItem: (_key: string, value: string) => {
        storedReports = value;
      },
    });
    vi.stubGlobal("window", {
      desktopBridge: { jarvisVoice: { speak } },
      jarvisCompanion: { speak: fallback },
    });
    try {
      await expect(speakReport(EnvironmentId.make("environment-1"), report)).resolves.toEqual({
        status: "deferred",
        reason: "superseded",
      });
      await expect(speakReport(EnvironmentId.make("environment-1"), report)).resolves.toEqual({
        status: "deferred",
        reason: "superseded",
      });
      expect(speak).toHaveBeenCalledWith(expect.any(String), "report", undefined);
      expect(speak).toHaveBeenCalledTimes(2);
      expect(fallback).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("turns a native delivery rejection into a typed speech failure", async () => {
    const speak = vi.fn(async () => {
      throw new Error("worker disconnected");
    });
    vi.stubGlobal("window", { desktopBridge: { jarvisVoice: { speak } } });
    try {
      await expect(speakReport(EnvironmentId.make("environment-1"), report)).resolves.toEqual({
        status: "failed",
        code: "desktop-speech-failed",
      });
    } finally {
      vi.unstubAllGlobals();
    }
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

  it("formats a raw provider result without inferring an outcome", () => {
    expect(spokenReportText(report)).toBe(
      "Implemented voice. The code details are waiting in your workspace.",
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

  it("does not classify contradictory provider prose", () => {
    expect(
      spokenReportText({
        ...report,
        text: "Deployment passed. Deployment failed. Tests passed. Remaining blocker: credentials.",
      }),
    ).toBe("Deployment passed. Deployment failed. Tests passed. Remaining blocker: credentials.");
  });

  it("presents an actionable companion state for answers, questions, approvals, and failures", () => {
    expect(companionReportStatus(report)).toEqual({
      state: "Finished — short version",
      detail: "Implemented voice. The code details are waiting in your workspace.",
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
