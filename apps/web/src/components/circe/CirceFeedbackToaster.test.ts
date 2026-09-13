import { describe, expect, it } from "vite-plus/test";

import { circeFeedbackToastType } from "./CirceFeedbackToaster";

describe("circe feedback toasts", () => {
  it("maps every feedback kind to a visible toast channel", () => {
    expect(circeFeedbackToastType("working")).toBe("loading");
    expect(circeFeedbackToastType("done")).toBe("success");
    expect(circeFeedbackToastType("needs-input")).toBe("warning");
    expect(circeFeedbackToastType("error")).toBe("error");
  });
});
