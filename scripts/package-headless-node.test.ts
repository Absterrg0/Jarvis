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
  copyDeployedPackage,
  formatHeadlessChecksum,
  headlessArtifactName,
  planDeployLink,
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
  it("plans portable links and preserves deploy dependency links", async () => {
    expect(
      planDeployLink({
        platform: "win32",
        isDirectory: true,
        stagedTarget: "C:\\stage\\node_modules\\.pnpm\\effect",
        relativeTarget: "..\\.pnpm\\effect",
      }),
    ).toEqual({ target: "C:\\stage\\node_modules\\.pnpm\\effect", type: "junction" });
    expect(
      planDeployLink({
        platform: "win32",
        isDirectory: false,
        stagedTarget: "C:\\stage\\file.js",
        relativeTarget: "..\\file.js",
      }),
    ).toEqual({ target: "..\\file.js", type: "file" });
    expect(
      planDeployLink({
        platform: "linux",
        isDirectory: true,
        stagedTarget: "/tmp/stage/node_modules/.pnpm/effect",
        relativeTarget: "../.pnpm/effect",
      }),
    ).toEqual({ target: "../.pnpm/effect", type: "dir" });

    const root = await FileSystem.mkdtemp(Path.join(OS.tmpdir(), "jarvis-deploy-copy-test-"));
    const deployDir = Path.join(root, "deploy");
    const stagedDir = Path.join(root, "staged");
    const effectStoreDir = Path.join(
      deployDir,
      "node_modules",
      ".pnpm",
      "effect@fixture",
      "node_modules",
      "effect",
    );
    const fastCheckStoreDir = Path.join(
      deployDir,
      "node_modules",
      ".pnpm",
      "fast-check@fixture",
      "node_modules",
      "fast-check",
    );
    try {
      await FileSystem.mkdir(Path.join(deployDir, "dist"), { recursive: true });
      await FileSystem.mkdir(Path.join(effectStoreDir, "dist", "testing"), { recursive: true });
      await FileSystem.mkdir(Path.dirname(effectStoreDir), { recursive: true });
      await FileSystem.mkdir(fastCheckStoreDir, { recursive: true });
      await FileSystem.writeFile(
        Path.join(deployDir, "package.json"),
        JSON.stringify({ name: "t3", version: "0.0.33" }),
      );
      await FileSystem.writeFile(Path.join(deployDir, "dist", "bin.mjs"), "export {};");
      await FileSystem.writeFile(
        Path.join(deployDir, "dist", "service-launcher.mjs"),
        "export {};",
      );
      await FileSystem.writeFile(
        Path.join(effectStoreDir, "package.json"),
        JSON.stringify({
          name: "effect",
          version: "fixture",
          type: "module",
          exports: { "./testing/FastCheck": "./dist/testing/FastCheck.js" },
        }),
      );
      await FileSystem.writeFile(
        Path.join(effectStoreDir, "dist", "testing", "FastCheck.js"),
        'import "fast-check"; export const loaded = true;\n',
      );
      await FileSystem.writeFile(
        Path.join(fastCheckStoreDir, "package.json"),
        JSON.stringify({ name: "fast-check", version: "fixture", type: "module" }),
      );
      await FileSystem.writeFile(Path.join(fastCheckStoreDir, "index.js"), "export {};");
      await FileSystem.symlink(effectStoreDir, Path.join(deployDir, "node_modules", "effect"));
      await FileSystem.symlink(
        "../../fast-check@fixture/node_modules/fast-check",
        Path.join(Path.dirname(effectStoreDir), "fast-check"),
      );

      await copyDeployedPackage(deployDir, stagedDir);
      expect(await FileSystem.readFile(Path.join(stagedDir, "package.json"), "utf8")).toContain(
        '"name":"t3"',
      );
      expect((await FileSystem.stat(Path.join(stagedDir, "dist"))).isDirectory()).toBe(true);
      expect(
        (await FileSystem.lstat(Path.join(stagedDir, "node_modules", "effect"))).isSymbolicLink(),
      ).toBe(true);
      expect(await FileSystem.readlink(Path.join(stagedDir, "node_modules", "effect"))).toBe(
        ".pnpm/effect@fixture/node_modules/effect",
      );
      await FileSystem.rm(deployDir, { recursive: true, force: true });
      const probe = ChildProcess.spawnSync(
        process.execPath,
        ["--input-type=module", "-e", 'import("effect/testing/FastCheck")'],
        { cwd: stagedDir, encoding: "utf8" },
      );
      expect(probe.status, probe.stderr).toBe(0);
    } finally {
      await FileSystem.rm(root, { recursive: true, force: true });
    }
  });

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

  it("reloads and restarts the previous service after a failed update", async () => {
    const root = await FileSystem.mkdtemp(Path.join(OS.tmpdir(), "jarvis-headless-rollback-test-"));
    const home = Path.join(root, "home");
    const installRoot = Path.join(home, ".jarvis-headless");
    const systemctl = Path.join(root, "systemctl");
    const systemctlLog = Path.join(root, "systemctl.log");
    const failOnce = Path.join(root, "fail-once");
    try {
      await FileSystem.writeFile(
        systemctl,
        [
          "#!/bin/sh",
          'printf \'%s\\n\' "$*" >> "$SYSTEMCTL_LOG"',
          'if test "$2" = enable && test -e "$SYSTEMCTL_FAIL_ONCE"; then',
          '  rm -f "$SYSTEMCTL_FAIL_ONCE"',
          "  exit 1",
          "fi",
          "exit 0",
          "",
        ].join("\n"),
      );
      await FileSystem.chmod(systemctl, 0o755);
      const environment = {
        ...process.env,
        HOME: home,
        JARVIS_HEADLESS_HOME: installRoot,
        PATH: `${Path.dirname(systemctl)}:${process.env.PATH ?? ""}`,
        SYSTEMCTL_LOG: systemctlLog,
        SYSTEMCTL_FAIL_ONCE: failOnce,
      };

      const archiveV1 = await createInstallArchive(root, "v1");
      const installV1 = ChildProcess.spawnSync(Path.join(archiveV1, "install.sh"), [], {
        cwd: archiveV1,
        env: environment,
        encoding: "utf8",
      });
      expect(installV1.status).toBe(0);
      const unitPath = Path.join(home, ".config", "systemd", "user", "jarvis-headless.service");
      await FileSystem.writeFile(unitPath, "[Unit]\n# previous-unit\n");

      const archiveV2 = await createInstallArchive(root, "v2");
      await FileSystem.writeFile(failOnce, "fail\n");
      const failedUpdate = ChildProcess.spawnSync(Path.join(archiveV2, "install.sh"), [], {
        cwd: archiveV2,
        env: environment,
        encoding: "utf8",
      });
      expect(failedUpdate.status).not.toBe(0);
      expect(await FileSystem.readFile(Path.join(installRoot, "node", "bin", "node"), "utf8")).toBe(
        "v1\n",
      );
      expect(await FileSystem.readFile(unitPath, "utf8")).toContain("# previous-unit");

      const systemctlCalls = await FileSystem.readFile(systemctlLog, "utf8");
      expect(
        systemctlCalls
          .split("\n")
          .filter((call) => call === "--user enable --now jarvis-headless.service"),
      ).toHaveLength(3);
      expect(
        systemctlCalls.split("\n").filter((call) => call === "--user daemon-reload"),
      ).toHaveLength(3);
    } finally {
      await FileSystem.rm(root, { recursive: true, force: true });
    }
  });

  it("does not restart a service when a first install fails", async () => {
    const root = await FileSystem.mkdtemp(
      Path.join(OS.tmpdir(), "jarvis-headless-first-install-rollback-test-"),
    );
    const home = Path.join(root, "home");
    const installRoot = Path.join(home, ".jarvis-headless");
    const systemctl = Path.join(root, "systemctl");
    const systemctlLog = Path.join(root, "systemctl.log");
    try {
      await FileSystem.writeFile(
        systemctl,
        [
          "#!/bin/sh",
          'printf \'%s\\n\' "$*" >> "$SYSTEMCTL_LOG"',
          'if test "$2" = enable; then exit 1; fi',
          "exit 0",
          "",
        ].join("\n"),
      );
      await FileSystem.chmod(systemctl, 0o755);
      const environment = {
        ...process.env,
        HOME: home,
        JARVIS_HEADLESS_HOME: installRoot,
        PATH: `${Path.dirname(systemctl)}:${process.env.PATH ?? ""}`,
        SYSTEMCTL_LOG: systemctlLog,
      };

      const archive = await createInstallArchive(root, "first");
      const failedInstall = ChildProcess.spawnSync(Path.join(archive, "install.sh"), [], {
        cwd: archive,
        env: environment,
        encoding: "utf8",
      });
      expect(failedInstall.status).not.toBe(0);
      const systemctlCalls = await FileSystem.readFile(systemctlLog, "utf8");
      expect(
        systemctlCalls
          .split("\n")
          .filter((call) => call === "--user enable --now jarvis-headless.service"),
      ).toHaveLength(1);
      expect(
        systemctlCalls.split("\n").filter((call) => call === "--user daemon-reload"),
      ).toHaveLength(2);
      await expect(FileSystem.stat(Path.join(installRoot, "node"))).rejects.toThrow();
    } finally {
      await FileSystem.rm(root, { recursive: true, force: true });
    }
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
