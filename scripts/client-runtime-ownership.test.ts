// @effect-diagnostics nodeBuiltinImport:off - this ownership regression inspects package files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

const packageRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../packages/client-runtime",
);

const sourceFiles = (directory: string): string[] =>
  NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });

describe("T3 client-runtime Circe ownership", () => {
  it("has no Circe modules or Circe exports", () => {
    const packageJson = JSON.parse(
      NodeFS.readFileSync(NodePath.join(packageRoot, "package.json"), "utf8"),
    ) as { readonly exports?: Record<string, unknown> };
    const exports = Object.keys(packageJson.exports ?? {});

    expect(NodeFS.existsSync(NodePath.join(packageRoot, "src/circe"))).toBe(false);
    expect(
      NodeFS.readdirSync(NodePath.join(packageRoot, "src/operations")).some((name) =>
        name.toLowerCase().includes("circe"),
      ),
    ).toBe(false);
    expect(exports.some((name) => name.toLowerCase().includes("circe"))).toBe(false);
    for (const sourcePath of sourceFiles(NodePath.join(packageRoot, "src"))) {
      if (sourcePath.endsWith(`${NodePath.sep}rpc${NodePath.sep}client.ts`)) continue;
      const source = NodeFS.readFileSync(sourcePath, "utf8");
      // Product copy may name Circe, but the upstream package must not depend on
      // or re-export Circe-owned code, and must never carry the retired codename.
      expect(source, sourcePath).not.toMatch(/@circe\//iu);
      expect(source, sourcePath).not.toMatch(/jarvis/iu);
    }
    expect(
      NodeFS.readFileSync(NodePath.join(packageRoot, "src/operations/index.ts"), "utf8"),
    ).not.toContain("circe");
  });
});
