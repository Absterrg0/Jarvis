import { describe, expect, it } from "vite-plus/test";

import {
  DESKTOP_FX_EXTRA_RESOURCE,
  JARVIS_FX_RESOURCE_DIR,
  jarvisFxReleaseAsset,
} from "./jarvis-fx-packaging.ts";
import { bundlesJarvisFxResources } from "./build-desktop-artifact.ts";

describe("jarvis fx packaging", () => {
  it("maps each published platform and arch to its release asset", () => {
    expect(jarvisFxReleaseAsset("linux", "x64")).toBe("fx-linux-x86_64.tar.gz");
    expect(jarvisFxReleaseAsset("linux", "arm64")).toBe("fx-linux-aarch64.tar.gz");
    expect(jarvisFxReleaseAsset("mac", "x64")).toBe("fx-macos-x86_64.tar.gz");
    expect(jarvisFxReleaseAsset("mac", "arm64")).toBe("fx-macos-aarch64.tar.gz");
    expect(jarvisFxReleaseAsset("win", "x64")).toBeNull();
  });

  it("stages into the prod-resources fx directory the artifact expects", () => {
    expect(DESKTOP_FX_EXTRA_RESOURCE.from).toBe(
      `apps/desktop/prod-resources/${JARVIS_FX_RESOURCE_DIR}`,
    );
    expect(DESKTOP_FX_EXTRA_RESOURCE.to).toBe(JARVIS_FX_RESOURCE_DIR);
  });

  it("bundles only where fx publishes a single binary", () => {
    expect(bundlesJarvisFxResources({ platform: "linux", arch: "x64" })).toBe(false);
    expect(bundlesJarvisFxResources({ platform: "mac", arch: "arm64" })).toBe(false);
    expect(bundlesJarvisFxResources({ platform: "win", arch: "x64" })).toBe(false);
    expect(bundlesJarvisFxResources({ platform: "mac", arch: "universal" })).toBe(false);
  });
});
