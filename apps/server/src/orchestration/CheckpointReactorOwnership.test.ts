// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

const orchestrationDir = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));

describe("checkpoint reactor ownership", () => {
  it("keeps Jarvis concepts out of generic checkpoint production and tests", () => {
    for (const filename of ["CheckpointReactor.ts", "CheckpointReactor.test.ts"]) {
      const path = NodePath.join(orchestrationDir, "Layers", filename);
      expect(NodeFS.readFileSync(path, "utf8"), path).not.toMatch(/jarvis/iu);
    }
  });
});
