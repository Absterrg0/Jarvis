import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { JarvisSpeakerLease } from "../Services/JarvisSpeakerLease.ts";
import { JarvisSpeakerLeaseLive } from "./JarvisSpeakerLease.ts";

describe("JarvisSpeakerLease", () => {
  it.live("elects only the highest-priority device for one report", () =>
    Effect.gen(function* () {
      const lease = yield* JarvisSpeakerLease;
      const [laptop, desktop] = yield* Effect.all(
        [
          lease.claim({ reportId: "report-1", deviceId: "laptop", priority: 50 }),
          lease.claim({ reportId: "report-1", deviceId: "desktop", priority: 100 }),
        ],
        { concurrency: "unbounded" },
      );
      expect(laptop.granted).toBe(false);
      expect(desktop.granted).toBe(true);
    }).pipe(Effect.provide(JarvisSpeakerLeaseLive)),
  );

  it.live("never replaces a finalized speaker with a late claim", () =>
    Effect.gen(function* () {
      const lease = yield* JarvisSpeakerLease;
      const laptop = yield* lease.claim({
        reportId: "report-late",
        deviceId: "laptop",
        priority: 50,
      });
      const desktop = yield* lease.claim({
        reportId: "report-late",
        deviceId: "desktop",
        priority: 100,
      });
      expect(laptop.granted).toBe(true);
      expect(desktop.granted).toBe(false);
      yield* lease.release({ reportId: "report-late", deviceId: "desktop" });
      expect(
        (yield* lease.claim({ reportId: "report-late", deviceId: "desktop", priority: 100 }))
          .granted,
      ).toBe(false);
    }).pipe(Effect.provide(JarvisSpeakerLeaseLive)),
  );

  it.live("releases a finalized claim so a later device can speak", () =>
    Effect.gen(function* () {
      const lease = yield* JarvisSpeakerLease;
      expect(
        (yield* lease.claim({ reportId: "report-release", deviceId: "laptop", priority: 100 }))
          .granted,
      ).toBe(true);
      yield* lease.release({ reportId: "report-release", deviceId: "laptop" });
      expect(
        (yield* lease.claim({ reportId: "report-release", deviceId: "desktop", priority: 50 }))
          .granted,
      ).toBe(true);
    }).pipe(Effect.provide(JarvisSpeakerLeaseLive)),
  );
});
