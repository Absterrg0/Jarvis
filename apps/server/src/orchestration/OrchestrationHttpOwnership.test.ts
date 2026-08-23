// @effect-diagnostics nodeBuiltinImport:off - this regression inspects source ownership.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

const orchestrationHttpPath = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "http.ts",
);

describe("orchestration HTTP ownership", () => {
  it("keeps Jarvis concepts out of the generic HTTP handlers", () => {
    expect(NodeFS.readFileSync(orchestrationHttpPath, "utf8"), orchestrationHttpPath).not.toMatch(
      /jarvis/iu,
    );
  });
});
