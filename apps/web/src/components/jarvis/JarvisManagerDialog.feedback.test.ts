// @effect-diagnostics nodeBuiltinImport:off - this regression test verifies
// the composition boundary between task-start feedback and live presentation.
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
  it("plays the semantic-start cue before requesting supervisor conversion", () => {
    const start = managerSource.indexOf("const execution = executeInstruction");
    const execute = managerSource.indexOf("commandResult = await execution");
    const prepare = managerSource.lastIndexOf(
      "void window.desktopBridge?.jarvisVoice?.prepareSpeech()",
      execute,
    );
    const cue = managerSource.lastIndexOf("void playJarvisAcknowledgement()", execute);

    expect(execute).toBeGreaterThanOrEqual(0);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(prepare).toBeGreaterThanOrEqual(0);
    expect(cue).toBeGreaterThanOrEqual(0);
    expect(prepare).toBeLessThan(start);
    expect(cue).toBeLessThan(prepare);
    expect(start).toBeLessThan(execute);
  });

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
