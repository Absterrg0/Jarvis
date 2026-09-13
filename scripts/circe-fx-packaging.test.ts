import { describe, expect, it } from "vite-plus/test";

import {
  DESKTOP_FX_EXTRA_RESOURCE,
  CIRCE_FX_RESOURCE_DIR,
  circeFxReleaseAsset,
} from "./circe-fx-packaging.ts";
import { bundlesCirceFxResources } from "./build-desktop-artifact.ts";

describe("circe fx packaging", () => {
  it("maps each published platform and arch to its release asset", () => {
    expect(circeFxReleaseAsset("linux", "x64")).toBe("fx-linux-x86_64.tar.gz");
    expect(circeFxReleaseAsset("linux", "arm64")).toBe("fx-linux-aarch64.tar.gz");
    expect(circeFxReleaseAsset("mac", "x64")).toBe("fx-macos-x86_64.tar.gz");
    expect(circeFxReleaseAsset("mac", "arm64")).toBe("fx-macos-aarch64.tar.gz");
    expect(circeFxReleaseAsset("win", "x64")).toBeNull();
  });

  it("stages into the prod-resources fx directory the artifact expects", () => {
    expect(DESKTOP_FX_EXTRA_RESOURCE.from).toBe(
      `apps/desktop/prod-resources/${CIRCE_FX_RESOURCE_DIR}`,
    );
    expect(DESKTOP_FX_EXTRA_RESOURCE.to).toBe(CIRCE_FX_RESOURCE_DIR);
  });

  it("bundles only where fx publishes a single binary", () => {
    expect(bundlesCirceFxResources({ platform: "linux", arch: "x64" })).toBe(false);
    expect(bundlesCirceFxResources({ platform: "mac", arch: "arm64" })).toBe(false);
    expect(bundlesCirceFxResources({ platform: "win", arch: "x64" })).toBe(false);
    expect(bundlesCirceFxResources({ platform: "mac", arch: "universal" })).toBe(false);
  });
});
