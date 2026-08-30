import { assert, describe, it } from "@effect/vitest";

import { createSpeechQueue } from "./speech-arbiter.ts";

function speechHarness() {
  const spoken: string[] = [];
  const finish: Array<() => void> = [];
  const arbiter = createSpeechQueue(
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
    const first = arbiter.enqueue("First", "first");
    const second = arbiter.enqueue("Second", "second");

    assert.deepEqual(spoken, ["First"]);
    finish.shift()?.();
    await first;
    assert.deepEqual(spoken, ["First", "Second"]);
    finish.shift()?.();
    await second;
  });

  it("keeps acknowledgements and reports in one FIFO presentation queue", async () => {
    const { arbiter, spoken, finish } = speechHarness();
    const first = arbiter.enqueue("Starting first", "first");
    const report = arbiter.enqueue("Completed", "report");
    const second = arbiter.enqueue("Starting second", "second");

    finish.shift()?.();
    await first;
    await Promise.resolve();
    assert.deepEqual(spoken, ["Starting first", "Completed"]);
    finish.shift()?.();
    await report;
    await Promise.resolve();
    assert.deepEqual(spoken, ["Starting first", "Completed", "Starting second"]);
    finish.shift()?.();
    await second;
  });

  it("keeps every pending report in FIFO order", async () => {
    const { arbiter, spoken, finish } = speechHarness();
    const current = arbiter.enqueue("Current", "current");
    const stale = arbiter.enqueue("Stale", "stale");
    const latest = arbiter.enqueue("Latest", "latest");

    finish.shift()?.();
    await current;
    assert.deepEqual(spoken, ["Current", "Stale"]);
    finish.shift()?.();
    assert.deepEqual(await stale, { status: "played" });
    assert.deepEqual(spoken, ["Current", "Stale", "Latest"]);
    finish.shift()?.();
    await latest;
  });

  it("cancels exactly the requested pending report", async () => {
    const { arbiter, spoken, finish } = speechHarness();
    const first = arbiter.enqueue("First", "first");
    const cancelled = arbiter.enqueue("Cancelled", "cancelled");
    const third = arbiter.enqueue("Third", "third");
    arbiter.cancel("cancelled");
    assert.deepEqual(await cancelled, { status: "not-played", reason: "cancelled-before-start" });
    finish.shift()?.();
    await first;
    assert.deepEqual(spoken, ["First", "Third"]);
    finish.shift()?.();
    await third;
  });

  it("aborts exactly the requested active report", async () => {
    let aborted = false;
    const queue = createSpeechQueue(
      (_text, signal) =>
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
    const active = queue.enqueue("Active", "active-report");

    queue.cancel("active-report");

    assert.deepEqual(await active, { status: "not-played", reason: "interrupted" });
    assert.isTrue(aborted);
    assert.isFalse(queue.isActive());
  });

  it("notifies its owner only after the speech queue is fully idle", async () => {
    const complete: Array<() => void> = [];
    let idle = 0;
    const arbiter = createSpeechQueue(
      () =>
        new Promise<void>((resolve) => {
          complete.push(resolve);
        }),
      () => {
        idle += 1;
      },
    );
    const first = arbiter.enqueue("First", "first");
    const second = arbiter.enqueue("Second", "second");

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
    const arbiter = createSpeechQueue(
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
    const interaction = arbiter.enqueue("interaction", "interaction");

    assert.deepEqual(order, ["cue"]);
    finishCue();
    assert.deepEqual(await cue, { status: "played" });
    assert.deepEqual(await interaction, { status: "played" });
    assert.deepEqual(order, ["cue", "interaction"]);
    assert.equal(idle, 1);
  });

  it("interrupts an active cue without restoring a model it never used", async () => {
    let aborted = false;
    let idle = 0;
    const arbiter = createSpeechQueue(
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
    assert.deepEqual(await cue, { status: "not-played", reason: "interrupted" });
    assert.isTrue(aborted);
    assert.equal(idle, 0);
  });

  it("restores listening when interruption drops TTS queued behind a cue", async () => {
    let idle = 0;
    const arbiter = createSpeechQueue(
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
    const interaction = arbiter.enqueue("interaction", "interaction");

    arbiter.interrupt();
    assert.deepEqual(await cue, { status: "not-played", reason: "interrupted" });
    assert.deepEqual(await interaction, {
      status: "not-played",
      reason: "cancelled-before-start",
    });
    assert.equal(idle, 1);
  });

  it("barge-in stops playback and clears every pending audio job", async () => {
    const { arbiter, spoken } = speechHarness();
    const current = arbiter.enqueue("Current", "current");
    const report = arbiter.enqueue("Pending", "pending");
    const acknowledgement = arbiter.enqueue("Must not play", "acknowledgement");

    arbiter.interrupt();
    await Promise.all([current, report, acknowledgement]);
    assert.deepEqual(spoken, ["Current"]);
    assert.isFalse(arbiter.isActive());
  });

  it("notifies idle once when interruption clears the active queue", async () => {
    let idle = 0;
    const arbiter = createSpeechQueue(
      (_text, signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      () => {
        idle += 1;
      },
    );
    const current = arbiter.enqueue("Current", "current");
    const pending = arbiter.enqueue("Pending", "pending");

    await Promise.resolve();
    arbiter.interrupt();
    arbiter.interrupt();
    assert.deepEqual(await current, { status: "not-played", reason: "interrupted" });
    assert.deepEqual(await pending, {
      status: "not-played",
      reason: "cancelled-before-start",
    });

    assert.equal(idle, 1);
    assert.isFalse(arbiter.isActive());
  });
});
