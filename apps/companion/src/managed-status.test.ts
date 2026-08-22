import { assert, describe, it } from "@effect/vitest";

import {
  managedErrorPrefix,
  managedPairedPrefix,
  managedReadyPrefix,
  managedStatusLine,
} from "./managed-status.ts";

describe("managed Companion stdout contract", () => {
  it("uses stable bounded lines and never includes a pairing secret", () => {
    assert.equal(managedStatusLine("READY"), managedReadyPrefix);
    assert.equal(managedStatusLine("PAIRED"), managedPairedPrefix);
    const error = managedStatusLine("ERROR", "pairing failed #token=secret");
    assert.equal(error, `${managedErrorPrefix} pairing_failed__token_secret`);
    assert.isAtMost(error.length, managedErrorPrefix.length + 65);
  });
});
