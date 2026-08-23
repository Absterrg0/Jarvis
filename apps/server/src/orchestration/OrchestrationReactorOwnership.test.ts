// @effect-diagnostics nodeBuiltinImport:off - this regression inspects source ownership.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

const reactorPath = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "Layers/OrchestrationReactor.ts",
);

describe("orchestration reactor ownership", () => {
  it("keeps Jarvis concepts out of the generic reactor", () => {
    expect(NodeFS.readFileSync(reactorPath, "utf8"), reactorPath).not.toMatch(/jarvis/iu);
  });
});
