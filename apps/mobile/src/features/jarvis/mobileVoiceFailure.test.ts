import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { mobileVoiceFailureMessage } from "./mobileVoiceFailure";

describe("mobile Jarvis voice failures", () => {
  it("shows the typed RPC failure instead of replacing it with a generic message", () => {
    const result = AsyncResult.failure(Cause.fail(new Error("Native voice worker exited.")));

    expect(mobileVoiceFailureMessage(result)).toBe("Native voice worker exited.");
  });
});
