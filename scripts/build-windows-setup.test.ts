// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";

import { getPath7za } from "app-builder-lib/out/toolsets/7zip.js";
import { describe, expect, it } from "vite-plus/test";

import {
  createWindowsSetupArchives,
  encodeWindowsSetupNsi,
  assertWindowsSetupArtifactSize,
  findMakensis,
  makensisCacheCandidates,
  makensisVerbosityFlag,
  makensisSpawnOptions,
  pruneRuntimePayload,
  resolveMakensisForBuild,
  resolveWindowsSevenZipPath,
  windowsSetupIconPath,
  WINDOWS_SETUP_ARCHIVE_ARGS,
  WINDOWS_SETUP_ARTIFACT_BYTE_BUDGET,
} from "./build-windows-setup.ts";
import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";

describe("Windows setup compiler invocation", () => {
  it("guards the compressed outer installer rather than the unpacked payload", () => {
    expect(() => assertWindowsSetupArtifactSize(WINDOWS_SETUP_ARTIFACT_BYTE_BUDGET)).not.toThrow();
    expect(() => assertWindowsSetupArtifactSize(WINDOWS_SETUP_ARTIFACT_BYTE_BUDGET + 1)).toThrow(
      /Windows setup artifact uses/u,
    );
  });

  it("uses the canonical production Windows icon source", async () => {
    const repoRoot = NodePath.resolve(
      NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
      "..",
    );
    const iconPath = windowsSetupIconPath(repoRoot);
    expect(iconPath).toBe(NodePath.resolve(repoRoot, BRAND_ASSET_PATHS.productionWindowsIconIco));
    const iconStat = await NodeFSP.stat(iconPath);
    expect(iconStat.isFile()).toBe(true);
  });

  it("encodes NSIS source as BOM-prefixed UTF-8 so Unicode copy is not mojibake", () => {
    const source = 'Unicode true\r\nName "Full Node - UI, voice, and local execution"\r\n';
    const encoded = encodeWindowsSetupNsi(source);
    expect(encoded.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(encoded.toString("utf8")).toBe(`\uFEFF${source}`);
    expect(encoded.toString("utf8")).not.toContain("â€“");
  });

  it("uses the platform-specific makensis verbosity flag", () => {
    expect(makensisVerbosityFlag("win32")).toBe("/V2");
    expect(makensisVerbosityFlag("linux")).toBe("-V2");
  });

  it("pins balanced non-solid BCJ archives without timestamps and can round-trip a tiny payload", async () => {
    expect(WINDOWS_SETUP_ARCHIVE_ARGS).toEqual([
      "a",
      "-bd",
      "-y",
      "-bb0",
      "-mx=3",
      "-ms=off",
      "-mf=BCJ",
      "-mtc=off",
      "-mtm=off",
      "-mta=off",
    ]);
    const sevenZip = await getPath7za();
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "jarvis-setup-archive-"));
    try {
      for (const name of ["desktop", "runtime-win"]) {
        await NodeFSP.mkdir(NodePath.join(root, name), { recursive: true });
        await NodeFSP.writeFile(NodePath.join(root, name, "entry.txt"), `${name}\n`);
        await NodeFSP.writeFile(NodePath.join(root, name, "second.txt"), `${name}-second\n`);
      }
      await createWindowsSetupArchives(root);
      for (const name of ["desktop", "runtime-win"]) {
        const archive = NodePath.join(root, `${name}.7z`);
        const extracted = NodePath.join(root, "extracted", name);
        await NodeFSP.mkdir(extracted, { recursive: true });
        const result = NodeChildProcess.spawnSync(
          sevenZip,
          ["x", "-y", `-o${extracted}`, archive],
          { encoding: "utf8" },
        );
        expect(result.status, result.stderr).toBe(0);
        await expect(NodeFSP.readFile(NodePath.join(extracted, "entry.txt"), "utf8")).resolves.toBe(
          `${name}\n`,
        );
        const listing = NodeChildProcess.spawnSync(sevenZip, ["l", "-slt", archive], {
          encoding: "utf8",
        });
        expect(listing.status, listing.stderr).toBe(0);
        expect(listing.stdout).toMatch(/Method = LZMA2:\d+ BCJ/u);
        expect(listing.stdout).toMatch(/Solid = -\r?\n/u);
        expect(listing.stdout).toMatch(/Modified = \r?\n/u);
      }
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("finds the official Electron Builder NSIS Bin cache layout", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "jarvis-makensis-cache-"));
    const makensis = NodePath.join(
      root,
      "nsis-3.0.4.1",
      "nsis-3.0.4.1-1mx3n",
      "Bin",
      "makensis.exe",
    );
    const decoy = NodePath.join(
      root,
      "nsis-3.0.4.1",
      "not-a-versioned-directory",
      "Bin",
      "makensis.exe",
    );
    try {
      await NodeFSP.mkdir(NodePath.dirname(makensis), { recursive: true });
      await NodeFSP.mkdir(NodePath.dirname(decoy), { recursive: true });
      await NodeFSP.writeFile(makensis, "fake makensis");
      await NodeFSP.writeFile(decoy, "decoy makensis");
      const candidates = await makensisCacheCandidates(root);
      expect(candidates[0]).toBe(makensis);
      expect(candidates).not.toContain(decoy);
      await expect(findMakensis(undefined, { electronBuilderCache: root })).resolves.toBe(makensis);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to the pinned electron-builder toolchain after overrides", async () => {
    const resolution = await resolveMakensisForBuild(undefined, { comSpec: "" }, async () => ({
      path: "C:\\tools\\makensis.exe",
      env: { NSISDIR: "C:\\tools" },
    }));
    expect(resolution).toEqual({ path: "C:\\tools\\makensis.exe", env: { NSISDIR: "C:\\tools" } });
  });

  it("preserves electron-builder's NSIS environment when spawning", () => {
    const options = makensisSpawnOptions({
      path: "C:\\tools\\makensis.exe",
      env: { NSISDIR: "C:\\tools" },
    });
    expect(options.env?.NSISDIR).toBe("C:\\tools");
  });

  it("resolves the pinned modern 7za executable", async () => {
    await expect(resolveWindowsSevenZipPath()).resolves.toBe(await getPath7za());
  });

  it("prunes UI packages and source-only files from every deployed t3 package", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "jarvis-runtime-prune-"));
    const exists = async (path: string) => Boolean(await NodeFSP.stat(path).catch(() => undefined));
    const writeJson = async (path: string, value: unknown) => {
      await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
      await NodeFSP.writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
    };
    try {
      await writeJson(NodePath.join(root, "package.json"), { name: "t3" });
      await writeJson(NodePath.join(root, "node_modules", "@t3tools", "web", "package.json"), {
        name: "@t3tools/web",
      });
      await NodeFSP.writeFile(
        NodePath.join(root, "node_modules", "@t3tools", "web", "client.js"),
        "ui",
      );
      await writeJson(NodePath.join(root, "node_modules", "t3", "package.json"), {
        name: "t3",
      });
      await NodeFSP.mkdir(NodePath.join(root, "src"), { recursive: true });
      await NodeFSP.mkdir(NodePath.join(root, "dist", "client"), { recursive: true });
      await NodeFSP.mkdir(NodePath.join(root, "dist", "server"), { recursive: true });
      await NodeFSP.mkdir(NodePath.join(root, "node_modules", "t3", "src"), {
        recursive: true,
      });
      await NodeFSP.mkdir(NodePath.join(root, "node_modules", "t3", "dist", "client"), {
        recursive: true,
      });
      await NodeFSP.mkdir(NodePath.join(root, "node_modules", "t3", "dist", "server"), {
        recursive: true,
      });
      await NodeFSP.writeFile(NodePath.join(root, "src", "source.ts"), "source");
      await NodeFSP.writeFile(NodePath.join(root, "dist", "client", "client.js"), "client");
      await NodeFSP.writeFile(NodePath.join(root, "dist", "server", "server.js"), "server");
      await NodeFSP.writeFile(NodePath.join(root, "dist", "server", "server.js.map"), "map");
      await NodeFSP.writeFile(
        NodePath.join(root, "node_modules", "t3", "src", "source.ts"),
        "source",
      );
      await NodeFSP.writeFile(
        NodePath.join(root, "node_modules", "t3", "dist", "client", "client.js"),
        "client",
      );
      await NodeFSP.writeFile(
        NodePath.join(root, "node_modules", "t3", "dist", "server", "server.js"),
        "server",
      );
      await NodeFSP.writeFile(
        NodePath.join(root, "node_modules", "t3", "dist", "server", "server.js.map"),
        "map",
      );
      await writeJson(NodePath.join(root, "node_modules", "other", "package.json"), {
        name: "other",
      });
      await NodeFSP.mkdir(NodePath.join(root, "node_modules", "other", "dist"), {
        recursive: true,
      });
      await NodeFSP.writeFile(
        NodePath.join(root, "node_modules", "other", "dist", "other.js.map"),
        "keep",
      );

      await pruneRuntimePayload(root);

      expect(await exists(NodePath.join(root, "node_modules", "@t3tools", "web"))).toBe(false);
      expect(await exists(NodePath.join(root, "src"))).toBe(false);
      expect(await exists(NodePath.join(root, "dist", "client"))).toBe(false);
      expect(await exists(NodePath.join(root, "dist", "server", "server.js.map"))).toBe(false);
      expect(await exists(NodePath.join(root, "dist", "server", "server.js"))).toBe(true);
      expect(await exists(NodePath.join(root, "node_modules", "t3", "src"))).toBe(false);
      expect(await exists(NodePath.join(root, "node_modules", "t3", "dist", "client"))).toBe(false);
      expect(
        await exists(NodePath.join(root, "node_modules", "t3", "dist", "server", "server.js.map")),
      ).toBe(false);
      expect(
        await exists(NodePath.join(root, "node_modules", "t3", "dist", "server", "server.js")),
      ).toBe(true);
      expect(
        await exists(NodePath.join(root, "node_modules", "other", "dist", "other.js.map")),
      ).toBe(true);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
