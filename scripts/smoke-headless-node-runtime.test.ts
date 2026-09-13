// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import {
  buildHeadlessRuntimeSmokeCommand,
  HEADLESS_READY_LINE,
  validateHeadlessEnvironmentDescriptor,
} from "./smoke-headless-node-runtime.ts";

describe("packaged headless runtime smoke contract", () => {
  it("is wired into both native headless release matrix jobs", () => {
    const workflow = NodeFS.readFileSync(
      new URL("../.github/workflows/headless-node-release.yml", import.meta.url),
      "utf8",
    );
    expect(workflow).toContain('node scripts/smoke-headless-node-runtime.ts "$extracted"');
    expect(workflow).toContain("arch: x64");
    expect(workflow).toContain("arch: arm64");
    expect(workflow).toContain("runner: ubuntu-24.04-arm");
  });

  it("starts the bundled server in serve mode against an isolated home", () => {
    expect(
      buildHeadlessRuntimeSmokeCommand({
        nodePath: "/artifact/node/bin/node",
        serverPath: "/artifact/runtime/versions/1.2.3/node_modules/@absterrg0/circe/dist/bin.mjs",
        homeDir: "/tmp/isolated-headless-home",
        port: 4321,
      }),
    ).toEqual({
      executable: "/artifact/node/bin/node",
      args: [
        "/artifact/runtime/versions/1.2.3/node_modules/@absterrg0/circe/dist/bin.mjs",
        "serve",
        "--base-dir",
        "/tmp/isolated-headless-home",
        "--host",
        "127.0.0.1",
        "--port",
        "4321",
      ],
    });
  });

  it("requires the concrete server-ready output signal", () => {
    expect(HEADLESS_READY_LINE).toBe("Circe server is ready.");
  });

  it("accepts only a headless descriptor with execution enabled and UI disabled", () => {
    expect(() =>
      validateHeadlessEnvironmentDescriptor({
        capabilities: {
          circeNode: {
            preset: "headless",
            ui: false,
            execution: true,
            projects: true,
            providers: true,
            pushNotifications: true,
          },
        },
      }),
    ).not.toThrow();
    expect(() =>
      validateHeadlessEnvironmentDescriptor({
        capabilities: {
          circeNode: {
            preset: "full",
            ui: true,
            execution: true,
            projects: true,
            providers: true,
            pushNotifications: true,
          },
        },
      }),
    ).toThrow(/preset/);
  });
});
