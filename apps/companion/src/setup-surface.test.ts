// @effect-diagnostics nodeBuiltinImport:off - this regression test inspects the
// generated local data-URL surface without importing Electron's main process.
import * as NodeFS from "node:fs";

import { assert, describe, it } from "@effect/vitest";

const mainSource = NodeFS.readFileSync(new URL("./main.ts", import.meta.url), "utf8");

describe("companion setup surface", () => {
  it("uses finite motion beats instead of permanently repainting the overlay", () => {
    assert.notInclude(mainSource, "infinite alternate");
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
});
