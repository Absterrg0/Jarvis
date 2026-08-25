// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

describe("release smoke fixture", () => {
  it("copies every workspace package required by the desktop release", () => {
    const source = NodeFS.readFileSync(NodePath.join(repoRoot, "scripts/release-smoke.ts"), "utf8");

    expect(source).toContain('"packages/jarvis-native-voice/package.json"');
    expect(source).not.toContain("jarvis-native-microphone");
    expect(source).toContain('"packages/jarvis-client-runtime/package.json"');
    expect(source).toContain('"packages/jarvis-core/package.json"');
  });
});
