// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../..",
);

const pureModules = [
  "command",
  "confirmation",
  "describeApproval",
  "requestIdentity",
  "buildProjectVocabulary",
  "buildPresentation",
  "groundVoiceTurn",
] as const;

describe("Jarvis core ownership", () => {
  it("keeps pure Jarvis modules out of the server source tree", () => {
    for (const moduleName of pureModules) {
      expect(
        NodeFS.existsSync(NodePath.join(repoRoot, "apps/server/src/jarvis", `${moduleName}.ts`)),
      ).toBe(false);
      expect(
        NodeFS.existsSync(NodePath.join(repoRoot, "packages/jarvis-core/src", `${moduleName}.ts`)),
      ).toBe(true);
    }
  });
});
