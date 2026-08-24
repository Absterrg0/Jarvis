import { assert, it } from "@effect/vitest";

import { formatDesktopStartupErrorTitle } from "./DesktopApp.ts";

it("uses Jarvis branding in the fatal startup dialog", () => {
  const title = formatDesktopStartupErrorTitle("Jarvis");
  assert.equal(title, "Jarvis failed to start");
  assert.notInclude(title, "T3 Code");
});
