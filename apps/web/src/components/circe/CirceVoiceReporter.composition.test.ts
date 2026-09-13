// @effect-diagnostics nodeBuiltinImport:off - this regression test verifies
// the composition boundary between task-start feedback and live presentation.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const reporterSource = NodeFS.readFileSync(
  new URL("./CirceVoiceReporter.tsx", import.meta.url),
  "utf8",
);
describe("Circe presentation composition", () => {
  it("subscribes to live origin presentations without durable delivery machinery", () => {
    expect(reporterSource).toContain("circeEnvironment.presentations");
    expect(reporterSource).toContain("rememberBoundedPresentationId");
    expect(reporterSource).not.toContain("claimSpeaker");
    expect(reporterSource).not.toContain("acknowledgeReport");
    expect(reporterSource).not.toContain("releaseReportSpeech");
    expect(reporterSource).not.toContain("setTimeout");
    expect(reporterSource).not.toContain("localStorage");
  });

  it("publishes terminal taskRef and turnId for cross-lane speech relevance", () => {
    expect(reporterSource).toContain("publishCirceSpeechTerminal");
    expect(reporterSource).toContain("onTerminal");
    expect(reporterSource).not.toContain("claimSpeaker");
    expect(reporterSource).not.toContain("acknowledgeReport");
  });
});
