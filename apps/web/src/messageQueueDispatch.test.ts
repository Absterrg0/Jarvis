import { describe, expect, it } from "vite-plus/test";

import { createQueuedMessageDispatchController } from "./messageQueueDispatch";

describe("createQueuedMessageDispatchController", () => {
  it("still sends after restoring a queued draft causes a render refresh", () => {
    let scheduled: () => void = () => {
      throw new Error("queue dispatch was not scheduled");
    };
    const restored: string[] = [];
    const removed: string[] = [];
    const firstSend = () => {
      throw new Error("stale send callback used");
    };
    const sent: string[] = [];
    const controller = createQueuedMessageDispatchController({
      requestFrame: (callback) => {
        scheduled = callback;
        return 1;
      },
      cancelFrame: () => undefined,
      restore: (message) => restored.push(message.id),
      remove: (message) => removed.push(message.id),
      send: firstSend,
    });

    controller.dispatch({ id: "queued-1" });
    controller.setSend(() => sent.push("queued-1"));
    scheduled();

    expect(restored).toEqual(["queued-1"]);
    expect(removed).toEqual(["queued-1"]);
    expect(sent).toEqual(["queued-1"]);
  });
});
