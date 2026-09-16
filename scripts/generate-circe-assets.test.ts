// @effect-diagnostics nodeBuiltinImport:off

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

const repoRoot = NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const sourcePath = NodePath.join(repoRoot, "assets/circe/circe-mark.svg");

function hasMagick(): boolean {
  try {
    NodeChildProcess.execFileSync("magick", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// Raster currency is byte-exact against ImageMagick 7 output, and other
// versions render different bytes, so these run only where magick exists.
// The SVG style pins below always run.
const itWithMagick = hasMagick() ? it : it.skip;

const pngOutputs = [
  ["assets/circe/circe-master.png", 1254],
  ["assets/circe/circe-ios-1024.png", 1024],
  ["assets/circe/circe-macos-1024.png", 1024],
  ["assets/circe/circe-universal-1024.png", 1024],
  ["assets/circe/circe-web-favicon-16x16.png", 16],
  ["assets/circe/circe-web-favicon-32x32.png", 32],
  ["assets/circe/circe-web-apple-touch-180.png", 180],
  ["apps/web/public/circe-mark.png", 32],
] as const;

describe("Circe asset family", () => {
  it("keeps the approved rose-gold mark as the vector source", () => {
    const source = NodeFS.readFileSync(sourcePath, "utf8");
    // The approved mark embeds its raster artwork so the gradient matches the
    // brand board exactly instead of approximating it with an auto-trace.
    expect(source).toContain("data:image/png;base64,");
    expect(source).toContain('aria-label="Circe logo"');
    // The retired teal-signal mark must not come back. Strip the embedded
    // base64 payload first so random encoded bytes cannot trip the matcher.
    const markup = source.replace(/data:image\/png;base64,[A-Za-z0-9+/=]+/gu, "");
    expect(markup).not.toContain("#43D6D3");
    expect(markup).not.toMatch(/purple|star|orb/iu);
  });

  itWithMagick("keeps every tracked raster rendition at its contract size", () => {
    for (const [relativePath, size] of pngOutputs) {
      const outputPath = NodePath.join(repoRoot, relativePath);
      expect(NodeFS.existsSync(outputPath), relativePath).toBe(true);
      const dimensions = NodeChildProcess.execFileSync(
        "magick",
        ["identify", "-format", "%wx%h", outputPath],
        {
          encoding: "utf8",
        },
      );
      expect(dimensions, relativePath).toBe(`${size}x${size}`);
    }
  });

  itWithMagick("can prove the tracked family was generated from the vector source", () => {
    expect(() =>
      NodeChildProcess.execFileSync(
        process.execPath,
        ["scripts/generate-circe-assets.ts", "--check"],
        {
          cwd: repoRoot,
          stdio: "pipe",
        },
      ),
    ).not.toThrow();
  });
});
