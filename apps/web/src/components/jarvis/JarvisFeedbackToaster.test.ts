import { describe, expect, it } from "vite-plus/test";

import { jarvisFeedbackToastType } from "./JarvisFeedbackToaster";

describe("jarvis feedback toasts", () => {
  it("maps every feedback kind to a visible toast channel", () => {
    expect(jarvisFeedbackToastType("working")).toBe("loading");
    expect(jarvisFeedbackToastType("done")).toBe("success");
    expect(jarvisFeedbackToastType("needs-input")).toBe("warning");
    expect(jarvisFeedbackToastType("error")).toBe("error");
  });
});
