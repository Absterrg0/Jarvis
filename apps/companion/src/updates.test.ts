import { assert, describe, it } from "@effect/vitest";

import {
  configureCompanionUpdates,
  type CompanionUpdateEvent,
  type CompanionUpdater,
} from "./updates.ts";

function updaterHarness() {
  const listeners = new Map<string, Array<(...args: ReadonlyArray<unknown>) => void>>();
  let checks = 0;
  let installs = 0;
  const updater: CompanionUpdater = {
    configure: () => undefined,
    on: (event, listener) => {
      const current = listeners.get(event) ?? [];
      current.push(listener);
      listeners.set(event, current);
      return () =>
        listeners.set(
          event,
          current.filter((candidate) => candidate !== listener),
        );
    },
    check: async () => {
      checks += 1;
    },
    install: () => {
      installs += 1;
    },
  };
  return {
    updater,
    emit: (event: CompanionUpdateEvent, ...args: ReadonlyArray<unknown>) =>
      listeners.get(event)?.forEach((listener) => listener(...args)),
    checks: () => checks,
    installs: () => installs,
  };
}

describe("Companion updates", () => {
  it("checks after startup and downloads an available differential update", async () => {
    const harness = updaterHarness();
    const scheduled: Array<() => void> = [];
    const states: Array<string> = [];
    const updates = configureCompanionUpdates({
      updater: harness.updater,
      packaged: true,
      schedule: (_delay, task) => {
        scheduled.push(task);
        return () => undefined;
      },
      onState: (state) => states.push(state.status),
    });

    assert.equal(scheduled.length, 2);
    scheduled[0]?.();
    await Promise.resolve();
    assert.equal(harness.checks(), 1);
    harness.emit("update-available", { version: "0.3.1248" });
    harness.emit("download-progress", { percent: 41.2 });
    harness.emit("update-downloaded", { version: "0.3.1248" });

    assert.deepEqual(states, ["idle", "checking", "downloading", "downloading", "ready"]);
    assert.deepEqual(updates.getState(), { status: "ready", version: "0.3.1248" });
  });

  it("installs only a fully downloaded update", () => {
    const harness = updaterHarness();
    const updates = configureCompanionUpdates({
      updater: harness.updater,
      packaged: true,
      schedule: () => () => undefined,
      onState: () => undefined,
    });

    updates.install();
    assert.equal(harness.installs(), 0);
    harness.emit("update-downloaded", { version: "0.3.1248" });
    updates.install();
    assert.equal(harness.installs(), 1);
  });

  it("keeps source builds package-free and updater-free", () => {
    const harness = updaterHarness();
    const updates = configureCompanionUpdates({
      updater: harness.updater,
      packaged: false,
      schedule: () => {
        throw new Error("development must not schedule update checks");
      },
      onState: () => undefined,
    });

    assert.deepEqual(updates.getState(), { status: "disabled" });
    assert.equal(harness.checks(), 0);
  });
});
