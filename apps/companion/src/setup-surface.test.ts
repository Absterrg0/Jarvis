// @effect-diagnostics nodeBuiltinImport:off - this regression test inspects the
// generated local data-URL surface without importing Electron's main process.
import * as NodeFS from "node:fs";

import { assert, describe, it } from "@effect/vitest";

const mainSource = NodeFS.readFileSync(new URL("./main.ts", import.meta.url), "utf8");

describe("companion setup surface", () => {
  it("uses finite motion beats instead of permanently repainting the overlay", () => {
    assert.notInclude(mainSource, "infinite alternate");
  });

  it("keeps the passive shortcut hint separate from supported voice actions", () => {
    assert.include(mainSource, '<div id="voice-hint" class="voice-hint"');
    assert.match(mainSource, /<button id="voice-action"[^>]+type="button"[^>]+hidden>/u);
    assert.include(
      mainSource,
      '<div id="voice-hint" class="voice-hint" aria-label="Voice shortcut"><span id="hint">Hold to talk</span><kbd>Ctrl + Shift + J</kbd></div>',
    );
    assert.include(
      mainSource,
      '<button id="voice-action" class="voice-hint voice-action" type="button" hidden><span id="action-hint"></span></button>',
    );
    assert.match(mainSource, /voiceAction\.addEventListener\('click'/u);
    assert.include(mainSource, "voiceActionKinds");
    assert.include(mainSource, "voiceAction.dataset.action==='stop-speaking'");
    assert.include(mainSource, "voiceAction.dataset.action==='open-host'");
    assert.include(mainSource, "void window.jarvisCompanion.bubbleReady();${voiceActionScript}`");
    assert.include(mainSource, "#voice-hint.voice-hint{cursor:default}");
    assert.include(mainSource, ".voice-action{appearance:none");
    assert.include(mainSource, ".presence-orb{transition:none}");
    assert.notInclude(mainSource, "script = script.replace(");
    assert.notInclude(mainSource, 'body[data-state="started"] .voice-hint');
    assert.notInclude(mainSource, 'body[data-state="error"] .voice-hint{cursor:pointer}');
  });

  it("does not emit the unused voice-orb CSS variants", () => {
    assert.notInclude(mainSource, ".voice-orb{");
    assert.include(mainSource, ".presence-orb{");
    assert.include(mainSource, 'const voiceSurfaceStyle = "";');
    assert.include(mainSource, 'const voiceSurfaceRefinementStyle = "";');
  });

  it("uses one defaults form element for both the panel and submit listener", () => {
    const panelId = mainSource.match(/<form class="defaults-panel" id="([^"]+)"/u)?.[1];

    assert.equal(panelId, "defaults-panel");
    assert.match(
      mainSource,
      /const defaultsPanel=byId\('defaults-panel'\);const defaultsForm=defaultsPanel;/u,
    );
    assert.match(mainSource, /defaultsForm\.addEventListener\('submit'/u);
  });

  it("keeps project routing out of setup and the hotkey configuration gate", () => {
    assert.notInclude(mainSource, "Project for new tasks");
    assert.notInclude(mainSource, "jarvis-companion:save-project");
    assert.notInclude(
      mainSource,
      "projectTarget: NonNullable<ReturnType<typeof loadSavedProject>>",
    );
    assert.include(mainSource, "await resolveProjectForTranscript(");
    assert.include(mainSource, "I don't have an exact task to continue yet.");
    assert.include(
      mainSource,
      "await resolveProjectContext(continuationTarget.projectId, continuationTarget.nodeId)",
    );
    assert.match(mainSource, /explicitlyStartsNewTask\s*\?\s*\{\}/u);
    // Project discovery belongs to voice routing, not setup. Its implementation
    // may legitimately share the main-process module with the setup surface.
    assert.notInclude(mainSource, "window.jarvisCompanion.getSetup?.()");
  });

  it("leaves visible ownership to Jarvis when launched as a managed helper", () => {
    assert.include(mainSource, 'process.argv.includes("--jarvis-managed")');
    assert.include(mainSource, "if (managedCompanionLaunch) return;");
  });
});
