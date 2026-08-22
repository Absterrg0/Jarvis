import { assert, describe, it } from "@effect/vitest";

import { reportConnectionPresentation } from "./report-connection.ts";

describe("Companion task connection presentation", () => {
  it("uses task language and makes a failed connection retryable", () => {
    assert.deepEqual(
      reportConnectionPresentation({ phase: "error", detail: "Host did not answer" }),
      { label: "Task connection needs attention", action: "retry" },
    );
  });

  it("makes a lost pairing actionable without presenting it as a task failure", () => {
    assert.deepEqual(reportConnectionPresentation({ phase: "needs-pairing" }), {
      label: "Task connection needs pairing",
      action: "pair",
    });
  });
});
