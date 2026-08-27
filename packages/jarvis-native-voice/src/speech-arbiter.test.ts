import { assert, describe, it } from "@effect/vitest";

import { createSpeechArbiter } from "./speech-arbiter.ts";

function speechHarness() {
  const spoken: string[] = [];
  const finish: Array<() => void> = [];
  const arbiter = createSpeechArbiter(
    (text, signal) =>
      new Promise<void>((resolve) => {
        spoken.push(text);
        const done = () => resolve();
        signal.addEventListener("abort", done, { once: true });
        finish.push(done);
      }),
  );
  return { arbiter, spoken, finish };
}

describe("speech arbiter", () => {
  it("never overlaps two audio jobs", async () => {
    const { arbiter, spoken, finish } = speechHarness();
    const first = arbiter.enqueue("First");
    const second = arbiter.enqueue("Second");

    assert.deepEqual(spoken, ["First"]);
    finish.shift()?.();
    await first;
    assert.deepEqual(spoken, ["First", "Second"]);
    finish.shift()?.();
    await second;
  });

  it("keeps ordered acknowledgements ahead of a queued completion report", async () => {
    const { arbiter, spoken, finish } = speechHarness();
    const first = arbiter.reserve();
    const report = arbiter.enqueue("Completed");
    const second = arbiter.reserve();

    const firstDone = first.commit("Starting first");
    const secondDone = second.commit("Starting second");
    await Promise.resolve();
    assert.deepEqual(spoken, ["Starting first"]);

    finish.shift()?.();
    await firstDone;
    await Promise.resolve();
    assert.deepEqual(spoken, ["Starting first", "Starting second"]);
    finish.shift()?.();
    await secondDone;
    await Promise.resolve();
    assert.deepEqual(spoken, ["Starting first", "Starting second", "Completed"]);
    finish.shift()?.();
    await report;
  });

  it("replaces only a stale pending report", async () => {
    const { arbiter, spoken, finish } = speechHarness();
    const current = arbiter.enqueue("Current");
    const stale = arbiter.enqueue("Stale");
    const latest = arbiter.enqueue("Latest");

    finish.shift()?.();
    await current;
    await stale;
    assert.deepEqual(spoken, ["Current", "Latest"]);
    finish.shift()?.();
    await latest;
  });

  it("barge-in stops playback and clears every pending audio job", async () => {
    const { arbiter, spoken } = speechHarness();
    const current = arbiter.enqueue("Current");
    const report = arbiter.enqueue("Pending");
    const acknowledgement = arbiter.reserve();

    arbiter.interrupt();
    await Promise.all([current, report, acknowledgement.commit("Must not play")]);
    assert.deepEqual(spoken, ["Current"]);
    assert.isFalse(arbiter.isActive());
  });
});
