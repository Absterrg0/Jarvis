#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalConsole:off
/* oxlint-disable eslint/no-useless-escape */

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

import serverPackageJson from "../apps/server/package.json" with { type: "json" };

const ChildProcess = NodeChildProcess;
const Crypto = NodeCrypto;
const FileSystemSync = NodeFS;
const FileSystem = NodeFSP;
const Path = NodePath;

export type HeadlessArch = "x64" | "arm64";

const SERVICE_LAUNCHER_PROTOCOL = 2;
const SERVICE_NAME = "jarvis-headless.service";
const SAFE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u;

export interface HeadlessManifestInput {
  readonly version: string;
  readonly arch: HeadlessArch;
  readonly nodeVersion: string;
  readonly sourceCommit: string;
}

export interface HeadlessManifest extends HeadlessManifestInput {
  readonly format: 1;
  readonly product: "Jarvis";
  readonly nodeType: "headless";
  readonly platform: "linux";
  readonly capabilities: {
    readonly ui: false;
    readonly speech: false;
    readonly execution: true;
    readonly projects: true;
    readonly providers: true;
  };
}

export interface HeadlessServicePaths {
  readonly installRoot: string;
  readonly nodePath: string;
  readonly launcherPath: string;
  readonly logPath: string;
}

export interface StageHeadlessNodeInput extends HeadlessManifestInput {
  /** Existing `pnpm deploy --prod` output for the `t3` package. */
  readonly deployDir: string;
  readonly nodeExecutable: string;
  readonly stageParent: string;
}

export interface HeadlessPackageLayout {
  readonly rootDir: string;
  readonly runtimeVersionDir: string;
  readonly nodePath: string;
  readonly launcherPath: string;
  readonly manifestPath: string;
  readonly presetPath: string;
  readonly installScriptPath: string;
  readonly statusScriptPath: string;
  readonly uninstallScriptPath: string;
  readonly unitTemplatePath: string;
}

export interface HeadlessProvenance {
  readonly format: 1;
  readonly artifact: string;
  readonly sha256: string;
  readonly sourceCommit: string;
  readonly version: string;
  readonly arch: HeadlessArch;
  readonly nodeVersion: string;
  readonly platform: "linux";
}

const assertVersion = (version: string): void => {
  if (!SAFE_VERSION.test(version)) {
    throw new Error(
      `Headless package version must be an exact release version, received '${version}'.`,
    );
  }
};

const assertSourceCommit = (sourceCommit: string): void => {
  if (!/^[0-9a-f]{40}$/iu.test(sourceCommit)) {
    throw new Error(
      `Headless package source commit must be a full 40-character git SHA, received '${sourceCommit}'.`,
    );
  }
};

export function assertHeadlessArch(arch: string): asserts arch is HeadlessArch {
  if (arch !== "x64" && arch !== "arm64") {
    throw new Error(`Headless package architecture must be x64 or arm64, received '${arch}'.`);
  }
}

export function headlessArtifactName(version: string, arch: HeadlessArch): string {
  assertVersion(version);
  return `Jarvis-Headless-Node-${version}-linux-${arch}.tar.gz`;
}

export function createHeadlessManifest(input: HeadlessManifestInput): HeadlessManifest {
  assertVersion(input.version);
  assertHeadlessArch(input.arch);
  if (input.nodeVersion.trim().length === 0) {
    throw new Error("Headless package Node version cannot be empty.");
  }
  assertSourceCommit(input.sourceCommit);
  return {
    format: 1,
    product: "Jarvis",
    nodeType: "headless",
    platform: "linux",
    arch: input.arch,
    version: input.version,
    nodeVersion: input.nodeVersion,
    sourceCommit: input.sourceCommit,
    capabilities: {
      ui: false,
      speech: false,
      execution: true,
      projects: true,
      providers: true,
    },
  };
}

export function createHeadlessProvenance(input: {
  readonly artifact: string;
  readonly sha256: string;
  readonly version: string;
  readonly arch: HeadlessArch;
  readonly nodeVersion: string;
  readonly sourceCommit: string;
}): HeadlessProvenance {
  assertVersion(input.version);
  assertHeadlessArch(input.arch);
  assertSourceCommit(input.sourceCommit);
  if (!/^[0-9a-f]{64}$/iu.test(input.sha256)) {
    throw new Error(`Headless package SHA-256 must be a 64-character hex digest.`);
  }
  if (input.artifact.trim().length === 0) {
    throw new Error("Headless package artifact name cannot be empty.");
  }
  if (input.nodeVersion.trim().length === 0) {
    throw new Error("Headless package Node version cannot be empty.");
  }
  return {
    format: 1,
    artifact: input.artifact,
    sha256: input.sha256.toLowerCase(),
    sourceCommit: input.sourceCommit.toLowerCase(),
    version: input.version,
    arch: input.arch,
    nodeVersion: input.nodeVersion,
    platform: "linux",
  };
}

export function formatHeadlessChecksum(sha256: string, artifact: string): string {
  if (!/^[0-9a-f]{64}$/iu.test(sha256)) {
    throw new Error(`Headless package SHA-256 must be a 64-character hex digest.`);
  }
  if (artifact.trim().length === 0) {
    throw new Error("Headless package artifact name cannot be empty.");
  }
  return `${sha256.toLowerCase()}  ${artifact}\n`;
}

function systemdQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/u.test(value)) return value;
  return `"${value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function renderHeadlessSystemdUnit(paths: HeadlessServicePaths): string {
  return [
    "[Unit]",
    "Description=Jarvis Headless Node",
    "After=network.target",
    "StartLimitIntervalSec=300",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${systemdQuote(paths.installRoot)}`,
    `Environment=T3CODE_HOME=${systemdQuote(paths.installRoot)}`,
    "Environment=JARVIS_NODE_PRESET=headless",
    "Environment=T3CODE_NO_BROWSER=true",
    `ExecStart=${systemdQuote(paths.nodePath)} ${systemdQuote(paths.launcherPath)}`,
    "KillMode=mixed",
    "OOMPolicy=continue",
    "Restart=always",
    "RestartSec=5",
    `StandardOutput=append:${systemdQuote(paths.logPath)}`,
    `StandardError=append:${systemdQuote(paths.logPath)}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function renderHeadlessInstallScript(): string {
  return `#!/bin/sh
set -eu

archive_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
install_root=\${JARVIS_HEADLESS_HOME:-"\$HOME/.jarvis-headless"}
unit_path="\$HOME/.config/systemd/user/jarvis-headless.service"

die() {
  echo "Jarvis Headless Node: \$*" >&2
  exit 1
}

case "\$install_root" in
  ""|"/"|"\$HOME") die "refusing unsafe install location: \$install_root" ;;
esac

command -v systemctl >/dev/null 2>&1 || die "systemd is required (systemctl was not found)"
systemctl --user show-environment >/dev/null 2>&1 || die "the user systemd manager is unavailable; start a user session or enable lingering with: loginctl enable-linger \$USER"

test -x "\$archive_root/node/bin/node" || die "archive is missing node/bin/node"
test -f "\$archive_root/runtime/service-launcher.mjs" || die "archive is missing the service launcher"
test -f "\$archive_root/runtime/service-state.json" || die "archive is missing runtime state"
test -f "\$archive_root/manifest.json" || die "archive is missing its manifest"
test -d "\$archive_root/bin" || die "archive is missing management helpers"
for part in node runtime config manifest.json bin; do
  test -e "\$archive_root/\$part" || die "archive is missing \$part"
done

mkdir -p "\$install_root" "\$HOME/.config/systemd/user"
incoming=\$(mktemp -d "\${install_root}.incoming.XXXXXX")
previous=\$(mktemp -d "\${install_root}.previous.XXXXXX")
cleanup() {
  rm -rf "\$incoming" "\$previous"
}
restore() {
  for part in node runtime config manifest.json bin; do
    rm -rf "\$install_root/\$part"
    if test -e "\$previous/\$part" || test -L "\$previous/\$part"; then
      mv "\$previous/\$part" "\$install_root/\$part"
    fi
  done
  if test -e "\$previous/unit" || test -L "\$previous/unit"; then
    mv "\$previous/unit" "\$unit_path"
  else
    rm -f "\$unit_path"
  fi
  cleanup
}
trap restore HUP INT TERM EXIT

# Stop before replacing the launcher/runtime. User data is deliberately not in
# this list: userdata, worktrees, caches, and provider credentials survive an update.
systemctl --user stop jarvis-headless.service >/dev/null 2>&1 || true
if test -e "\$unit_path"; then
  mv "\$unit_path" "\$previous/unit"
fi
for part in node runtime config manifest.json bin; do
  if test -e "\$install_root/\$part"; then
    mv "\$install_root/\$part" "\$previous/\$part"
  fi
done
for part in node runtime config manifest.json bin; do
  cp -a "\$archive_root/\$part" "\$incoming/\$part"
done
for part in node runtime config manifest.json bin; do
  mv "\$incoming/\$part" "\$install_root/\$part"
done

mkdir -p "\$install_root/userdata/logs"
node_path="\$install_root/node/bin/node"
launcher_path="\$install_root/runtime/service-launcher.mjs"
log_path="\$install_root/userdata/logs/boot-service.log"

systemd_quote() {
  escaped=\$(printf '%s' "\$1" | sed 's/%/%%/g; s/\\\\/\\\\\\\\/g; s/"/\\\\"/g')
  case "\$escaped" in
    *[!A-Za-z0-9_./:@+-]*) printf '"%s"' "\$escaped" ;;
    *) printf '%s' "\$escaped" ;;
  esac
}
unit_install_root=\$(systemd_quote "\$install_root")
unit_node=\$(systemd_quote "\$node_path")
unit_launcher=\$(systemd_quote "\$launcher_path")
unit_log=\$(systemd_quote "\$log_path")

cat > "\$unit_path" <<EOF
[Unit]
Description=Jarvis Headless Node
After=network.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=\$unit_install_root
Environment=T3CODE_HOME=\$unit_install_root
Environment=JARVIS_NODE_PRESET=headless
Environment=T3CODE_NO_BROWSER=true
ExecStart=\$unit_node \$unit_launcher
KillMode=mixed
OOMPolicy=continue
Restart=always
RestartSec=5
StandardOutput=append:\$unit_log
StandardError=append:\$unit_log

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now ${SERVICE_NAME}
trap - HUP INT TERM EXIT
rm -rf "\$previous"
echo "Jarvis Headless Node installed at \$install_root"
echo "Pair it with: \$node_path \$install_root/runtime/versions/*/node_modules/t3/dist/bin.mjs pair"
`;
}

export function renderHeadlessStatusScript(): string {
  return `#!/bin/sh
set -u

install_root=\${JARVIS_HEADLESS_HOME:-"\$HOME/.jarvis-headless"}
unit=jarvis-headless.service
echo "Jarvis Headless Node"
echo "  Install: \$install_root"
if test -f "\$install_root/manifest.json"; then
  echo "  Manifest: \$install_root/manifest.json"
else
  echo "  Status: not installed"
  exit 0
fi
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  systemctl --user --no-pager status "\$unit" || true
else
  echo "  Service: user systemd manager unavailable"
fi
`;
}

export function renderHeadlessUninstallScript(): string {
  return `#!/bin/sh
set -eu

install_root=\${JARVIS_HEADLESS_HOME:-"\$HOME/.jarvis-headless"}
unit_path="\$HOME/.config/systemd/user/jarvis-headless.service"
purge=false
if test "\${1:-}" = "--purge-data"; then
  purge=true
elif test "\${1:-}" != ""; then
  echo "Usage: \$0 [--purge-data]" >&2
  exit 2
fi

case "\$install_root" in
  ""|"/"|"\$HOME") echo "Refusing unsafe uninstall location: \$install_root" >&2; exit 1 ;;
esac

if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  systemctl --user disable --now jarvis-headless.service >/dev/null 2>&1 || true
  systemctl --user daemon-reload >/dev/null 2>&1 || true
fi
rm -f "\$unit_path"
if test "\$purge" = true; then
  rm -rf "\$install_root"
  echo "Removed Jarvis Headless Node and its data from \$install_root"
else
  rm -rf "\$install_root/node" "\$install_root/runtime" "\$install_root/config" "\$install_root/bin" "\$install_root/manifest.json"
  echo "Removed Jarvis Headless Node; preserved user data under \$install_root/userdata"
  echo "Use --purge-data to remove that data too"
fi
`;
}

export function createHeadlessArchiveCommand(
  rootDir: string,
  outputPath: string,
): { readonly command: "tar"; readonly args: ReadonlyArray<string> } {
  return {
    command: "tar",
    args: [
      "--create",
      "--gzip",
      "--file",
      outputPath,
      "--sort=name",
      "--mtime=@0",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "--directory",
      Path.dirname(rootDir),
      Path.basename(rootDir),
    ],
  };
}

async function ensureFile(filePath: string, description: string): Promise<void> {
  const stat = await FileSystem.stat(filePath).catch(() => undefined);
  if (stat?.isFile() !== true) throw new Error(`${description} was not found: ${filePath}`);
}

async function ensureDirectory(directoryPath: string, description: string): Promise<void> {
  const stat = await FileSystem.stat(directoryPath).catch(() => undefined);
  if (stat?.isDirectory() !== true)
    throw new Error(`${description} was not found: ${directoryPath}`);
}

async function ensureAbsent(filePath: string, description: string): Promise<void> {
  const stat = await FileSystem.stat(filePath).catch(() => undefined);
  if (stat !== undefined) throw new Error(`${description} must not be staged: ${filePath}`);
}

async function removeSourceMaps(directory: string): Promise<void> {
  const entries = await FileSystem.readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = Path.join(directory, entry.name);
      if (entry.isDirectory()) return removeSourceMaps(entryPath);
      if (entry.name.endsWith(".map")) await FileSystem.rm(entryPath, { force: true });
    }),
  );
}

async function rewriteDeploySymlinks(
  deployDir: string,
  stagedDeployDir: string,
  directory: string,
): Promise<void> {
  const packageIdentity = async (directoryPath: string): Promise<string | undefined> => {
    try {
      const packageJson = JSON.parse(
        await FileSystem.readFile(Path.join(directoryPath, "package.json"), "utf8"),
      ) as { readonly name?: unknown; readonly version?: unknown };
      return typeof packageJson.name === "string" && typeof packageJson.version === "string"
        ? `${packageJson.name}@${packageJson.version}`
        : undefined;
    } catch {
      return undefined;
    }
  };
  const deployIdentity = await packageIdentity(deployDir);
  const entries = await FileSystem.readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = Path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await rewriteDeploySymlinks(deployDir, stagedDeployDir, entryPath);
        return;
      }
      if (!entry.isSymbolicLink()) return;
      const linkTarget = await FileSystem.readlink(entryPath);
      const resolvedSource = Path.resolve(Path.dirname(entryPath), linkTarget);
      const relativeSource = Path.relative(deployDir, resolvedSource);
      const targetIsOutsideDeploy =
        relativeSource.startsWith("..") || Path.isAbsolute(relativeSource);
      let stagedTarget: string;
      if (targetIsOutsideDeploy) {
        // The legacy deployer leaves the package's self-link pointing back to
        // the workspace package. It is safe to redirect only when package
        // identity proves that this is the deployed package itself.
        if (
          deployIdentity === undefined ||
          (await packageIdentity(resolvedSource)) !== deployIdentity
        ) {
          throw new Error(`Production deploy contains a link outside its root: ${entryPath}`);
        }
        stagedTarget = stagedDeployDir;
      } else {
        stagedTarget = Path.join(stagedDeployDir, relativeSource);
      }
      const relativeTarget = Path.relative(Path.dirname(entryPath), stagedTarget);
      await FileSystem.unlink(entryPath);
      await FileSystem.symlink(relativeTarget, entryPath);
    }),
  );
}

export async function stageHeadlessNode(
  input: StageHeadlessNodeInput,
): Promise<HeadlessPackageLayout> {
  const manifest = createHeadlessManifest(input);
  await ensureFile(input.nodeExecutable, "Node executable");
  await ensureDirectory(input.deployDir, "deployed runtime directory");
  await ensureFile(Path.join(input.deployDir, "dist", "bin.mjs"), "deployed server entrypoint");
  await ensureDirectory(
    Path.join(input.deployDir, "node_modules"),
    "deployed production dependencies",
  );
  await ensureFile(
    Path.join(input.deployDir, "dist", "service-launcher.mjs"),
    "deployed service launcher",
  );

  const rootDir = Path.join(
    input.stageParent,
    `jarvis-headless-node-${input.version}-linux-${input.arch}`,
  );
  await FileSystem.rm(rootDir, { recursive: true, force: true });
  const runtimeVersionDir = Path.join(rootDir, "runtime", "versions", input.version);
  const t3PackageDir = Path.join(runtimeVersionDir, "node_modules", "t3");
  await FileSystem.mkdir(Path.join(rootDir, "node", "bin"), { recursive: true });
  await FileSystem.mkdir(t3PackageDir, { recursive: true });
  await FileSystem.mkdir(Path.join(rootDir, "config"), { recursive: true });

  const nodePath = Path.join(rootDir, "node", "bin", "node");
  await FileSystem.copyFile(input.nodeExecutable, nodePath);
  await FileSystem.chmod(nodePath, 0o755);
  await FileSystem.cp(input.deployDir, t3PackageDir, {
    recursive: true,
  });
  // `pnpm deploy --legacy` uses absolute links into its temporary output. Keep
  // the virtual store only once, but rewrite those links relative to the
  // staged package so the archive survives deploy-directory cleanup.
  await rewriteDeploySymlinks(input.deployDir, t3PackageDir, t3PackageDir);
  // Linux Headless is a server-only artifact. The deployed package can still
  // contain the web build because it is shared with desktop packaging, but a
  // headless node must never ship or serve that UI payload.
  await FileSystem.rm(Path.join(t3PackageDir, "dist", "client"), {
    recursive: true,
    force: true,
  });
  await ensureAbsent(
    Path.join(t3PackageDir, "dist", "client", "index.html"),
    "headless web client",
  );
  // Source maps carry the original repository sources and are not needed by a
  // production headless runtime. The deploy output itself remains untouched.
  await removeSourceMaps(t3PackageDir);
  await FileSystem.rm(Path.join(t3PackageDir, "src"), { recursive: true, force: true });

  const launcherPath = Path.join(rootDir, "runtime", "service-launcher.mjs");
  await FileSystem.copyFile(Path.join(t3PackageDir, "dist", "service-launcher.mjs"), launcherPath);
  await FileSystem.writeFile(
    Path.join(runtimeVersionDir, ".install-complete"),
    `${input.version}\n`,
    "utf8",
  );
  await FileSystem.writeFile(
    Path.join(rootDir, "runtime", "service-state.json"),
    `${JSON.stringify({ protocol: SERVICE_LAUNCHER_PROTOCOL, activeVersion: input.version }, null, 2)}\n`,
    "utf8",
  );

  const manifestPath = Path.join(rootDir, "manifest.json");
  const presetPath = Path.join(rootDir, "config", "node-preset.json");
  await FileSystem.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await FileSystem.writeFile(
    presetPath,
    `${JSON.stringify(
      {
        product: "Jarvis",
        nodeType: "headless",
        capabilities: manifest.capabilities,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const installScriptPath = Path.join(rootDir, "install.sh");
  await FileSystem.writeFile(installScriptPath, renderHeadlessInstallScript(), "utf8");
  await FileSystem.chmod(installScriptPath, 0o755);
  const statusScriptPath = Path.join(rootDir, "bin", "status.sh");
  const uninstallScriptPath = Path.join(rootDir, "bin", "uninstall.sh");
  await FileSystem.mkdir(Path.dirname(statusScriptPath), { recursive: true });
  await FileSystem.writeFile(statusScriptPath, renderHeadlessStatusScript(), "utf8");
  await FileSystem.writeFile(uninstallScriptPath, renderHeadlessUninstallScript(), "utf8");
  await FileSystem.chmod(statusScriptPath, 0o755);
  await FileSystem.chmod(uninstallScriptPath, 0o755);
  const unitTemplatePath = Path.join(
    rootDir,
    "systemd",
    SERVICE_NAME.replace(".service", ".service.in"),
  );
  await FileSystem.mkdir(Path.dirname(unitTemplatePath), { recursive: true });
  await FileSystem.writeFile(
    unitTemplatePath,
    renderHeadlessSystemdUnit({
      installRoot: "@INSTALL_ROOT@",
      nodePath: "@INSTALL_ROOT@/node/bin/node",
      launcherPath: "@INSTALL_ROOT@/runtime/service-launcher.mjs",
      logPath: "@INSTALL_ROOT@/userdata/logs/boot-service.log",
    }),
    "utf8",
  );

  return {
    rootDir,
    runtimeVersionDir,
    nodePath,
    launcherPath,
    manifestPath,
    presetPath,
    installScriptPath,
    statusScriptPath,
    uninstallScriptPath,
    unitTemplatePath,
  };
}

async function readNodeRuntimeVersion(nodeExecutable: string): Promise<string> {
  const result = ChildProcess.spawnSync(nodeExecutable, ["-p", "process.version"], {
    encoding: "utf8",
  });
  if (result.error)
    throw new Error(`Could not inspect bundled Node runtime: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(
      `Could not inspect bundled Node runtime (exit code ${result.status ?? "unknown"}).`,
    );
  }
  const version = result.stdout.trim();
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(`Bundled Node runtime returned an invalid version: '${version}'.`);
  }
  return version;
}

async function readFileSha256(filePath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = Crypto.createHash("sha256");
    const stream = FileSystemSync.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function readSourceCommit(repoRoot: string): Promise<string> {
  const result = ChildProcess.spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.error) throw new Error(`Could not resolve source commit: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`Could not resolve source commit (exit code ${result.status ?? "unknown"}).`);
  }
  const sourceCommit = result.stdout.trim();
  assertSourceCommit(sourceCommit);
  return sourceCommit;
}

async function run(command: string, args: ReadonlyArray<string>, cwd: string): Promise<void> {
  const result = ChildProcess.spawnSync(command, [...args], { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed with exit code ${result.status ?? "unknown"}.`);
}

async function packageHeadlessNode(): Promise<void> {
  if (NodeProcess.platform !== "linux")
    throw new Error("Headless Node packaging currently supports Linux hosts only.");
  const args = process.argv.slice(2);
  const valueFor = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index < 0 ? undefined : args[index + 1];
  };
  const arch = valueFor("--arch") ?? NodeProcess.arch;
  assertHeadlessArch(arch);
  const nodeExecutable = valueFor("--node-executable") ?? process.execPath;
  const deployDirArg = valueFor("--deploy-dir");
  if (arch !== NodeProcess.arch && deployDirArg === undefined) {
    throw new Error(
      `Building linux-${arch} requires --deploy-dir containing production dependencies built for linux-${arch}; native dependencies cannot be cross-compiled by this host.`,
    );
  }
  const outputDir = Path.resolve(valueFor("--output-dir") ?? "release");
  const keepStage = args.includes("--keep-stage");
  const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
  const version = serverPackageJson.version;
  const serverDist = NodePath.join(repoRoot, "apps/server/dist");
  await ensureFile(Path.join(serverDist, "bin.mjs"), "built server bundle");
  await ensureFile(Path.join(serverDist, "service-launcher.mjs"), "built service launcher");

  const tempRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "jarvis-headless-node-"));
  const deployDir =
    deployDirArg === undefined ? Path.join(tempRoot, "deploy") : Path.resolve(deployDirArg);
  const nodeVersion =
    valueFor("--node-version") ??
    (arch === NodeProcess.arch ? await readNodeRuntimeVersion(nodeExecutable) : undefined);
  if (nodeVersion === undefined) {
    throw new Error(
      `Building linux-${arch} requires --node-version when using a cross-architecture Node runtime.`,
    );
  }
  const sourceCommit = valueFor("--source-commit") ?? (await readSourceCommit(repoRoot));
  try {
    if (deployDirArg === undefined) {
      await run("pnpm", ["--filter", "t3", "deploy", "--prod", "--legacy", deployDir], repoRoot);
    }
    const layout = await stageHeadlessNode({
      version,
      arch,
      nodeVersion,
      sourceCommit,
      deployDir,
      nodeExecutable,
      stageParent: tempRoot,
    });
    await FileSystem.mkdir(outputDir, { recursive: true });
    const outputPath = Path.join(outputDir, headlessArtifactName(version, arch));
    const archive = createHeadlessArchiveCommand(layout.rootDir, outputPath);
    await run(archive.command, archive.args, repoRoot);
    const artifact = Path.basename(outputPath);
    const sha256 = await readFileSha256(outputPath);
    await FileSystem.writeFile(
      `${outputPath}.sha256`,
      formatHeadlessChecksum(sha256, artifact),
      "utf8",
    );
    await FileSystem.writeFile(
      `${outputPath}.provenance.json`,
      `${JSON.stringify(
        createHeadlessProvenance({
          artifact,
          sha256,
          sourceCommit,
          version,
          arch,
          nodeVersion,
        }),
        null,
        2,
      )}\n`,
      "utf8",
    );
    console.log(`Created ${outputPath}`);
    console.log(`SHA-256 ${sha256}`);
    if (keepStage) console.log(`Kept staging directory ${layout.rootDir}`);
  } finally {
    if (!keepStage) await FileSystem.rm(tempRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  packageHeadlessNode().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
