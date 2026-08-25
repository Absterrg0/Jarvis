import { assert, describe, it } from "@effect/vitest";

import { safeInlineJson } from "./inline-json.ts";

describe("safe inline JSON", () => {
  it("cannot close the enclosing script with hostile string data", () => {
    const payload = safeInlineJson({ nodeLabel: "</script><script>alert('xss')</script>" });

    assert.notInclude(payload.toLowerCase(), "</script>");
    assert.include(payload, "\\u003c/script\\u003e\\u003cscript\\u003e");
  });
});
