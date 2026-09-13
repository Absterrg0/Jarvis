import { assert, it } from "@effect/vitest";

import { formatDesktopStartupErrorTitle } from "./DesktopApp.ts";

it("uses Circe branding in the fatal startup dialog", () => {
  const title = formatDesktopStartupErrorTitle("Circe");
  assert.equal(title, "Circe failed to start");
  assert.notInclude(title, "T3 Code");
});
