// @effect-diagnostics nodeBuiltinImport:off - this regression inspects provider source ownership.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

const providerRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../provider",
);

const sourceFiles = (directory: string): string[] =>
  NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(path)
      : path.endsWith(".ts") || path.endsWith(".mjs")
        ? [path]
        : [];
  });

describe("provider ownership", () => {
  it("keeps Jarvis concepts out of provider internals", () => {
    for (const sourcePath of sourceFiles(providerRoot)) {
      expect(NodeFS.readFileSync(sourcePath, "utf8"), sourcePath).not.toMatch(/jarvis/iu);
    }
  });
});
