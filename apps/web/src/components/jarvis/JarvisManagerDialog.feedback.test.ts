// @effect-diagnostics nodeBuiltinImport:off - this regression test verifies
// completion-report preparation ordering.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const reporterSource = NodeFS.readFileSync(
  new URL("./JarvisVoiceReporter.tsx", import.meta.url),
  "utf8",
);
const managerSource = NodeFS.readFileSync(
  new URL("./JarvisManagerDialog.tsx", import.meta.url),
  "utf8",
);

describe("Jarvis task-start feedback", () => {
  it("warms Kokoro before speaking a completed report", () => {
    const claim = reporterSource.indexOf("const claimResult = await claimSpeaker({");
    const prepare = reporterSource.indexOf("jarvisVoice.prepareSpeech()", claim);
    const speak = reporterSource.indexOf("speakReport(environmentId, report", claim);

    expect(claim).toBeGreaterThanOrEqual(0);
    expect(prepare).toBeGreaterThan(claim);
    expect(speak).toBeGreaterThan(prepare);
    expect(reporterSource.slice(prepare - 80, prepare)).not.toContain("await");
  });

  it("starts voice preparation and the cue before awaiting execution", () => {
    const execute = managerSource.indexOf("commandResult = await execution");
    const prepare = managerSource.lastIndexOf(
      "void window.desktopBridge?.jarvisVoice?.prepareSpeech()",
      execute,
    );
    const cue = managerSource.lastIndexOf("void playJarvisAcknowledgement()", execute);

    expect(execute).toBeGreaterThanOrEqual(0);
    expect(prepare).toBeGreaterThanOrEqual(0);
    expect(cue).toBeGreaterThanOrEqual(0);
    expect(prepare).toBeLessThan(execute);
    expect(cue).toBeLessThan(execute);
  });

  it("does not browser-fallback a deferred native utterance or call it paused", () => {
    expect(managerSource).toContain(
      'response.status === "failed" && (await desktopVoiceBridgeAllowsBrowserFallback())',
    );
    expect(reporterSource).not.toContain("Voice delivery is paused");
  });

  it("releases a speech lease after deferred or failed delivery and cools retries", () => {
    expect(reporterSource).toContain("const scheduleSpeechRetry = useCallback");
    expect(reporterSource).toContain("const deferSpeechRetry = useCallback");
    expect(reporterSource).toContain("window.setTimeout");
    expect(reporterSource).toContain('state.status === "ready"');
    expect(reporterSource).toContain("await releaseReportSpeech({");
    expect(reporterSource).toContain("retryAfter > Date.now()");
    expect(reporterSource).toContain('speechRetry.current.set(retryKey, "deferred")');
  });

  it("does not poll a competing speaker or re-speak after the initial delivery", () => {
    expect(reporterSource).toContain("const claimResult = await claimSpeaker({");
    expect(reporterSource).toContain('claimResult._tag === "Failure"');
    expect(reporterSource).not.toContain("const claimReport = () =>");
    expect(reporterSource).not.toContain("const speechResult = await retryJarvisDelivery");
    expect(reporterSource).toContain("const confirmation = await retryJarvisDelivery");
  });
});
