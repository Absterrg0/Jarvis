import { assert, describe, it } from "@effect/vitest";
import { EventEmitter } from "node:events";

import {
  attachPushToTalkHook,
  pushToTalkKeys,
  transitionPushToTalk,
  type PushToTalkKeyEvent,
} from "./push-to-talk.ts";

const heldJ: PushToTalkKeyEvent = {
  keycode: pushToTalkKeys.j,
  ctrlKey: true,
  shiftKey: true,
};

describe("push-to-talk hotkey", () => {
  it("starts only when Ctrl+Shift+J is pressed and stops when J is released", () => {
    const idle = { active: false };
    assert.equal(
      transitionPushToTalk(idle, "keydown", { ...heldJ, shiftKey: false }).action,
      undefined,
    );
    const pressed = transitionPushToTalk(idle, "keydown", heldJ);
    assert.equal(pressed.action, "pressed");
    assert.equal(transitionPushToTalk(pressed.state, "keyup", heldJ).action, "released");
  });

  it("does not double-start from key repeat and releases if a modifier lifts first", () => {
    const pressed = transitionPushToTalk({ active: false }, "keydown", heldJ);
    assert.equal(transitionPushToTalk(pressed.state, "keydown", heldJ).action, undefined);
    assert.equal(
      transitionPushToTalk(pressed.state, "keyup", {
        keycode: pushToTalkKeys.control,
        ctrlKey: false,
        shiftKey: true,
      }).action,
      "released",
    );
  });

  it("exposes only press/release edges to the companion", () => {
    class FakeHook extends EventEmitter {
      started = false;
      stopped = false;
      start() {
        this.started = true;
      }
      stop() {
        this.stopped = true;
      }
    }
    const hook = new FakeHook();
    const actions: Array<string> = [];
    const detach = attachPushToTalkHook({
      hook,
      onPressed: () => actions.push("pressed"),
      onReleased: () => actions.push("released"),
    });

    hook.emit("keydown", heldJ);
    hook.emit("keydown", heldJ);
    hook.emit("keyup", heldJ);
    detach();

    assert.isTrue(hook.started);
    assert.isTrue(hook.stopped);
    assert.deepEqual(actions, ["pressed", "released"]);
  });
});
