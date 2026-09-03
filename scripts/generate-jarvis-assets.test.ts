// @effect-diagnostics nodeBuiltinImport:off

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = join(repoRoot, "assets/jarvis/jarvis-mark.svg");

const pngOutputs = [
  ["assets/jarvis/jarvis-master.png", 1254],
  ["assets/jarvis/jarvis-ios-1024.png", 1024],
  ["assets/jarvis/jarvis-macos-1024.png", 1024],
  ["assets/jarvis/jarvis-universal-1024.png", 1024],
  ["assets/jarvis/jarvis-web-favicon-16x16.png", 16],
  ["assets/jarvis/jarvis-web-favicon-32x32.png", 32],
  ["assets/jarvis/jarvis-web-apple-touch-180.png", 180],
  ["apps/web/public/jarvis-mark.png", 32],
] as const;

describe("Jarvis asset family", () => {
  it("keeps the source flat, geometric, and free of glossy effects", () => {
    const source = readFileSync(sourcePath, "utf8");
    expect(source).toContain('fill="#0D1217"');
    expect(source).toContain('fill="#F3F0E8"');
    expect(source).toContain('stroke="#43D6D3"');
    expect(source).not.toMatch(/gradient|filter|feGaussianBlur|purple|star|orb/iu);
  });

  it("keeps every tracked raster rendition at its contract size", () => {
    for (const [relativePath, size] of pngOutputs) {
      const outputPath = join(repoRoot, relativePath);
      expect(existsSync(outputPath), relativePath).toBe(true);
      const dimensions = execFileSync("magick", ["identify", "-format", "%wx%h", outputPath], {
        encoding: "utf8",
      });
      expect(dimensions, relativePath).toBe(`${size}x${size}`);
    }
  });

  it("can prove the tracked family was generated from the vector source", () => {
    expect(() =>
      execFileSync(process.execPath, ["scripts/generate-jarvis-assets.ts", "--check"], {
        cwd: repoRoot,
        stdio: "pipe",
      }),
    ).not.toThrow();
  });
});
