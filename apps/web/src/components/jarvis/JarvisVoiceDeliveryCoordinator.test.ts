import { describe, expect, it, vi } from "vite-plus/test";

import type { JarvisVoiceReport, JarvisVoiceReportBatch } from "@t3tools/contracts";
import {
  createJarvisVoiceDeliveryCoordinator,
  type JarvisVoiceCommandResult,
  type JarvisVoiceDeliveryEvent,
  type JarvisVoiceDeliveryCoordinatorPorts,
  type JarvisVoiceSpeechOutcome,
} from "./JarvisVoiceDeliveryCoordinator";

const report = (reportId: string): JarvisVoiceReport => ({
  reportId,
  projectId: "project-1" as JarvisVoiceReport["projectId"],
  threadId: "thread-1" as JarvisVoiceReport["threadId"],
  kind: "completed",
  threadTitle: "Test",
  providerName: "Codex",
  text: `Report ${reportId}`,
  createdAt: "2026-01-01T00:00:00.000Z",
});

const batch = (...ids: string[]): JarvisVoiceReportBatch => ({
  acknowledgedThrough: 0,
  batchThrough: ids.length,
  deliveries: ids.map((reportId, index) => ({ sequence: index + 1, report: report(reportId) })),
  hasMore: false,
});

const success = <A>(value: A): JarvisVoiceCommandResult<A> => ({ status: "succeeded", value });
const failure = <A>(): JarvisVoiceCommandResult<A> => ({ status: "failed" });

function ports(overrides: Partial<JarvisVoiceDeliveryCoordinatorPorts> = {}) {
  const events: JarvisVoiceDeliveryEvent[] = [];
  const calls = { claim: 0, speak: 0, confirm: 0, release: 0, acknowledge: 0 };
  const base: JarvisVoiceDeliveryCoordinatorPorts = {
    deviceId: "desktop",
    deliveryNamespace: "environment-1:desktop",
    isReportForDevice: () => true,
    priority: 100,
    claim: async () => {
      calls.claim += 1;
      return success({ granted: true, speechState: "claimed" });
    },
    speak: async () => {
      calls.speak += 1;
      return { status: "played" };
    },
    confirm: async () => {
      calls.confirm += 1;
      return success({ confirmed: true, state: "confirmed" });
    },
    release: async () => {
      calls.release += 1;
      return success({ released: true, state: "released" as const });
    },
    acknowledge: async () => {
      calls.acknowledge += 1;
      return success(undefined);
    },
    hasPlayedLocally: () => false,
    rememberPlayedLocally: vi.fn(),
    setDegraded: vi.fn(),
    clearDegraded: vi.fn(),
    onEvent: (event) => events.push(event),
    ...overrides,
  };
  return { ports: base, events, calls };
}

const settle = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

function manualScheduler() {
  const scheduled: Array<{ readonly task: () => void; cancelled: boolean; fired: boolean }> = [];
  const schedule = (_delayMs: number, task: () => void) => {
    const item = {
      task: () => {
        item.fired = true;
        task();
      },
      cancelled: false,
      fired: false,
    };
    scheduled.push(item);
    return () => {
      item.cancelled = true;
    };
  };
  return { schedule, scheduled };
}

describe("JarvisVoiceDeliveryCoordinator", () => {
  it("keeps an active work-start entry across an unrelated v2 delta", async () => {
    let claims = 0;
    const test = ports({
      claim: async () => {
        claims += 1;
        return success({ granted: false, speechState: "leased" });
      },
    });
    const coordinator = createJarvisVoiceDeliveryCoordinator(test.ports);
    coordinator.receiveBatch({ ...batch("work-start"), removedReportIds: [] });
    await settle();
    coordinator.receiveBatch({
      acknowledgedThrough: 1,
      batchThrough: 2,
      deliveries: [{ sequence: 2, report: report("unrelated") }],
      removedReportIds: [],
      hasMore: false,
    });
    await settle();
    coordinator.wake("speech-state");
    await settle();
    expect(claims).toBeGreaterThan(1);
  });

  it("drops an explicitly removed entry from a v2 delta", async () => {
    const cancelSpeech = vi.fn();
    const test = ports({
      claim: async () => success({ granted: true, speechState: "claimed" }),
      speak: () => new Promise<JarvisVoiceSpeechOutcome>(() => undefined),
      cancelSpeech,
    });
    const coordinator = createJarvisVoiceDeliveryCoordinator(test.ports);
    coordinator.receiveBatch({ ...batch("dismissed"), removedReportIds: [] });
    await settle();
    coordinator.receiveBatch({
      acknowledgedThrough: 1,
      batchThrough: 2,
      deliveries: [],
      removedReportIds: ["dismissed"],
      hasMore: false,
    });
    coordinator.wake("speech-state");
    await settle();
    expect(cancelSpeech).toHaveBeenCalledWith(expect.stringMatching(/:dismissed:\d+$/u));
    expect(
      test.events.filter((event) => event.reportId === "dismissed" && event.state === "claiming"),
    ).toHaveLength(1);
  });

  it("namespaces delivery IDs across coordinator lifetimes", async () => {
    const deliveryIds: string[] = [];
    const cancellations: string[] = [];
    const first = ports({
      speak: (_report, deliveryId) => {
        deliveryIds.push(deliveryId);
        return new Promise<JarvisVoiceSpeechOutcome>(() => undefined);
      },
      cancelSpeech: (deliveryId) => {
        cancellations.push(deliveryId);
      },
    });
    const second = ports({
      speak: (_report, deliveryId) => {
        deliveryIds.push(deliveryId);
        return new Promise<JarvisVoiceSpeechOutcome>(() => undefined);
      },
      cancelSpeech: (deliveryId) => {
        cancellations.push(deliveryId);
      },
    });
    const firstCoordinator = createJarvisVoiceDeliveryCoordinator(first.ports);
    const secondCoordinator = createJarvisVoiceDeliveryCoordinator(second.ports);
    firstCoordinator.receiveBatch({ ...batch("same-report"), removedReportIds: [] });
    secondCoordinator.receiveBatch({ ...batch("same-report"), removedReportIds: [] });
    await settle();

    expect(deliveryIds).toHaveLength(2);
    expect(deliveryIds[0]).not.toBe(deliveryIds[1]);

    firstCoordinator.receiveBatch({
      acknowledgedThrough: 0,
      batchThrough: 2,
      deliveries: [],
      removedReportIds: ["same-report"],
      hasMore: false,
    });
    await settle();
    expect(cancellations).toEqual([deliveryIds[0]]);
    expect(cancellations).not.toContain(deliveryIds[1]);
    secondCoordinator.dispose();
  });

  it("forgets local playback state after removal before a new higher-sequence delivery", async () => {
    const test = ports();
    const coordinator = createJarvisVoiceDeliveryCoordinator(test.ports);
    coordinator.receiveBatch({ ...batch("reused-id"), removedReportIds: [] });
    await settle();
    coordinator.receiveBatch({
      acknowledgedThrough: 1,
      batchThrough: 2,
      deliveries: [],
      removedReportIds: ["reused-id"],
      hasMore: false,
    });
    await settle();
    coordinator.receiveBatch({
      acknowledgedThrough: 2,
      batchThrough: 3,
      deliveries: [{ sequence: 3, report: report("reused-id") }],
      removedReportIds: [],
      hasMore: false,
    });
    await settle();
    expect(test.calls.speak).toBe(2);
  });

  it("claims, speaks, remembers, confirms, and acknowledges exactly once", async () => {
    const test = ports();
    const coordinator = createJarvisVoiceDeliveryCoordinator(test.ports);
    coordinator.receiveBatch(batch("one"));
    await settle();
    expect(test.calls).toEqual({ claim: 1, speak: 1, confirm: 1, release: 0, acknowledge: 1 });
    expect(test.events.map((event) => event.state)).toEqual([
      "claiming",
      "speaking",
      "played-local",
      "confirming",
      "settled",
    ]);
  });

  it("evicts settled entries through an acknowledgement and ignores a later replay", async () => {
    const test = ports();
    const coordinator = createJarvisVoiceDeliveryCoordinator(test.ports);
    const first = batch("acked-once");
    coordinator.receiveBatch(first);
    await settle();
    coordinator.wake("reconnect");
    coordinator.receiveBatch(first);
    await settle();
    expect(test.calls).toEqual({ claim: 1, speak: 1, confirm: 1, release: 0, acknowledge: 1 });
  });

  it("treats an already-spoken durable claim as terminal and acknowledges it", async () => {
    let claims = 0;
    const test = ports({
      claim: async () => {
        claims += 1;
        return success({ granted: false, speechState: "already-spoken" });
      },
    });
    const coordinator = createJarvisVoiceDeliveryCoordinator(test.ports);
    coordinator.receiveBatch(batch("one"));
    await settle();
    expect(claims).toBe(1);
    expect(test.calls).toEqual({ claim: 0, speak: 0, confirm: 0, release: 0, acknowledge: 1 });
    expect(test.events.at(-1)?.state).toBe("settled");
  });

  it("acknowledges reports belonging to another device without claiming them", async () => {
    const test = ports({ isReportForDevice: () => false });
    const coordinator = createJarvisVoiceDeliveryCoordinator(test.ports);
    coordinator.receiveBatch(batch("other-device"));
    await settle();
    expect(test.calls.claim).toBe(0);
    expect(test.calls.speak).toBe(0);
    expect(test.calls.acknowledge).toBe(1);
  });

  it("acknowledges an inactive-only batch through its server cursor", async () => {
    let acknowledgedThrough: number | undefined;
    let acknowledgements = 0;
    const test = ports({
      acknowledge: async (throughSequence) => {
        acknowledgements += 1;
        acknowledgedThrough = throughSequence;
        return success(undefined);
      },
    });
    const coordinator = createJarvisVoiceDeliveryCoordinator(test.ports);
    coordinator.receiveBatch({
      acknowledgedThrough: 0,
      batchThrough: 12,
      deliveries: [],
      hasMore: false,
    });
    await settle();
    expect(acknowledgedThrough).toBe(12);
    expect(acknowledgements).toBe(1);
  });

  it("does one claim attempt for a competing lease and waits for a wake", async () => {
    const test = ports({ claim: async () => success({ granted: false, speechState: "leased" }) });
    const coordinator = createJarvisVoiceDeliveryCoordinator(test.ports);
    coordinator.receiveBatch(batch("one"));
    await settle();
    coordinator.wake("speech-state");
    await settle();
    expect(test.events.filter((event) => event.state === "claiming")).toHaveLength(2);
    expect(test.calls.acknowledge).toBe(0);
  });

  it("lets later reports proceed while an earlier report is blocked", async () => {
    let claims = 0;
    const test = ports({
      claim: async () => {
        claims += 1;
        return claims === 1
          ? success({ granted: false, speechState: "leased" })
          : success({ granted: true, speechState: "claimed" });
      },
    });
    const coordinator = createJarvisVoiceDeliveryCoordinator(test.ports);
    coordinator.receiveBatch(batch("blocked", "later"));
    await settle();
    expect(test.calls.speak).toBe(1);
    expect(
      test.events.some((event) => event.reportId === "later" && event.state === "settled"),
    ).toBe(true);
  });

  it("does not retry a deferred utterance until voice-ready or reconnect", async () => {
    let speaks = 0;
    const test = ports({
      speak: async () => {
        speaks += 1;
        return { status: "deferred", reason: "busy" };
      },
    });
    const coordinator = createJarvisVoiceDeliveryCoordinator(test.ports);
    coordinator.receiveBatch(batch("one"));
    await settle();
    coordinator.wake("speech-state");
    await settle();
    expect(speaks).toBe(1);
    expect(test.ports.setDegraded).toHaveBeenCalledTimes(0);
    coordinator.wake("voice-ready");
    await settle();
    expect(speaks).toBe(2);
  });

  it("retries a failed utterance once after the bounded cooldown", async () => {
    vi.useFakeTimers();
    try {
      let speaks = 0;
      const test = ports({
        speak: vi.fn(async (): Promise<{ readonly status: "failed"; readonly code: string }> => {
          speaks += 1;
          return { status: "failed", code: "broken" };
        }),
      });
      const coordinator = createJarvisVoiceDeliveryCoordinator(test.ports);
      coordinator.receiveBatch(batch("one"));
      await settle();
      expect(speaks).toBe(1);
      await vi.advanceTimersByTimeAsync(5_000);
      await settle();
      expect(speaks).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not re-speak local audio after a confirmation transport failure", async () => {
    let confirmations = 0;
    let playedLocally = false;
    const test = ports({
      hasPlayedLocally: () => playedLocally,
      rememberPlayedLocally: () => {
        playedLocally = true;
      },
      confirm: async () => {
        confirmations += 1;
        return confirmations === 1 ? failure() : success({ confirmed: true, state: "confirmed" });
      },
    });
    const coordinator = createJarvisVoiceDeliveryCoordinator(test.ports);
    coordinator.receiveBatch(batch("one"));
    await settle();
    coordinator.receiveBatch({ ...batch("one"), acknowledgedThrough: 1 });
    await settle();
    expect(confirmations).toBe(1);
    coordinator.wake("cooldown");
    await settle();
    expect(test.calls.speak).toBe(1);
    expect(confirmations).toBe(2);
  });

  it("keeps lease-lost confirmation pending without acknowledging", async () => {
    const test = ports({
      confirm: async () => success({ confirmed: false, state: "lease-lost" }),
    });
    const coordinator = createJarvisVoiceDeliveryCoordinator(test.ports);
    coordinator.receiveBatch(batch("one"));
    await settle();
    expect(test.calls.acknowledge).toBe(0);
    expect(test.events.at(-1)?.state).toBe("blocked");
  });

  it("ignores stale async results and all work after dispose", async () => {
    let resolveSpeak!: (value: { status: "played" }) => void;
    const test = ports({ speak: () => new Promise((resolve) => (resolveSpeak = resolve)) });
    const coordinator = createJarvisVoiceDeliveryCoordinator(test.ports);
    coordinator.receiveBatch(batch("one"));
    await settle();
    coordinator.dispose();
    resolveSpeak({ status: "played" });
    await settle();
    expect(test.calls.confirm).toBe(0);
    expect(test.calls.acknowledge).toBe(0);
  });

  it("handles every durable release result without claiming again", async () => {
    const releaseStates = ["released", "already-spoken", "missing", "lease-lost"] as const;
    for (const state of releaseStates) {
      let releases = 0;
      const test = ports({
        speak: async () => ({ status: "deferred" as const, reason: "voice-not-ready" }),
        release: async () => {
          releases += 1;
          return success({ released: state === "released", state });
        },
      });
      const coordinator = createJarvisVoiceDeliveryCoordinator(test.ports);
      coordinator.receiveBatch(batch(`release-${state}`));
      await settle();
      expect(test.calls.claim).toBe(1);
      expect(releases).toBe(1);
      expect(test.calls.speak).toBe(0);
      expect(test.events.at(-1)?.state).toBe(
        state === "released" ? "deferred" : state === "lease-lost" ? "blocked" : "settled",
      );
      coordinator.dispose();
    }
  });

  it("treats a missing claim as terminal and still advances the batch", async () => {
    const test = ports({ claim: async () => success({ granted: false, speechState: "missing" }) });
    const coordinator = createJarvisVoiceDeliveryCoordinator(test.ports);
    coordinator.receiveBatch(batch("missing-claim"));
    await settle();
    expect(test.calls.speak).toBe(0);
    expect(test.calls.confirm).toBe(0);
    expect(test.calls.acknowledge).toBe(1);
    expect(test.events.at(-1)?.reason).toBe("missing");
  });

  it("settles every terminal confirmation state without another speech attempt", async () => {
    const confirmationStates = ["confirmed", "already-spoken", "missing"] as const;
    for (const state of confirmationStates) {
      let confirmations = 0;
      const test = ports({
        confirm: async () => {
          confirmations += 1;
          return success({ confirmed: state === "confirmed", state });
        },
      });
      const coordinator = createJarvisVoiceDeliveryCoordinator(test.ports);
      coordinator.receiveBatch(batch(`confirm-${state}`));
      await settle();
      expect(test.calls.speak).toBe(1);
      expect(confirmations).toBe(1);
      expect(test.calls.acknowledge).toBe(1);
      coordinator.dispose();
    }
  });

  it("uses local played state after a claimed report without synthesizing again", async () => {
    const test = ports({ hasPlayedLocally: () => true });
    const coordinator = createJarvisVoiceDeliveryCoordinator(test.ports);
    coordinator.receiveBatch(batch("seen-claimed"));
    await settle();
    expect(test.calls.claim).toBe(1);
    expect(test.calls.speak).toBe(0);
    expect(test.calls.confirm).toBe(1);
    expect(test.calls.acknowledge).toBe(1);
  });

  it("retries a release transport failure as release-only work", async () => {
    const timer = manualScheduler();
    let releases = 0;
    let claims = 0;
    const test = ports({
      claim: async () => {
        claims += 1;
        return success({ granted: true, speechState: "claimed" });
      },
      speak: async () => ({ status: "deferred" as const, reason: "busy" }),
      release: async () => {
        releases += 1;
        return releases === 1 ? failure() : success({ released: true, state: "released" as const });
      },
    });
    const coordinator = createJarvisVoiceDeliveryCoordinator(test.ports, {
      schedule: timer.schedule,
    });
    coordinator.receiveBatch(batch("release-retry"));
    await settle();
    expect({ claims, releases }).toEqual({ claims: 1, releases: 1 });
    expect(timer.scheduled).toHaveLength(1);
    timer.scheduled[0]?.task();
    await settle();
    expect({ claims, releases }).toEqual({ claims: 1, releases: 2 });
    coordinator.wake("voice-ready");
    await settle();
    expect(claims).toBe(2);
  });

  it("releases a thrown speech failure once and deduplicates degraded presentation", async () => {
    const test = ports({
      speak: async () => {
        throw new Error("speaker crashed");
      },
    });
    const coordinator = createJarvisVoiceDeliveryCoordinator(test.ports);
    coordinator.receiveBatch(batch("thrown-speech"));
    await settle();
    expect(test.calls.release).toBe(1);
    expect(test.ports.setDegraded).toHaveBeenCalledTimes(1);
    coordinator.wake("speech-state");
    await settle();
    expect(test.calls.claim).toBe(1);
    expect(test.ports.setDegraded).toHaveBeenCalledTimes(1);
  });

  it("does not arm a second failure cooldown until a reconnect", async () => {
    const timer = manualScheduler();
    let speaks = 0;
    const test = ports({
      speak: async () => {
        speaks += 1;
        return { status: "failed" as const, code: "broken" };
      },
    });
    const coordinator = createJarvisVoiceDeliveryCoordinator(test.ports, {
      schedule: timer.schedule,
    });
    coordinator.receiveBatch(batch("bounded-speech"));
    await settle();
    expect(timer.scheduled.filter((item) => !item.cancelled && !item.fired)).toHaveLength(1);
    timer.scheduled[0]?.task();
    await settle();
    expect(speaks).toBe(2);
    expect(timer.scheduled.filter((item) => !item.cancelled && !item.fired)).toHaveLength(0);
    coordinator.wake("reconnect");
    await settle();
    expect(speaks).toBe(3);
    expect(timer.scheduled.filter((item) => !item.cancelled && !item.fired)).toHaveLength(1);
  });

  it("confirms and acknowledges when rememberSeen storage throws", async () => {
    const test = ports({
      rememberPlayedLocally: () => {
        throw new Error("storage");
      },
    });
    const coordinator = createJarvisVoiceDeliveryCoordinator(test.ports);
    coordinator.receiveBatch(batch("remember-throws"));
    await settle();
    expect(test.calls).toEqual({ claim: 1, speak: 1, confirm: 1, release: 0, acknowledge: 1 });
  });

  it("treats an identical batch as a speech-state wake", async () => {
    let claims = 0;
    const test = ports({
      claim: async () => {
        claims += 1;
        return claims === 1
          ? success({ granted: false, speechState: "leased" })
          : success({ granted: true, speechState: "claimed" });
      },
    });
    const coordinator = createJarvisVoiceDeliveryCoordinator(test.ports);
    const first = batch("same-batch");
    coordinator.receiveBatch(first);
    await settle();
    coordinator.receiveBatch(first);
    await settle();
    expect(claims).toBe(2);
    expect(test.calls.speak).toBe(1);
  });

  it("does not duplicate an in-flight operation on an identical batch", async () => {
    let resolveSpeak: ((value: { readonly status: "played" }) => void) | undefined;
    let speaks = 0;
    const test = ports({
      speak: () =>
        new Promise((resolve) => {
          speaks += 1;
          resolveSpeak = resolve;
        }),
    });
    const coordinator = createJarvisVoiceDeliveryCoordinator(test.ports);
    const first = batch("in-flight");
    coordinator.receiveBatch(first);
    await settle();
    coordinator.receiveBatch(first);
    await settle();
    expect(test.calls).toMatchObject({ claim: 1, speak: 0, confirm: 0 });
    expect(speaks).toBe(1);
    resolveSpeak?.({ status: "played" });
    await settle();
    expect(test.calls.confirm).toBe(1);
  });

  it("invalidates removed reports so stale claim results cannot speak", async () => {
    let resolveClaim:
      | ((
          value: JarvisVoiceCommandResult<{
            readonly granted: true;
            readonly speechState: "claimed";
          }>,
        ) => void)
      | undefined;
    const test = ports({
      claim: () =>
        new Promise((resolve) => {
          resolveClaim = resolve;
        }),
    });
    const coordinator = createJarvisVoiceDeliveryCoordinator(test.ports);
    coordinator.receiveBatch(batch("removed"));
    await settle();
    coordinator.receiveBatch(batch());
    resolveClaim?.(success({ granted: true, speechState: "claimed" }));
    await settle();
    expect(test.calls.speak).toBe(0);
    expect(test.calls.confirm).toBe(0);
    expect(test.calls.acknowledge).toBe(1);
  });

  it("cancels pending cooldown work on dispose", async () => {
    const timer = manualScheduler();
    const test = ports({
      speak: async () => ({ status: "failed" as const, code: "broken" }),
    });
    const coordinator = createJarvisVoiceDeliveryCoordinator(test.ports, {
      schedule: timer.schedule,
    });
    coordinator.receiveBatch(batch("dispose-timer"));
    await settle();
    expect(timer.scheduled.filter((item) => !item.cancelled && !item.fired)).toHaveLength(1);
    coordinator.dispose();
    expect(timer.scheduled.filter((item) => !item.cancelled && !item.fired)).toHaveLength(0);
    timer.scheduled[0]?.task();
    await settle();
    expect(test.calls.claim).toBe(1);
  });

  it("cleans a removed report's retry timer and degraded state", async () => {
    const timer = manualScheduler();
    const test = ports({ speak: async () => ({ status: "failed" as const, code: "broken" }) });
    const coordinator = createJarvisVoiceDeliveryCoordinator(test.ports, {
      schedule: timer.schedule,
    });
    coordinator.receiveBatch(batch("removed-failure"));
    await settle();
    expect(test.ports.setDegraded).toHaveBeenCalledTimes(1);
    expect(timer.scheduled.filter((item) => !item.cancelled && !item.fired)).toHaveLength(1);
    coordinator.receiveBatch(batch());
    await settle();
    expect(test.ports.clearDegraded).toHaveBeenCalledTimes(1);
    expect(timer.scheduled.filter((item) => !item.cancelled && !item.fired)).toHaveLength(0);
  });

  it("keeps the releasing coordinator quiet while a second one reclaims after release", async () => {
    let owner: string | undefined;
    let firstClaims = 0;
    let firstSpeaks = 0;
    let firstReleases = 0;
    let secondClaims = 0;
    let secondSpeaks = 0;
    const timer = manualScheduler();
    const first = ports({
      deviceId: "first",
      claim: async () => {
        firstClaims += 1;
        owner = "first";
        return success({ granted: true, speechState: "claimed" });
      },
      speak: async () => {
        firstSpeaks += 1;
        return { status: "deferred" as const, reason: "not-ready" };
      },
      release: async () => {
        firstReleases += 1;
        if (firstReleases === 1) return failure();
        owner = undefined;
        return success({ released: true, state: "released" as const });
      },
    });
    const second = ports({
      deviceId: "second",
      claim: async () => {
        secondClaims += 1;
        if (owner !== undefined) return success({ granted: false, speechState: "leased" });
        owner = "second";
        return success({ granted: true, speechState: "claimed" });
      },
      speak: async () => {
        secondSpeaks += 1;
        return { status: "played" as const };
      },
    });
    const firstCoordinator = createJarvisVoiceDeliveryCoordinator(first.ports, {
      schedule: timer.schedule,
    });
    const secondCoordinator = createJarvisVoiceDeliveryCoordinator(second.ports);
    const firstBatch = batch("handoff");
    firstCoordinator.receiveBatch(firstBatch);
    await settle();
    firstCoordinator.receiveBatch(firstBatch);
    await settle();
    expect({ firstClaims, firstSpeaks, firstReleases }).toEqual({
      firstClaims: 1,
      firstSpeaks: 1,
      firstReleases: 1,
    });
    secondCoordinator.receiveBatch(firstBatch);
    await settle();
    expect({ secondClaims, secondSpeaks }).toEqual({ secondClaims: 1, secondSpeaks: 0 });
    timer.scheduled[0]?.task();
    await settle();
    expect(firstReleases).toBe(2);
    firstCoordinator.receiveBatch(firstBatch);
    await settle();
    expect(firstClaims).toBe(1);
    secondCoordinator.receiveBatch(firstBatch);
    await settle();
    expect({ secondClaims, secondSpeaks }).toEqual({ secondClaims: 2, secondSpeaks: 1 });
    firstCoordinator.dispose();
    secondCoordinator.dispose();
  });

  it("lets a competing coordinator recover after the first confirms", async () => {
    let owner: string | undefined;
    let confirmed = false;
    let firstConfirmations = 0;
    let secondSpeaks = 0;
    const first = ports({
      deviceId: "first-confirm",
      claim: async () => {
        owner = "first-confirm";
        return success({ granted: true, speechState: "claimed" });
      },
      confirm: async () => {
        firstConfirmations += 1;
        if (firstConfirmations === 1) return failure();
        confirmed = true;
        return success({ confirmed: true, state: "confirmed" as const });
      },
    });
    const second = ports({
      deviceId: "second-confirm",
      claim: async () => {
        if (!confirmed && owner === "first-confirm")
          return success({ granted: false, speechState: "leased" });
        return success({ granted: false, speechState: "already-spoken" });
      },
      speak: async () => {
        secondSpeaks += 1;
        return { status: "played" as const };
      },
    });
    const firstCoordinator = createJarvisVoiceDeliveryCoordinator(first.ports);
    const secondCoordinator = createJarvisVoiceDeliveryCoordinator(second.ports);
    const firstBatch = batch("confirm-recovery");
    firstCoordinator.receiveBatch(firstBatch);
    await settle();
    secondCoordinator.receiveBatch(firstBatch);
    await settle();
    expect(secondSpeaks).toBe(0);
    firstCoordinator.wake("reconnect");
    await settle();
    secondCoordinator.receiveBatch(firstBatch);
    await settle();
    expect(firstConfirmations).toBe(2);
    expect(secondSpeaks).toBe(0);
    firstCoordinator.dispose();
    secondCoordinator.dispose();
  });

  it("bounds acknowledgement retry and only reconnect re-arms it", async () => {
    const timer = manualScheduler();
    let acknowledgements = 0;
    const test = ports({
      acknowledge: async () => {
        acknowledgements += 1;
        return failure();
      },
    });
    const coordinator = createJarvisVoiceDeliveryCoordinator(test.ports, {
      schedule: timer.schedule,
    });
    coordinator.receiveBatch(batch("ack-bounded"));
    await settle();
    expect(acknowledgements).toBe(1);
    timer.scheduled[0]?.task();
    await settle();
    expect(acknowledgements).toBe(2);
    coordinator.wake("speech-state");
    await settle();
    expect(acknowledgements).toBe(2);
    coordinator.wake("reconnect");
    await settle();
    expect(acknowledgements).toBe(3);
  });

  it("resets truncation state once per floor and cancels its pending work", async () => {
    const timer = manualScheduler();
    const test = ports({ speak: async () => ({ status: "failed" as const, code: "broken" }) });
    const coordinator = createJarvisVoiceDeliveryCoordinator(test.ports, {
      schedule: timer.schedule,
    });
    coordinator.receiveBatch(batch("before-reset"));
    await settle();
    expect(test.ports.setDegraded).toHaveBeenCalledTimes(1);
    coordinator.receiveBatch({ ...batch("after-reset"), truncatedBefore: 2 });
    await settle();
    expect(test.ports.clearDegraded).toHaveBeenCalledTimes(1);
    expect(timer.scheduled[0]?.cancelled).toBe(true);
    coordinator.receiveBatch({ ...batch("after-reset"), truncatedBefore: 2 });
    await settle();
    expect(test.ports.clearDegraded).toHaveBeenCalledTimes(1);
  });
});
