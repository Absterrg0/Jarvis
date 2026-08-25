import { assert, describe, it } from "@effect/vitest";

import { resolveCompanionTrayIconPath } from "./tray-icon.ts";

describe("Companion tray icon path", () => {
  it("keeps packaged builds on the extra-resource icon", () => {
    assert.equal(
      resolveCompanionTrayIconPath({
        packaged: true,
        appPath: "/opt/jarvis/companion.asar",
        resourcesPath: "/opt/jarvis/resources",
      }),
      "/opt/jarvis/resources/icon.png",
    );
  });

  it("resolves the repository asset from a dist-electron development app path", () => {
    assert.equal(
      resolveCompanionTrayIconPath({
        packaged: false,
        appPath: "/repo/apps/companion/dist-electron",
        resourcesPath: "/repo/apps/companion/dist-electron/resources",
        exists: (path) => path === "/repo/assets/jarvis/jarvis-universal-1024.png",
      }),
      "/repo/assets/jarvis/jarvis-universal-1024.png",
    );
  });

  it("resolves the repository asset from an app-root development path", () => {
    assert.equal(
      resolveCompanionTrayIconPath({
        packaged: false,
        appPath: "/repo/apps/companion",
        resourcesPath: "/repo/apps/companion/resources",
        exists: (path) => path === "/repo/assets/jarvis/jarvis-universal-1024.png",
      }),
      "/repo/assets/jarvis/jarvis-universal-1024.png",
    );
  });

  it("falls back to the alternate development layout when the first candidate is absent", () => {
    const resolved = resolveCompanionTrayIconPath({
      packaged: false,
      appPath: "/repo/apps/companion/dist-electron/nested",
      resourcesPath: "/repo/apps/companion/dist-electron/resources",
      exists: (path) => path === "/repo/assets/jarvis/jarvis-universal-1024.png",
    });
    assert.equal(resolved, "/repo/assets/jarvis/jarvis-universal-1024.png");
  });
});
