import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  getJarvisCommandExchanges,
  onJarvisCommandExchanges,
  publishJarvisCommandExchange,
  resetJarvisCommandBusForTests,
} from "./jarvisBus";

describe("Jarvis command exchanges", () => {
  afterEach(() => {
    resetJarvisCommandBusForTests();
  });

  it("keeps a bounded user/assistant transcript for the console", () => {
    publishJarvisCommandExchange({ role: "user", text: "what is new today?", kind: "heard" });
    publishJarvisCommandExchange({ role: "aris", text: "Nothing yet.", kind: "done" });
    expect(getJarvisCommandExchanges().map((entry) => [entry.role, entry.text])).toEqual([
      ["user", "what is new today?"],
      ["aris", "Nothing yet."],
    ]);
  });

  it("drops empty text and trims stored lines", () => {
    publishJarvisCommandExchange({ role: "user", text: "   ", kind: "heard" });
    publishJarvisCommandExchange({ role: "aris", text: "  answer  ", kind: "done" });
    expect(getJarvisCommandExchanges()).toEqual([
      expect.objectContaining({ role: "aris", text: "answer" }),
    ]);
  });

  it("bounds history so a long session cannot grow without limit", () => {
    for (let index = 0; index < 40; index += 1) {
      publishJarvisCommandExchange({ role: "user", text: `line ${index}`, kind: "heard" });
    }
    const entries = getJarvisCommandExchanges();
    expect(entries).toHaveLength(16);
    expect(entries[0]?.text).toBe("line 24");
    expect(entries.at(-1)?.text).toBe("line 39");
  });

  it("notifies subscribers on every append and stops after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = onJarvisCommandExchanges(listener);
    publishJarvisCommandExchange({ role: "user", text: "one", kind: "heard" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toHaveLength(1);
    unsubscribe();
    publishJarvisCommandExchange({ role: "aris", text: "two", kind: "done" });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
