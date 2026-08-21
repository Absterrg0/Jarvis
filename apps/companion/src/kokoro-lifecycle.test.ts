import { assert, describe, it } from "@effect/vitest";

import { createKokoroLifecycle, type KokoroWorker } from "./kokoro-lifecycle.ts";

function harness() {
  let starts = 0;
  let closes = 0;
  let scheduled: (() => void) | undefined;
  const worker: KokoroWorker = {
    synthesize: async (text) => `/tmp/${text}.wav`,
    close: async () => {
      closes += 1;
    },
  };
  const lifecycle = createKokoroLifecycle({
    startWorker: async () => {
      starts += 1;
      return worker;
    },
    schedule: (_delay, task) => {
      scheduled = task;
      return () => {
        if (scheduled === task) scheduled = undefined;
      };
    },
    idleMs: 30_000,
  });
  return {
    lifecycle,
    starts: () => starts,
    closes: () => closes,
    evict: () => scheduled?.(),
  };
}

describe("Kokoro lifecycle", () => {
  it("coalesces prewarm and keeps the ready worker for immediate synthesis", async () => {
    const test = harness();
    await Promise.all([test.lifecycle.prewarm(), test.lifecycle.prewarm()]);
    assert.equal(test.starts(), 1);
    assert.equal(test.lifecycle.state(), "ready");
    assert.equal(await test.lifecycle.synthesize("hello"), "/tmp/hello.wav");
    assert.equal(test.starts(), 1);
  });

  it("fully offloads the worker after the short idle window", async () => {
    const test = harness();
    await test.lifecycle.prewarm();
    test.evict();
    await Promise.resolve();
    assert.equal(test.lifecycle.state(), "offloaded");
    assert.equal(test.closes(), 1);
  });

  it("keeps the offload timer after a redundant elected-device prewarm", async () => {
    const test = harness();
    await test.lifecycle.prewarm();
    await test.lifecycle.prewarm();
    test.evict();
    await Promise.resolve();
    assert.equal(test.lifecycle.state(), "offloaded");
    assert.equal(test.closes(), 1);
  });

  it("kills synthesis on interruption and permits a clean future warm", async () => {
    let resolveSynthesis: ((path: string) => void) | undefined;
    let starts = 0;
    let closes = 0;
    const lifecycle = createKokoroLifecycle({
      startWorker: async () => {
        starts += 1;
        return {
          synthesize: () =>
            new Promise<string>((resolve) => {
              resolveSynthesis = resolve;
            }),
          close: async () => {
            closes += 1;
            resolveSynthesis?.("stale.wav");
          },
        };
      },
      schedule: () => () => undefined,
      idleMs: 30_000,
    });
    const controller = new AbortController();
    const pending = lifecycle.synthesize("first", controller.signal);
    await Promise.resolve();
    controller.abort();
    const failure = await pending.catch((cause: unknown) => cause);
    assert.instanceOf(failure, DOMException);
    assert.equal((failure as DOMException).name, "AbortError");
    assert.equal(closes, 1);
    await lifecycle.prewarm();
    assert.equal(starts, 2);
  });
});
