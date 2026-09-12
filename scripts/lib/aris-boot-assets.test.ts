// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

import {
  BRAND_ASSET_PATHS,
  DEVELOPMENT_ICON_OVERRIDES,
  DEVELOPMENT_PUBLIC_ICON_OVERRIDES,
  resolveWebAssetBrandForChannel,
  resolveWebAssetBrandForPackageVersion,
  resolveWebIconOverrides,
} from "./brand-assets.ts";

const repoRoot = NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../..");
const readBytes = (relativePath: string): Buffer =>
  NodeFS.readFileSync(NodePath.join(repoRoot, relativePath));
const readSource = (relativePath: string): string =>
  NodeFS.readFileSync(NodePath.join(repoRoot, relativePath), "utf8");

describe("ARIS boot assets", () => {
  it("ships the ARIS family under stable web filenames", () => {
    const pairs = [
      ["apps/web/public/apple-touch-icon.png", BRAND_ASSET_PATHS.jarvisWebAppleTouchIconPng],
      ["apps/web/public/favicon-16x16.png", BRAND_ASSET_PATHS.jarvisWebFavicon16Png],
      ["apps/web/public/favicon-32x32.png", BRAND_ASSET_PATHS.jarvisWebFavicon32Png],
      ["apps/web/public/favicon.ico", BRAND_ASSET_PATHS.jarvisWebFaviconIco],
    ] as const;
    for (const [target, source] of pairs) {
      expect(readBytes(target).equals(readBytes(source)), target).toBe(true);
    }
  });

  it("resolves every shipped channel and version to the ARIS brand", () => {
    expect(resolveWebAssetBrandForChannel("latest")).toBe("jarvis");
    expect(resolveWebAssetBrandForChannel("nightly")).toBe("jarvis");
    expect(resolveWebAssetBrandForPackageVersion("0.0.29")).toBe("jarvis");
    expect(resolveWebAssetBrandForPackageVersion("0.0.29-nightly.20260723.882")).toBe("jarvis");
    for (const override of [...DEVELOPMENT_ICON_OVERRIDES, ...DEVELOPMENT_PUBLIC_ICON_OVERRIDES]) {
      expect(override.sourceRelativePath).toMatch(/^assets\/jarvis\/jarvis-/);
    }
    for (const target of ["dist/client", "apps/web/dist", "apps/server/dist/client"]) {
      for (const override of resolveWebIconOverrides("jarvis", target)) {
        expect(override.sourceRelativePath).toMatch(/^assets\/jarvis\/jarvis-/);
      }
    }
  });

  it("points the boot loader at the ARIS-backed file", () => {
    // The React SplashScreen is deleted upstream; the shipping boot loader is
    // the inline boot shell in index.html. It must keep pointing at the
    // stable ARIS brand file.
    expect(readSource("apps/web/index.html")).toContain(
      '<img id="boot-shell-logo" src="/apple-touch-icon.png" alt="ARIS" />',
    );
  });
});
