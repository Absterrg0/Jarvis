// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

describe("release smoke fixture", () => {
  it("copies every workspace package required by the desktop release", () => {
    const source = NodeFS.readFileSync(
      NodePath.resolve(process.cwd(), "scripts/release-smoke.ts"),
      "utf8",
    );

    expect(source).toContain('"packages/jarvis-native-voice/package.json"');
  });
});
