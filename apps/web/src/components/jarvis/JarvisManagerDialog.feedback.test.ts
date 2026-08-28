// @effect-diagnostics nodeBuiltinImport:off - this regression test verifies
// that visible and spoken feedback happens before the network dispatch.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const source = NodeFS.readFileSync(new URL("./JarvisManagerDialog.tsx", import.meta.url), "utf8");
const reporterSource = NodeFS.readFileSync(
  new URL("./JarvisVoiceReporter.tsx", import.meta.url),
  "utf8",
);

describe("Jarvis task-start feedback", () => {
  it("shows status and plays the acknowledgement cue before Host dispatch", () => {
    const submitStart = source.indexOf("const submit = useCallback");
    const submitEnd = source.indexOf("const retryVoiceSubmission", submitStart);
    const submit = source.slice(submitStart, submitEnd);
    const visual = submit.indexOf('reportCompanionStatus("Starting now", instruction, "started")');
    const cue = submit.indexOf("playJarvisAcknowledgement()");
    const dispatch = submit.indexOf("await executeInstruction");

    expect(submitStart).toBeGreaterThanOrEqual(0);
    expect(visual).toBeGreaterThanOrEqual(0);
    expect(cue).toBeGreaterThan(visual);
    expect(dispatch).toBeGreaterThan(cue);
  });

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
