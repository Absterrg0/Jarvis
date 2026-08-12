import { assert, describe, it } from "@effect/vitest";

import { isRelayDocument } from "./relay.ts";

describe("Jarvis relay readiness", () => {
  it("acknowledges the app document without waiting for React to mount", () => {
    assert.isTrue(isRelayDocument("http://100.78.179.56:3773/"));
    assert.isTrue(isRelayDocument("https://jarvis-host.example.ts.net/"));
  });

  it("keeps the preload available through the pairing route and rejects non-network documents", () => {
    assert.isTrue(isRelayDocument("http://100.78.179.56:3773/pair#token=one-time"));
    assert.isFalse(isRelayDocument("data:text/html,relay"));
  });
});
