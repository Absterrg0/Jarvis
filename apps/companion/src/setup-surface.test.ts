// @effect-diagnostics nodeBuiltinImport:off - this regression test inspects the
// generated local data-URL surface without importing Electron's main process.
import { readFileSync } from "node:fs";

import { assert, describe, it } from "@effect/vitest";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

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

  it("requires an explicit persisted project target for new voice tasks", () => {
    assert.include(mainSource, "Project for new tasks");
    assert.include(mainSource, "jarvis-companion:save-project");
    assert.include(
      mainSource,
      "projectId: continuationTarget?.projectId ?? voiceDefault.projectTarget.id",
    );
    assert.include(mainSource, "I don't have an exact task to continue yet.");
    assert.include(mainSource, "await resolveProjectContext(continuationTarget.projectId)");
    assert.include(mainSource, "explicitlyStartsNewTask\n        ? {}\n        : { modelSelection");
    assert.include(mainSource, "Choose the project for new voice tasks before saving defaults.");
    assert.include(mainSource, "event.stopImmediatePropagation()");
    assert.include(mainSource, "const syncSave=()=>{if(savingProject||!select.value)");
  });
});
