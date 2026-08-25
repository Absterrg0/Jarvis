// @effect-diagnostics nodeBuiltinImport:off -- this test inspects package metadata only.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, describe, it } from "@effect/vitest";

const packageJson = JSON.parse(
  NodeFS.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
  readonly desktopName?: unknown;
  readonly scripts?: Record<string, unknown>;
  readonly dependencies?: Record<string, unknown>;
  readonly build?: {
    readonly directories?: { readonly buildResources?: unknown };
    readonly extraResources?: ReadonlyArray<{ readonly from?: unknown; readonly to?: unknown }>;
    readonly artifactName?: unknown;
    readonly asarUnpack?: unknown;
    readonly linux?: {
      readonly target?: unknown;
      readonly category?: unknown;
      readonly icon?: unknown;
      readonly executableName?: unknown;
      readonly syncDesktopName?: unknown;
      readonly files?: unknown;
    };
    readonly win?: {
      readonly target?: unknown;
      readonly executableName?: unknown;
      readonly icon?: unknown;
      readonly files?: unknown;
    };
  };
};
const companionRoot = NodeURL.fileURLToPath(new URL("..", import.meta.url));

describe("Companion Linux packaging", () => {
  it("publishes a reproducible x64 AppImage command", () => {
    assert.equal(
      packageJson.scripts?.["package:linux"],
      "pnpm run build && electron-builder --linux AppImage --x64",
    );
    assert.equal(
      packageJson.scripts?.["package:linux:ci"],
      "pnpm run build && electron-builder --linux AppImage --x64 --publish never",
    );
  });

  it("keeps only target-platform native runtime files", () => {
    const linux = packageJson.build?.linux;
    const win = packageJson.build?.win;
    assert.equal(packageJson.desktopName, "jarvis-companion.desktop");
    assert.equal(packageJson.build?.directories?.buildResources, "../../assets/jarvis");
    assert.isTrue(
      packageJson.build?.extraResources?.some(
        (resource) =>
          resource.from === "../../assets/jarvis/jarvis-universal-1024.png" &&
          resource.to === "icon.png",
      ),
    );
    assert.equal(packageJson.dependencies?.["@t3tools/jarvis-native-microphone"], "workspace:*");
    assert.isUndefined(packageJson.dependencies?.["node-cpal"]);
    assert.equal(packageJson.dependencies?.["sherpa-onnx-linux-x64"], "1.13.6");
    assert.deepEqual(linux?.target, [{ target: "AppImage", arch: ["x64"] }]);
    assert.equal(linux?.category, "Utility");
    assert.equal(linux?.icon, "../../assets/jarvis/jarvis-universal-1024.png");
    const configuredIcon =
      typeof linux?.icon === "string" ? NodePath.resolve(companionRoot, linux.icon) : undefined;
    assert.equal(
      configuredIcon,
      NodePath.resolve(companionRoot, "../../assets/jarvis/jarvis-universal-1024.png"),
    );
    assert.isTrue(configuredIcon !== undefined && NodeFS.statSync(configuredIcon).isFile());
    assert.equal(packageJson.build?.win?.icon, "../../assets/jarvis/jarvis-windows.ico");
    const windowsIcon =
      typeof packageJson.build?.win?.icon === "string"
        ? NodePath.resolve(companionRoot, packageJson.build.win.icon)
        : undefined;
    assert.isTrue(windowsIcon !== undefined && NodeFS.statSync(windowsIcon).isFile());
    assert.equal(linux?.executableName, "jarvis-companion");
    assert.isTrue(linux?.syncDesktopName);
    assert.include(linux?.files, "dist-electron/**");
    assert.include(linux?.files, "package.json");
    assert.include(linux?.files, "!**/sherpa-onnx-win-x64/**");
    assert.include(
      linux?.files,
      "!**/node_modules/@t3tools/jarvis-native-microphone/bin/win32-x64/**",
    );
    assert.include(linux?.files, "!**/node_modules/uiohook-napi/prebuilds/win32-x64/**");
    assert.include(linux?.files, "!**/node_modules/uiohook-napi/src/**");
    assert.include(linux?.files, "!**/node_modules/uiohook-napi/libuiohook/**");
    assert.deepEqual(win?.target, [{ target: "nsis", arch: ["x64"] }]);
    assert.equal(win?.executableName, "Jarvis Companion");
    assert.include(win?.files, "dist-electron/**");
    assert.include(win?.files, "package.json");
    assert.include(win?.files, "!**/sherpa-onnx-linux-x64/**");
    assert.include(
      win?.files,
      "!**/node_modules/@t3tools/jarvis-native-microphone/bin/linux-x64/**",
    );
    assert.include(win?.files, "!**/node_modules/uiohook-napi/prebuilds/linux-x64/**");
    assert.include(win?.files, "!**/node_modules/uiohook-napi/src/**");
    assert.include(win?.files, "!**/node_modules/uiohook-napi/libuiohook/**");
    assert.include(
      packageJson.build?.asarUnpack,
      "node_modules/@t3tools/jarvis-native-microphone/**",
    );
    assert.include(packageJson.build?.asarUnpack, "node_modules/sherpa-onnx-*/**");
    assert.include(packageJson.build?.asarUnpack, "node_modules/uiohook-napi/**");
    assert.equal(packageJson.build?.artifactName, "Jarvis-Companion-${version}-${arch}.${ext}");
    assert.isDefined(win);
  });
});
