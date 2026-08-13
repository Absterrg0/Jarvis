import { assert, describe, it } from "@effect/vitest";

import { isTrustedRelayNavigation } from "./relay-security.ts";

describe("report relay navigation", () => {
  it("keeps the report bridge on the paired host origin", () => {
    const pairedHost = "https://jarvis-host.tailnet.ts.net/";

    assert.isTrue(
      isTrustedRelayNavigation({
        pairedHost,
        destination: "https://jarvis-host.tailnet.ts.net/#/pair",
      }),
    );
    assert.isFalse(
      isTrustedRelayNavigation({
        pairedHost,
        destination: "https://unexpected.example/",
      }),
    );
    assert.isFalse(isTrustedRelayNavigation({ pairedHost: null, destination: pairedHost }));
  });
});
