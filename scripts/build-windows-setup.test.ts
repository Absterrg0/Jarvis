// @effect-diagnostics nodeBuiltinImport:off

import { describe, expect, it } from "vite-plus/test";

import { makensisVerbosityFlag } from "./build-windows-setup.ts";

describe("Windows setup compiler invocation", () => {
  it("uses the platform-specific makensis verbosity flag", () => {
    expect(makensisVerbosityFlag("win32")).toBe("/V2");
    expect(makensisVerbosityFlag("linux")).toBe("-V2");
  });
});
