import { assert, describe, it } from "@effect/vitest";

import {
  companionOriginInteractionIdArgument,
  parseCompanionOriginInteractionId,
} from "./origin-interaction.ts";

describe("companion origin interaction bridge", () => {
  it("round-trips the installation identity through relay renderer arguments", () => {
    const argument = companionOriginInteractionIdArgument("origin-installation-1");
    assert.equal(
      parseCompanionOriginInteractionId(["electron", argument]),
      "origin-installation-1",
    );
  });

  it("ignores a missing or empty bridge argument", () => {
    assert.isUndefined(parseCompanionOriginInteractionId(["electron"]));
    assert.isUndefined(parseCompanionOriginInteractionId(["--jarvis-origin-interaction-id="]));
  });
});
