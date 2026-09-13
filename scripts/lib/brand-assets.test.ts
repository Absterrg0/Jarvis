import { describe, expect, it } from "vite-plus/test";

import {
  BRAND_ASSET_PATHS,
  DEVELOPMENT_ICON_OVERRIDES,
  DEVELOPMENT_PUBLIC_ICON_OVERRIDES,
  resolveWebAssetBrandForChannel,
  resolveWebAssetBrandForPackageVersion,
  resolveWebIconOverrides,
} from "./brand-assets.ts";

describe("brand-assets", () => {
  it("maps production web assets into the server package", () => {
    expect(resolveWebIconOverrides("production", "dist/client")).toEqual([
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebFaviconIco,
        targetRelativePath: "dist/client/favicon.ico",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebFavicon16Png,
        targetRelativePath: "dist/client/favicon-16x16.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebFavicon32Png,
        targetRelativePath: "dist/client/favicon-32x32.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
        targetRelativePath: "dist/client/apple-touch-icon.png",
      },
    ]);
  });

  it("maps server build web assets to Circe icons", () => {
    expect(DEVELOPMENT_ICON_OVERRIDES[0]).toEqual({
      sourceRelativePath: BRAND_ASSET_PATHS.circeWebFaviconIco,
      targetRelativePath: "dist/client/favicon.ico",
    });
  });

  it("maps development web assets to the Circe splash and favicon files", () => {
    expect(DEVELOPMENT_PUBLIC_ICON_OVERRIDES).toEqual([
      {
        sourceRelativePath: BRAND_ASSET_PATHS.circeWebFaviconIco,
        targetRelativePath: "apps/web/public/favicon.ico",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.circeWebFavicon16Png,
        targetRelativePath: "apps/web/public/favicon-16x16.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.circeWebFavicon32Png,
        targetRelativePath: "apps/web/public/favicon-32x32.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.circeWebAppleTouchIconPng,
        targetRelativePath: "apps/web/public/apple-touch-icon.png",
      },
    ]);
  });

  it("can target hosted web dist directly", () => {
    expect(resolveWebIconOverrides("production", "apps/web/dist")).toContainEqual({
      sourceRelativePath: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
      targetRelativePath: "apps/web/dist/apple-touch-icon.png",
    });
  });

  it("maps hosted nightly web assets to nightly icons", () => {
    expect(resolveWebIconOverrides("nightly", "apps/web/dist")).toContainEqual({
      sourceRelativePath: BRAND_ASSET_PATHS.nightlyWebFaviconIco,
      targetRelativePath: "apps/web/dist/favicon.ico",
    });
  });

  it("maps hosted release channels to the Circe brand", () => {
    expect(resolveWebAssetBrandForChannel("latest")).toBe("circe");
    expect(resolveWebAssetBrandForChannel("nightly")).toBe("circe");
  });

  it("maps package versions to the Circe brand", () => {
    expect(resolveWebAssetBrandForPackageVersion("0.0.29")).toBe("circe");
    expect(resolveWebAssetBrandForPackageVersion("0.0.29-nightly.20260723.882")).toBe("circe");
  });

  it("keeps development, nightly, and production icon families separate", () => {
    expect([
      BRAND_ASSET_PATHS.developmentIconComposerProject,
      BRAND_ASSET_PATHS.nightlyIconComposerProject,
      BRAND_ASSET_PATHS.productionIconComposerProject,
    ]).toEqual([
      "assets/dev/app-icon.icon",
      "assets/nightly/app-icon.icon",
      "assets/prod/app-icon.icon",
    ]);
    expect(BRAND_ASSET_PATHS.developmentDesktopIconPng).toMatch(/^assets\/dev\/blueprint-/);
    expect(BRAND_ASSET_PATHS.nightlyMacIconPng).toMatch(/^assets\/nightly\/nightly-/);
    expect(BRAND_ASSET_PATHS.productionMacIconPng).toMatch(/^assets\/prod\/black-/);
  });

  it("keeps the Circe desktop family separate from hosted T3 channel assets", () => {
    expect(BRAND_ASSET_PATHS.circeMasterPng).toBe("assets/circe/circe-master.png");
    expect(BRAND_ASSET_PATHS.circeMacIconPng).toMatch(/^assets\/circe\/circe-/);
    expect(BRAND_ASSET_PATHS.circeWindowsIconIco).toMatch(/^assets\/circe\/circe-/);
    expect(BRAND_ASSET_PATHS.circeWebFaviconIco).not.toBe(
      BRAND_ASSET_PATHS.productionWebFaviconIco,
    );
    expect(resolveWebIconOverrides("circe", "apps/server/dist/client")).toEqual([
      {
        sourceRelativePath: BRAND_ASSET_PATHS.circeWebFaviconIco,
        targetRelativePath: "apps/server/dist/client/favicon.ico",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.circeWebFavicon16Png,
        targetRelativePath: "apps/server/dist/client/favicon-16x16.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.circeWebFavicon32Png,
        targetRelativePath: "apps/server/dist/client/favicon-32x32.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.circeWebAppleTouchIconPng,
        targetRelativePath: "apps/server/dist/client/apple-touch-icon.png",
      },
    ]);
  });
});
