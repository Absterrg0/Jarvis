// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFSP from "node:fs/promises";
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const FileSystem = NodeFSP;
const ChildProcess = NodeChildProcess;
const OS = NodeOS;
const Path = NodePath;

import { describe, expect, it } from "vite-plus/test";

import {
  createHeadlessManifest,
  createHeadlessProvenance,
  createHeadlessArchiveCommand,
  formatHeadlessChecksum,
  headlessArtifactName,
  renderHeadlessInstallScript,
  renderHeadlessStatusScript,
  renderHeadlessSystemdUnit,
  renderHeadlessUninstallScript,
  stageHeadlessNode,
} from "./package-headless-node.ts";

async function createInstallArchive(root: string, version: string): Promise<string> {
  const archive = Path.join(root, `archive-${version}`);
  await FileSystem.mkdir(Path.join(archive, "node", "bin"), { recursive: true });
  await FileSystem.mkdir(Path.join(archive, "runtime"), { recursive: true });
  await FileSystem.mkdir(Path.join(archive, "config"), { recursive: true });
  await FileSystem.mkdir(Path.join(archive, "bin"), { recursive: true });
  await FileSystem.writeFile(Path.join(archive, "node", "bin", "node"), `${version}\n`);
  await FileSystem.chmod(Path.join(archive, "node", "bin", "node"), 0o755);
  await FileSystem.writeFile(Path.join(archive, "runtime", "service-launcher.mjs"), `${version}\n`);
  await FileSystem.writeFile(Path.join(archive, "runtime", "service-state.json"), `${version}\n`);
  await FileSystem.writeFile(Path.join(archive, "config", "node-preset.json"), `${version}\n`);
  await FileSystem.writeFile(Path.join(archive, "manifest.json"), `${version}\n`);
  await FileSystem.writeFile(Path.join(archive, "bin", "status.sh"), `${version}\n`);
  const installScript = Path.join(archive, "install.sh");
  await FileSystem.writeFile(installScript, renderHeadlessInstallScript());
  await FileSystem.chmod(installScript, 0o755);
  const uninstallScript = Path.join(archive, "bin", "uninstall.sh");
  await FileSystem.writeFile(uninstallScript, renderHeadlessUninstallScript());
  await FileSystem.chmod(uninstallScript, 0o755);
  return archive;
}

describe("headless node packaging contract", () => {
  it("describes a self-contained Linux archive and its service entrypoint", () => {
    expect(headlessArtifactName("0.0.33", "x64")).toBe(
      "Jarvis-Headless-Node-0.0.33-linux-x64.tar.gz",
    );
    expect(
      createHeadlessManifest({
        version: "0.0.33",
        arch: "arm64",
        nodeVersion: "v24.11.1",
        sourceCommit: "0123456789abcdef0123456789abcdef01234567",
      }),
    ).toEqual({
      format: 1,
      product: "Jarvis",
      nodeType: "headless",
      platform: "linux",
      arch: "arm64",
      version: "0.0.33",
      nodeVersion: "v24.11.1",
      sourceCommit: "0123456789abcdef0123456789abcdef01234567",
      capabilities: {
        ui: false,
        speech: false,
        execution: true,
        projects: true,
        providers: true,
      },
    });

    const unit = renderHeadlessSystemdUnit({
      installRoot: "/home/user/.jarvis-headless",
      nodePath: "/home/user/.jarvis-headless/node/bin/node",
      launcherPath: "/home/user/.jarvis-headless/runtime/service-launcher.mjs",
      logPath: "/home/user/.jarvis-headless/userdata/logs/boot-service.log",
    });
    expect(unit).toContain("Description=Jarvis Headless Node");
    expect(unit).toContain(
      "ExecStart=/home/user/.jarvis-headless/node/bin/node /home/user/.jarvis-headless/runtime/service-launcher.mjs",
    );
    expect(unit).toContain("Environment=JARVIS_NODE_PRESET=headless");
    expect(unit).toContain("Restart=always");

    const installScript = renderHeadlessInstallScript();
    expect(installScript).toContain("JARVIS_HEADLESS_HOME");
    expect(installScript).toContain("systemctl --user enable --now jarvis-headless.service");
    expect(installScript).toContain("runtime/service-state.json");
    expect(installScript).toContain("userdata, worktrees");
    expect(installScript).toContain("JARVIS_NODE_PRESET=headless");
    expect(renderHeadlessStatusScript()).toContain("systemctl --user");
    expect(renderHeadlessUninstallScript()).toContain("--purge-data");
    expect(renderHeadlessUninstallScript()).toContain("preserved user data");
  });

  it("creates deterministic provenance and checksum sidecars", () => {
    const sourceCommit = "ABCDEF0123456789ABCDEF0123456789ABCDEF01";
    const sha256 = "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789";
    const artifact = "Jarvis-Headless-Node-0.0.33-linux-x64.tar.gz";
    expect(
      createHeadlessProvenance({
        artifact,
        sha256,
        sourceCommit,
        version: "0.0.33",
        arch: "x64",
        nodeVersion: "v24.11.1",
      }),
    ).toEqual({
      format: 1,
      artifact,
      sha256: sha256.toLowerCase(),
      sourceCommit: sourceCommit.toLowerCase(),
      version: "0.0.33",
      arch: "x64",
      nodeVersion: "v24.11.1",
      platform: "linux",
    });
    expect(formatHeadlessChecksum(sha256, artifact)).toBe(`${sha256.toLowerCase()}  ${artifact}\n`);
    expect(() =>
      createHeadlessProvenance({
        artifact,
        sha256: "not-a-checksum",
        sourceCommit,
        version: "0.0.33",
        arch: "x64",
        nodeVersion: "v24.11.1",
      }),
    ).toThrow("64-character hex digest");
  });

  it("preserves the installed runtime when an update archive is malformed", async () => {
    const root = await FileSystem.mkdtemp(Path.join(OS.tmpdir(), "jarvis-headless-install-test-"));
    const home = Path.join(root, "home");
    const installRoot = Path.join(home, ".jarvis-headless");
    const systemctl = Path.join(root, "systemctl");
    const archive = Path.join(root, "archive");
    await FileSystem.mkdir(Path.join(installRoot, "node"), { recursive: true });
    await FileSystem.mkdir(Path.join(installRoot, "runtime"), { recursive: true });
    await FileSystem.mkdir(Path.join(installRoot, "config"), { recursive: true });
    await FileSystem.mkdir(Path.join(installRoot, "bin"), { recursive: true });
    await FileSystem.mkdir(Path.join(installRoot, "userdata", "projects"), { recursive: true });
    await FileSystem.writeFile(Path.join(installRoot, "node", "version"), "previous\n");
    await FileSystem.writeFile(Path.join(installRoot, "runtime", "version"), "previous\n");
    await FileSystem.writeFile(Path.join(installRoot, "config", "version"), "previous\n");
    await FileSystem.writeFile(Path.join(installRoot, "bin", "version"), "previous\n");
    await FileSystem.writeFile(Path.join(installRoot, "manifest.json"), "previous\n");
    await FileSystem.writeFile(
      Path.join(installRoot, "userdata", "projects", "keep.txt"),
      "keep\n",
    );
    await FileSystem.writeFile(
      systemctl,
      '#!/bin/sh\nif [ "$3" = show-environment ]; then exit 0; fi\nexit 0\n',
    );
    await FileSystem.chmod(systemctl, 0o755);
    await FileSystem.mkdir(Path.join(archive, "node", "bin"), { recursive: true });
    await FileSystem.mkdir(Path.join(archive, "runtime"), { recursive: true });
    await FileSystem.symlink("missing-config", Path.join(archive, "config"));
    await FileSystem.mkdir(Path.join(archive, "bin"), { recursive: true });
    await FileSystem.writeFile(Path.join(archive, "node", "bin", "node"), "new\n");
    await FileSystem.chmod(Path.join(archive, "node", "bin", "node"), 0o755);
    await FileSystem.writeFile(Path.join(archive, "runtime", "service-launcher.mjs"), "new\n");
    await FileSystem.writeFile(Path.join(archive, "runtime", "service-state.json"), "{}\n");
    await FileSystem.writeFile(Path.join(archive, "manifest.json"), "new\n");
    await FileSystem.writeFile(Path.join(archive, "bin", "status.sh"), "new\n");

    const installScript = Path.join(archive, "install.sh");
    await FileSystem.writeFile(installScript, renderHeadlessInstallScript());
    await FileSystem.chmod(installScript, 0o755);
    const result = ChildProcess.spawnSync(installScript, [], {
      cwd: archive,
      env: {
        ...process.env,
        HOME: home,
        JARVIS_HEADLESS_HOME: installRoot,
        PATH: `${Path.dirname(systemctl)}:${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(await FileSystem.readFile(Path.join(installRoot, "node", "version"), "utf8")).toBe(
      "previous\n",
    );
    expect(await FileSystem.readFile(Path.join(installRoot, "runtime", "version"), "utf8")).toBe(
      "previous\n",
    );
    expect(
      await FileSystem.readFile(Path.join(installRoot, "userdata", "projects", "keep.txt"), "utf8"),
    ).toBe("keep\n");
    await FileSystem.rm(root, { recursive: true, force: true });
  });

  it("installs, updates, starts through fake systemd, and uninstalls without removing userdata", async () => {
    const root = await FileSystem.mkdtemp(
      Path.join(OS.tmpdir(), "jarvis-headless-lifecycle-test-"),
    );
    const home = Path.join(root, "home");
    const installRoot = Path.join(home, ".jarvis-headless");
    const systemctl = Path.join(root, "systemctl");
    const systemctlLog = Path.join(root, "systemctl.log");
    await FileSystem.writeFile(
      systemctl,
      '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$SYSTEMCTL_LOG"\nexit 0\n',
    );
    await FileSystem.chmod(systemctl, 0o755);
    const environment = {
      ...process.env,
      HOME: home,
      JARVIS_HEADLESS_HOME: installRoot,
      PATH: `${Path.dirname(systemctl)}:${process.env.PATH ?? ""}`,
      SYSTEMCTL_LOG: systemctlLog,
    };

    const archiveV1 = await createInstallArchive(root, "v1");
    const installV1 = ChildProcess.spawnSync(Path.join(archiveV1, "install.sh"), [], {
      cwd: archiveV1,
      env: environment,
      encoding: "utf8",
    });
    expect(installV1.status).toBe(0);
    await FileSystem.mkdir(Path.join(installRoot, "userdata", "projects"), { recursive: true });
    await FileSystem.writeFile(
      Path.join(installRoot, "userdata", "projects", "keep.txt"),
      "keep\n",
    );

    const archiveV2 = await createInstallArchive(root, "v2");
    const installV2 = ChildProcess.spawnSync(Path.join(archiveV2, "install.sh"), [], {
      cwd: archiveV2,
      env: environment,
      encoding: "utf8",
    });
    expect(installV2.status).toBe(0);
    expect(await FileSystem.readFile(Path.join(installRoot, "node", "bin", "node"), "utf8")).toBe(
      "v2\n",
    );
    expect(
      await FileSystem.readFile(Path.join(installRoot, "userdata", "projects", "keep.txt"), "utf8"),
    ).toBe("keep\n");
    expect(
      await FileSystem.readFile(
        Path.join(home, ".config", "systemd", "user", "jarvis-headless.service"),
        "utf8",
      ),
    ).toContain("Environment=JARVIS_NODE_PRESET=headless");
    const systemctlCalls = await FileSystem.readFile(systemctlLog, "utf8");
    expect(systemctlCalls).toContain("--user enable --now jarvis-headless.service");
    expect(systemctlCalls).toContain("--user stop jarvis-headless.service");

    const uninstall = ChildProcess.spawnSync(Path.join(archiveV2, "bin", "uninstall.sh"), [], {
      cwd: archiveV2,
      env: environment,
      encoding: "utf8",
    });
    expect(uninstall.status).toBe(0);
    await expect(FileSystem.stat(Path.join(installRoot, "node"))).rejects.toThrow();
    expect(
      await FileSystem.readFile(Path.join(installRoot, "userdata", "projects", "keep.txt"), "utf8"),
    ).toBe("keep\n");
    await FileSystem.rm(root, { recursive: true, force: true });
  });

  it("stages the pinned launcher layout without source or package-manager files", async () => {
    const root = await FileSystem.mkdtemp(Path.join(OS.tmpdir(), "jarvis-headless-test-"));
    const deployDir = Path.join(root, "deploy");
    await FileSystem.mkdir(Path.join(deployDir, "dist"), { recursive: true });
    await FileSystem.writeFile(Path.join(deployDir, "dist", "bin.mjs"), "#!/usr/bin/env node\n");
    await FileSystem.mkdir(Path.join(deployDir, "dist", "client"), { recursive: true });
    await FileSystem.writeFile(
      Path.join(deployDir, "dist", "client", "index.html"),
      "<!doctype html>\n",
    );
    await FileSystem.writeFile(
      Path.join(deployDir, "dist", "service-launcher.mjs"),
      "export {};\n",
    );
    await FileSystem.writeFile(Path.join(deployDir, "dist", "bin.mjs.map"), "source map\n");
    await FileSystem.mkdir(Path.join(deployDir, "src"), { recursive: true });
    await FileSystem.writeFile(Path.join(deployDir, "src", "not-for-production.ts"), "source\n");
    const effectStoreDir = Path.join(deployDir, "node_modules", ".pnpm", "effect");
    await FileSystem.mkdir(effectStoreDir, { recursive: true });
    await FileSystem.writeFile(Path.join(effectStoreDir, "package.json"), "{}\n");
    await FileSystem.symlink(effectStoreDir, Path.join(deployDir, "node_modules", "effect"));

    const layout = await stageHeadlessNode({
      version: "0.0.33",
      arch: "x64",
      nodeVersion: process.version,
      sourceCommit: "0123456789abcdef0123456789abcdef01234567",
      deployDir,
      nodeExecutable: process.execPath,
      stageParent: root,
    });

    expect(
      await FileSystem.readFile(
        Path.join(layout.runtimeVersionDir, "node_modules", "t3", "dist", "bin.mjs"),
        "utf8",
      ),
    ).toContain("node");
    const stagedEffectPath = Path.join(
      layout.runtimeVersionDir,
      "node_modules",
      "t3",
      "node_modules",
      "effect",
    );
    expect((await FileSystem.lstat(stagedEffectPath)).isSymbolicLink()).toBe(true);
    const stagedEffectLink = await FileSystem.readlink(stagedEffectPath);
    expect(Path.isAbsolute(stagedEffectLink)).toBe(false);
    expect(
      await FileSystem.readFile(
        Path.resolve(Path.dirname(stagedEffectPath), stagedEffectLink, "package.json"),
        "utf8",
      ),
    ).toBe("{}\n");
    expect(await FileSystem.readFile(layout.launcherPath, "utf8")).toContain("export");
    expect(await FileSystem.readFile(layout.presetPath, "utf8")).toContain(
      '"nodeType": "headless"',
    );
    expect(await FileSystem.readFile(layout.installScriptPath, "utf8")).toContain(
      "systemctl --user enable --now jarvis-headless.service",
    );
    expect(await FileSystem.readFile(layout.statusScriptPath, "utf8")).toContain(
      "Jarvis Headless Node",
    );
    expect(await FileSystem.readFile(layout.uninstallScriptPath, "utf8")).toContain("--purge-data");
    await expect(
      FileSystem.stat(
        Path.join(layout.runtimeVersionDir, "node_modules", "t3", "dist", "bin.mjs.map"),
      ),
    ).rejects.toThrow();
    await expect(
      FileSystem.stat(
        Path.join(layout.runtimeVersionDir, "node_modules", "t3", "dist", "client", "index.html"),
      ),
    ).rejects.toThrow();
    await expect(
      FileSystem.stat(Path.join(layout.runtimeVersionDir, "node_modules", "t3", "src")),
    ).rejects.toThrow();
    expect(
      await FileSystem.readFile(Path.join(layout.runtimeVersionDir, ".install-complete"), "utf8"),
    ).toBe("0.0.33\n");
    expect(createHeadlessArchiveCommand(layout.rootDir, "/tmp/headless.tar.gz").args).toEqual([
      "--create",
      "--gzip",
      "--file",
      "/tmp/headless.tar.gz",
      "--sort=name",
      "--mtime=@0",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "--directory",
      root,
      "jarvis-headless-node-0.0.33-linux-x64",
    ]);

    await FileSystem.rm(root, { recursive: true, force: true });
  });
});
