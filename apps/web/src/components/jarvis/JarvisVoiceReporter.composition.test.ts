// @effect-diagnostics nodeBuiltinImport:off - this regression test verifies
// the composition boundary between task-start feedback and live presentation.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const reporterSource = NodeFS.readFileSync(
  new URL("./JarvisVoiceReporter.tsx", import.meta.url),
  "utf8",
);
describe("Jarvis presentation composition", () => {
  it("subscribes to live origin presentations without durable delivery machinery", () => {
    expect(reporterSource).toContain("jarvisEnvironment.presentations");
    expect(reporterSource).toContain("rememberBoundedPresentationId");
    expect(reporterSource).not.toContain("claimSpeaker");
    expect(reporterSource).not.toContain("acknowledgeReport");
    expect(reporterSource).not.toContain("releaseReportSpeech");
    expect(reporterSource).not.toContain("setTimeout");
    expect(reporterSource).not.toContain("localStorage");
  });
});
