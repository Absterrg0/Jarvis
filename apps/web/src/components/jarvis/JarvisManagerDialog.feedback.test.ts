// @effect-diagnostics nodeBuiltinImport:off - this regression test verifies
// completion-report preparation ordering.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const reporterSource = NodeFS.readFileSync(
  new URL("./JarvisVoiceReporter.tsx", import.meta.url),
  "utf8",
);

describe("Jarvis task-start feedback", () => {
  it("warms Kokoro before speaking a completed report", () => {
    const claim = reporterSource.indexOf("const claimResult = await claimReport()");
    const prepare = reporterSource.indexOf("jarvisVoice.prepareSpeech()", claim);
    const speak = reporterSource.indexOf("speakReport(environmentId, report", claim);

    expect(claim).toBeGreaterThanOrEqual(0);
    expect(prepare).toBeGreaterThan(claim);
    expect(speak).toBeGreaterThan(prepare);
    expect(reporterSource.slice(prepare - 80, prepare)).not.toContain("await");
  });
});
