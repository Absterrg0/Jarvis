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
  await FileSystem.mkdir(
    Path.join(deploy, "node_modules", ".pnpm", "effect@fixture", "node_modules", "effect"),
    { recursive: true },
  );
  await FileSystem.mkdir(
    Path.join(deploy, "node_modules", "effect", "node_modules", ".pnpm", "local-fixture"),
    { recursive: true },
  );
  await FileSystem.mkdir(Path.join(deploy, "node_modules", ".bin"), { recursive: true });
  await FileSystem.writeFile(
    Path.join(deploy, "package.json"),
    JSON.stringify({ name: "fixture" }),
  );
  await FileSystem.writeFile(Path.join(deploy, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await FileSystem.writeFile(Path.join(deploy, "pnpm-workspace.yaml"), "packages: []\n");
  await FileSystem.writeFile(Path.join(deploy, "node_modules", ".modules.yaml"), "root\n");
  await FileSystem.writeFile(Path.join(deploy, "node_modules", ".package-map.json"), "{}\n");
  await FileSystem.writeFile(
    Path.join(deploy, "node_modules", ".pnpm-workspace-state-v1.json"),
    "{}\n",
  );
  await FileSystem.writeFile(Path.join(deploy, "runtime.js"), "export const runtime = true;\n");
  await FileSystem.writeFile(Path.join(deploy, "runtime.ts"), "export const source = true;\n");
  await FileSystem.writeFile(
    Path.join(deploy, "runtime.d.ts"),
    "export declare const source: boolean;\n",
  );
  await FileSystem.mkdir(Path.join(deploy, "source-tree"), { recursive: true });
  await FileSystem.writeFile(Path.join(deploy, "source-tree", "source.ts"), "export {};\n");
  await FileSystem.writeFile(Path.join(deploy, "debug.pdb"), "debug symbols\n");
  await FileSystem.writeFile(Path.join(deploy, "debug.map"), '{"version":3}\n');
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
  await FileSystem.writeFile(
    Path.join(deploy, "node_modules", "effect", "effect.pdb"),
    "symbols\n",
  );
  await FileSystem.writeFile(Path.join(deploy, "node_modules", "effect", "effect.map"), "{}\n");
  await FileSystem.writeFile(
    Path.join(
      deploy,
      "node_modules",
      ".pnpm",
      "effect@fixture",
      "node_modules",
      "effect",
      "index.js",
    ),
    "throw new Error('virtual store should not ship');\n",
  );
  await FileSystem.writeFile(
    Path.join(
      deploy,
      "node_modules",
      "effect",
      "node_modules",
      ".pnpm",
      "local-fixture",
      "marker.js",
    ),
    "export const retained = true;\n",
  );
  await FileSystem.writeFile(Path.join(deploy, "node_modules", "shim.js"), "export {};\n");
  await FileSystem.symlink("../shim.js", Path.join(deploy, "node_modules", ".bin", "shim"));

  const packageFixture = async (
    packageName: string,
    manifest: Record<string, unknown>,
    parent = Path.join(deploy, "node_modules"),
  ): Promise<void> => {
    const packageDir = Path.join(parent, packageName);
    await FileSystem.mkdir(packageDir, { recursive: true });
    await FileSystem.writeFile(
      Path.join(packageDir, "package.json"),
      JSON.stringify({ name: packageName, version: "fixture", ...manifest }),
    );
    await FileSystem.writeFile(
      Path.join(packageDir, "index.js"),
      "export const packageReady = true;\n",
    );
  };
  await packageFixture("linux-only", { os: ["linux"] });
  await packageFixture("win-x64", { os: ["win32"], cpu: ["x64"] });
  await packageFixture("arm64-only", { cpu: ["arm64"] });
  await packageFixture("neutral", {});
  await packageFixture("negated", { os: ["!win32"] });
  await packageFixture("negated-compatible", { os: ["!darwin"], cpu: ["!arm64"] });
  await packageFixture("mixed-excluded", { os: ["win32", "!win32"] });
  await packageFixture("mixed-retained", { os: ["win32", "!darwin"], cpu: ["x64", "!arm64"] });
  await packageFixture("@scope/win-x64", { os: ["win32"], cpu: ["x64"] });
  await packageFixture("@scope/linux-only", { os: ["linux"] });
  await packageFixture("@scope/arm64-only", { cpu: ["arm64"] });
  const neutralNodeModules = Path.join(deploy, "node_modules", "neutral", "node_modules");
  await packageFixture("nested-linux", { os: ["linux"] }, neutralNodeModules);
  await packageFixture("nested-win", { os: ["win32"], cpu: ["x64"] }, neutralNodeModules);
  await packageFixture("@scope/nested-linux", { os: ["linux"] }, neutralNodeModules);
  await packageFixture("@scope/nested-arm64", { cpu: ["arm64"] }, neutralNodeModules);
  await packageFixture("@scope/nested-win", { os: ["win32"], cpu: ["x64"] }, neutralNodeModules);
  for (const metadataName of [
    ".modules.yaml",
    ".package-map.json",
    ".pnpm-workspace-state-v1.json",
  ]) {
    await FileSystem.writeFile(
      Path.join(deploy, "node_modules", "neutral", metadataName),
      "nested\n",
    );
    await FileSystem.writeFile(
      Path.join(neutralNodeModules, "@scope", "nested-win", metadataName),
      "nested-scoped\n",
    );
  }
  return { deploy, staged };
}

describe("Windows runtime staging", () => {
  it("omits validated .bin shims and keeps hoisted dependencies physical after source removal", async () => {
    const root = await FileSystem.mkdtemp(Path.join(OS.tmpdir(), "jarvis-windows-stage-test-"));
    const { deploy, staged } = await createHoistedFixture(root);
    try {
      await copyWindowsRuntimePayload(deploy, staged);
      expect(await linksUnder(staged)).toEqual([]);
      await expect(FileSystem.stat(Path.join(staged, "node_modules", ".pnpm"))).rejects.toThrow();
      await expect(FileSystem.stat(Path.join(staged, "pnpm-lock.yaml"))).rejects.toThrow();
      await expect(FileSystem.stat(Path.join(staged, "pnpm-workspace.yaml"))).rejects.toThrow();
      for (const metadataName of [
        ".modules.yaml",
        ".package-map.json",
        ".pnpm-workspace-state-v1.json",
      ]) {
        await expect(
          FileSystem.stat(Path.join(staged, "node_modules", metadataName)),
        ).rejects.toThrow();
        expect(
          await FileSystem.stat(Path.join(staged, "node_modules", "neutral", metadataName)),
        ).toBeDefined();
        expect(
          await FileSystem.stat(
            Path.join(
              staged,
              "node_modules",
              "neutral",
              "node_modules",
              "@scope",
              "nested-win",
              metadataName,
            ),
          ),
        ).toBeDefined();
      }
      expect(await FileSystem.stat(Path.join(staged, "package.json"))).toBeDefined();
      expect(await FileSystem.stat(Path.join(staged, "runtime.js"))).toBeDefined();
      expect(await FileSystem.stat(Path.join(staged, "runtime.ts"))).toBeDefined();
      expect(await FileSystem.stat(Path.join(staged, "runtime.d.ts"))).toBeDefined();
      expect(await FileSystem.stat(Path.join(staged, "source-tree", "source.ts"))).toBeDefined();
      await expect(FileSystem.stat(Path.join(staged, "debug.pdb"))).rejects.toThrow();
      await expect(FileSystem.stat(Path.join(staged, "debug.map"))).rejects.toThrow();
      await expect(
        FileSystem.stat(Path.join(staged, "node_modules", "effect", "effect.pdb")),
      ).rejects.toThrow();
      await expect(
        FileSystem.stat(Path.join(staged, "node_modules", "effect", "effect.map")),
      ).rejects.toThrow();
      expect(
        await FileSystem.stat(
          Path.join(
            staged,
            "node_modules",
            "effect",
            "node_modules",
            ".pnpm",
            "local-fixture",
            "marker.js",
          ),
        ),
      ).toBeDefined();
      expect(
        await FileSystem.stat(Path.join(staged, "node_modules", "effect", "index.js")),
      ).toBeDefined();
      for (const packageName of ["linux-only", "arm64-only", "negated", "mixed-excluded"]) {
        await expect(
          FileSystem.stat(Path.join(staged, "node_modules", packageName)),
        ).rejects.toThrow();
      }
      for (const packageName of ["linux-only", "arm64-only"]) {
        await expect(
          FileSystem.stat(Path.join(staged, "node_modules", "@scope", packageName)),
        ).rejects.toThrow();
      }
      for (const packageName of ["win-x64", "neutral", "negated-compatible", "mixed-retained"]) {
        expect(
          await FileSystem.stat(Path.join(staged, "node_modules", packageName, "index.js")),
        ).toBeDefined();
      }
      await expect(
        FileSystem.stat(
          Path.join(staged, "node_modules", "neutral", "node_modules", "nested-linux"),
        ),
      ).rejects.toThrow();
      expect(
        await FileSystem.stat(
          Path.join(staged, "node_modules", "neutral", "node_modules", "nested-win", "index.js"),
        ),
      ).toBeDefined();
      expect(
        await FileSystem.stat(Path.join(staged, "node_modules", "@scope", "win-x64", "index.js")),
      ).toBeDefined();
      await expect(
        FileSystem.stat(
          Path.join(staged, "node_modules", "neutral", "node_modules", "@scope", "nested-linux"),
        ),
      ).rejects.toThrow();
      await expect(
        FileSystem.stat(
          Path.join(staged, "node_modules", "neutral", "node_modules", "@scope", "nested-arm64"),
        ),
      ).rejects.toThrow();
      expect(
        await FileSystem.stat(
          Path.join(
            staged,
            "node_modules",
            "neutral",
            "node_modules",
            "@scope",
            "nested-win",
            "index.js",
          ),
        ),
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
      {
        name: "virtual-store",
        linkPath: ["node_modules", "effect-alias"],
        target: ".pnpm/effect@fixture/node_modules/effect/index.js",
      },
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
