// @effect-diagnostics nodeBuiltinImport:off - build-time staging uses node fs/crypto and the host tar.
// @effect-diagnostics globalFetch:off - build-time staging fetches the pinned fx release over plain Node fetch.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/**
 * Stage the pinned fx binary into the desktop artifact's prod resources so a
 * user never installs a harness by hand. fx is Apache-2.0; the release also
 * carries LICENSE and THIRD_PARTY_NOTICES, which are staged beside it.
 *
 * The binary is fetched from the pinned GitHub release and verified against
 * the published SHA-256 before it is extracted. Platforms fx does not publish
 * (for example Windows) skip staging and keep the `~/.fx/bin/fx` fallback.
 */
export const CIRCE_FX_VERSION = "0.0.8";
export const CIRCE_FX_PIN = `v${CIRCE_FX_VERSION}`;
export const CIRCE_FX_RESOURCE_DIR = "fx";
export const DESKTOP_FX_EXTRA_RESOURCE = {
  from: `apps/desktop/prod-resources/${CIRCE_FX_RESOURCE_DIR}`,
  to: CIRCE_FX_RESOURCE_DIR,
} as const;

export type CirceFxBuildPlatform = "linux" | "mac" | "win";
export type CirceFxBuildArch = "x64" | "arm64";

/** Release asset for the target, or null when fx does not publish one. */
export function circeFxReleaseAsset(
  platform: CirceFxBuildPlatform,
  arch: CirceFxBuildArch,
): string | null {
  if (platform === "win") return null;
  const osName = platform === "mac" ? "macos" : "linux";
  const cpu = arch === "arm64" ? "aarch64" : "x86_64";
  return `fx-${osName}-${cpu}.tar.gz`;
}

const releaseBase = (): string =>
  `https://github.com/vercel-labs/fx/releases/download/${CIRCE_FX_PIN}`;

async function download(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not download ${url}: ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/** Reuse a verified archive across builds; the pinned version is the cache key. */
async function fetchVerifiedArchive(asset: string): Promise<Buffer> {
  const cacheDir = NodePath.join(NodeOS.homedir(), ".cache", "circe-fx", CIRCE_FX_PIN);
  const cachedArchive = NodePath.join(cacheDir, asset);
  const cachedChecksum = `${cachedArchive}.sha256`;
  let archive = await NodeFSP.readFile(cachedArchive).catch(() => null);
  let checksum = await NodeFSP.readFile(cachedChecksum, "utf8").catch(() => null);
  if (archive === null || checksum === null) {
    archive = await download(`${releaseBase()}/${asset}`);
    const checksumText = await download(`${releaseBase()}/${asset}.sha256`);
    checksum = checksumText.toString("utf8");
    await NodeFSP.mkdir(cacheDir, { recursive: true });
    await NodeFSP.writeFile(cachedArchive, archive);
    await NodeFSP.writeFile(cachedChecksum, checksum);
  }
  const expected = checksum.trim().split(/\s+/u)[0]?.toLowerCase() ?? "";
  const actual = NodeCrypto.createHash("sha256").update(archive).digest("hex");
  if (expected.length === 0 || expected !== actual) {
    throw new Error(`fx ${asset} failed its SHA-256 check.`);
  }
  return archive;
}

/**
 * Copy the pinned fx binary (and its notices) under
 * `<stageProdResourcesDir>/fx`. Returns the staged directory when fx is
 * published for the target, or null when it is not.
 */
export async function stageCirceFxResources(input: {
  readonly platform: CirceFxBuildPlatform;
  readonly arch: CirceFxBuildArch;
  readonly stageProdResourcesDir: string;
}): Promise<string | null> {
  const asset = circeFxReleaseAsset(input.platform, input.arch);
  if (asset === null) return null;
  const destinationDir = NodePath.join(input.stageProdResourcesDir, CIRCE_FX_RESOURCE_DIR);
  await NodeFSP.rm(destinationDir, { recursive: true, force: true });
  await NodeFSP.mkdir(destinationDir, { recursive: true });
  const archive = await fetchVerifiedArchive(asset);
  const archivePath = NodePath.join(destinationDir, "fx.tar.gz");
  await NodeFSP.writeFile(archivePath, archive);
  try {
    NodeChildProcess.execFileSync("tar", ["-xzf", archivePath, "-C", destinationDir], {
      stdio: "ignore",
    });
  } finally {
    await NodeFSP.rm(archivePath, { force: true });
  }
  const binary = NodePath.join(destinationDir, input.platform === "win" ? "fx.exe" : "fx");
  await NodeFSP.access(binary);
  return destinationDir;
}
