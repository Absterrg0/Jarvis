import { assert, describe, it } from "@effect/vitest";

import {
  companionOriginInteractionIdArgument,
  companionOriginNodeIdForInstallation,
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

  it("derives a stable origin node without using the paired execution host", () => {
    assert.equal(
      companionOriginNodeIdForInstallation("origin-installation-1"),
      "companion-origin:origin-installation-1",
    );
    assert.equal(
      companionOriginNodeIdForInstallation(" origin-installation-1 "),
      companionOriginNodeIdForInstallation("origin-installation-1"),
    );
    assert.notEqual(
      companionOriginNodeIdForInstallation("origin-installation-1"),
      "environment-desktop",
    );
  });
});
