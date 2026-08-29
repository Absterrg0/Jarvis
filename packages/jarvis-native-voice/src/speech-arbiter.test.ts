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
    assert.isFalse(await stale);
    assert.deepEqual(spoken, ["Current", "Latest"]);
    finish.shift()?.();
    await latest;
  });

  it("notifies its owner only after the speech queue is fully idle", async () => {
    const complete: Array<() => void> = [];
    let idle = 0;
    const arbiter = createSpeechArbiter(
      () =>
        new Promise<void>((resolve) => {
          complete.push(resolve);
        }),
      () => {
        idle += 1;
      },
    );
    const first = arbiter.enqueue("First");
    const second = arbiter.enqueue("Second");

    complete.shift()?.();
    await first;
    assert.equal(idle, 0);
    await Promise.resolve();
    complete.shift()?.();
    await second;
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(idle, 1);
  });

  it("serializes an abortable cue without requesting a speech-model restore", async () => {
    const order: string[] = [];
    let finishCue!: () => void;
    let idle = 0;
    const arbiter = createSpeechArbiter(
      async (text) => {
        order.push(text);
      },
      () => {
        idle += 1;
      },
    );
    const cue = arbiter.performOrdered(
      () =>
        new Promise<void>((resolve) => {
          order.push("cue");
          finishCue = resolve;
        }),
    );
    const interaction = arbiter.reserve().commit("interaction");

    assert.deepEqual(order, ["cue"]);
    finishCue();
    assert.isTrue(await cue);
    assert.isTrue(await interaction);
    assert.deepEqual(order, ["cue", "interaction"]);
    assert.equal(idle, 1);
  });

  it("interrupts an active cue without restoring a model it never used", async () => {
    let aborted = false;
    let idle = 0;
    const arbiter = createSpeechArbiter(
      async () => undefined,
      () => {
        idle += 1;
      },
    );
    const cue = arbiter.performOrdered(
      (signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          );
        }),
    );

    arbiter.interrupt();
    assert.isFalse(await cue);
    assert.isTrue(aborted);
    assert.equal(idle, 0);
  });

  it("restores listening when interruption drops TTS queued behind a cue", async () => {
    let idle = 0;
    const arbiter = createSpeechArbiter(
      async () => undefined,
      () => {
        idle += 1;
      },
    );
    const cue = arbiter.performOrdered(
      (signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    );
    const interaction = arbiter.reserve().commit("interaction");

    arbiter.interrupt();
    assert.isFalse(await cue);
    assert.isFalse(await interaction);
    assert.equal(idle, 1);
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

  it("notifies idle once when interruption clears the active queue", async () => {
    let idle = 0;
    const arbiter = createSpeechArbiter(
      (_text, signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      () => {
        idle += 1;
      },
    );
    const current = arbiter.enqueue("Current");
    const pending = arbiter.enqueue("Pending");

    await Promise.resolve();
    arbiter.interrupt();
    arbiter.interrupt();
    assert.isFalse(await current);
    assert.isFalse(await pending);

    assert.equal(idle, 1);
    assert.isFalse(arbiter.isActive());
  });
});
