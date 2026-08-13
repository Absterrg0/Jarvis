// @effect-diagnostics nodeBuiltinImport:off - this regression test inspects the
// generated local data-URL surface without importing Electron's main process.
import { readFileSync } from "node:fs";

import { assert, describe, it } from "@effect/vitest";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

describe("companion setup surface", () => {
  it("uses one defaults form element for both the panel and submit listener", () => {
    const panelId = mainSource.match(/<form class="defaults-panel" id="([^"]+)"/u)?.[1];

    assert.equal(panelId, "defaults-panel");
    assert.match(
      mainSource,
      /const defaultsPanel=byId\('defaults-panel'\);const defaultsForm=defaultsPanel;/u,
    );
    assert.match(mainSource, /defaultsForm\.addEventListener\('submit'/u);
  });
});
