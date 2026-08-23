// @effect-diagnostics nodeBuiltinImport:off - this regression test inspects
// the disposable worker and standalone smoke configuration without importing
// Electron or starting the native speech runtime.
import * as NodeFS from "node:fs";

import { assert, describe, it } from "@effect/vitest";

const workerSource = NodeFS.readFileSync(new URL("./kokoro-worker.ts", import.meta.url), "utf8");
const smokeSource = NodeFS.readFileSync(
  new URL("../scripts/smoke-speech-runtime.mjs", import.meta.url),
  "utf8",
);

describe("Kokoro Electron buffer compatibility", () => {
  it("keeps production synthesis in V8-owned buffers", () => {
    assert.include(workerSource, "enableExternalBuffer: false");
    assert.notInclude(workerSource, "enableExternalBuffer: true");
  });

  it("keeps standalone runtime smoke aligned with production", () => {
    assert.include(smokeSource, "enableExternalBuffer: false");
    assert.notInclude(smokeSource, "enableExternalBuffer: true");
  });
});
