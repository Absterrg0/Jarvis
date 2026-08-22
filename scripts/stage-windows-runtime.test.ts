// @effect-diagnostics nodeBuiltinImport:off

import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { copyWindowsRuntimePayload } from "./stage-windows-runtime.ts";

const ChildProcess = NodeChildProcess;
const FileSystem = NodeFSP;
const OS = NodeOS;
const Path = NodePath;

async function linksUnder(directory: string): Promise<string[]> {
  const links: string[] = [];
  const visit = async (current: string): Promise<void> => {
    const entries = await FileSystem.readdir(current, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const entryPath = Path.join(current, entry.name);
        if (entry.isSymbolicLink()) {
          links.push(entryPath);
        } else if (entry.isDirectory()) {
          await visit(entryPath);
        }
      }),
    );
  };
  await visit(directory);
  return links;
}

async function createHoistedFixture(root: string): Promise<{ deploy: string; staged: string }> {
  const deploy = Path.join(root, "deploy");
  const staged = Path.join(root, "staged");
  await FileSystem.mkdir(Path.join(deploy, "dist"), { recursive: true });
  await FileSystem.mkdir(Path.join(deploy, "node_modules", "effect"), { recursive: true });
  await FileSystem.mkdir(Path.join(deploy, "node_modules", ".bin"), { recursive: true });
  await FileSystem.writeFile(
    Path.join(deploy, "dist", "bin.mjs"),
    'import "effect"; export const ready = true;\n',
  );
  await FileSystem.writeFile(
    Path.join(deploy, "node_modules", "effect", "package.json"),
    JSON.stringify({ name: "effect", version: "fixture", type: "module", exports: "./index.js" }),
  );
  await FileSystem.writeFile(
    Path.join(deploy, "node_modules", "effect", "index.js"),
    "export {};\n",
  );
  await FileSystem.writeFile(Path.join(deploy, "node_modules", "shim.js"), "export {};\n");
  await FileSystem.symlink("../shim.js", Path.join(deploy, "node_modules", ".bin", "shim"));
  return { deploy, staged };
}

describe("Windows runtime staging", () => {
  it("omits validated .bin shims and keeps hoisted dependencies physical after source removal", async () => {
    const root = await FileSystem.mkdtemp(Path.join(OS.tmpdir(), "jarvis-windows-stage-test-"));
    const { deploy, staged } = await createHoistedFixture(root);
    try {
      await copyWindowsRuntimePayload(deploy, staged);
      expect(await linksUnder(staged)).toEqual([]);
      expect(
        await FileSystem.stat(Path.join(staged, "node_modules", "effect", "index.js")),
      ).toBeDefined();
      await FileSystem.rm(deploy, { recursive: true, force: true });
      const probe = ChildProcess.spawnSync(
        process.execPath,
        ["--input-type=module", "-e", 'import("./dist/bin.mjs")'],
        { cwd: staged, encoding: "utf8" },
      );
      expect(probe.status, probe.stderr).toBe(0);
    } finally {
      await FileSystem.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects dangling, escaping, directory, and non-.bin links", async () => {
    const cases = [
      { name: "dangling", linkPath: ["node_modules", ".bin", "missing"], target: "missing.js" },
      {
        name: "escaping",
        linkPath: ["node_modules", ".bin", "outside"],
        target: "../../../outside.js",
      },
      { name: "directory", linkPath: ["node_modules", ".bin", "effect"], target: "../effect" },
      { name: "non-bin", linkPath: ["node_modules", "effect-alias"], target: "effect/index.js" },
    ];
    for (const testCase of cases) {
      const root = await FileSystem.mkdtemp(
        Path.join(OS.tmpdir(), `jarvis-windows-stage-${testCase.name}-`),
      );
      const { deploy, staged } = await createHoistedFixture(root);
      try {
        if (testCase.name === "escaping") {
          await FileSystem.writeFile(Path.join(root, "outside.js"), "export {};\n");
        }
        await FileSystem.symlink(testCase.target, Path.join(deploy, ...testCase.linkPath));
        await expect(copyWindowsRuntimePayload(deploy, staged)).rejects.toThrow("unsupported link");
      } finally {
        await FileSystem.rm(root, { recursive: true, force: true });
      }
    }
  });
});
