// @effect-diagnostics nodeBuiltinImport:off - this test inspects the package loader as a local filesystem seam.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { nativeMicrophoneTargetFor, nativeMicrophoneTargets } from "./native-target.ts";
import { resolveNativeBinaryPath } from "../loader.cjs";

describe("native microphone target selection", () => {
  it.each([
    ["darwin", "arm64", "darwin-arm64"],
    ["darwin", "x64", "darwin-x64"],
    ["linux", "x64", "linux-x64"],
    ["win32", "x64", "win32-x64"],
  ])("selects %s-%s as %s", (platform, arch, expected) => {
    expect(nativeMicrophoneTargetFor(platform, arch)).toBe(expected);
  });

  it.each([
    ["linux", "ppc64"],
    ["freebsd", "x64"],
  ])("rejects unsupported %s-%s", (platform, arch) => {
    expect(() => nativeMicrophoneTargetFor(platform, arch)).toThrow(/Unsupported native target/);
  });

  it("keeps every target tied to one exact Rust target", () => {
    expect(nativeMicrophoneTargets["darwin-arm64"].rustTarget).toBe("aarch64-apple-darwin");
    expect(nativeMicrophoneTargets["darwin-x64"].rustTarget).toBe("x86_64-apple-darwin");
  });

  it("fails closed for missing, wrong-target, and non-file binaries", () => {
    const expectedPath = NodePath.join("/pkg", "bin", "linux-x64", "index.node");
    const existing = new Set([expectedPath]);
    const exists = (filePath: string) => existing.has(filePath);
    const isFile = (filePath: string) => filePath.endsWith("index.node");
    expect(resolveNativeBinaryPath("/pkg", "linux", "x64", exists, isFile)).toBe(expectedPath);
    expect(() => resolveNativeBinaryPath("/pkg", "linux", "arm64", exists, isFile)).toThrow(
      /Missing native binary for linux-arm64/,
    );
    expect(() =>
      resolveNativeBinaryPath(
        "/pkg",
        "linux",
        "x64",
        () => true,
        () => false,
      ),
    ).toThrow(/not a regular file/);
    expect(() => resolveNativeBinaryPath("/pkg", "freebsd", "x64", exists, isFile)).toThrow(
      /Unsupported platform/,
    );
  });

  it("does not retain a root-binary or GitHub build fallback", () => {
    const loader = NodeFS.readFileSync(
      NodePath.resolve(import.meta.dirname, "../loader.cjs"),
      "utf8",
    );
    expect(loader).not.toContain('path.join(__dirname, "index.node")');
    expect(loader).not.toContain("node-cpal");
  });
});
