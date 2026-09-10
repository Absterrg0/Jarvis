// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off - GitHub fetch deadlines live at this Promise-native transport boundary.

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeTimers from "node:timers";

export interface GitHubReleaseAsset {
  readonly id: number;
  readonly name: string;
  readonly size: number;
  readonly digest?: string | null;
}

export interface LocalReleaseAsset {
  readonly name: string;
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface GitHubRelease {
  readonly id: number;
  readonly tag_name: string;
  readonly target_commitish: string;
  readonly name: string;
  readonly body: string | null;
  readonly draft: boolean;
  readonly prerelease: boolean;
  /** GitHub currently exposes this only on some release payloads; when present, audit it. */
  readonly make_latest?: "true" | "false" | "legacy";
  readonly upload_url: string;
  assets: GitHubReleaseAsset[];
}

export interface ReleaseTransport {
  listReleases(): Promise<readonly GitHubRelease[]>;
  getRelease(id: number): Promise<GitHubRelease>;
  getLatestRelease(): Promise<GitHubRelease | undefined>;
  createDraft(input: {
    readonly tagName: string;
    readonly targetCommitish: string;
    readonly name: string;
    readonly body: string;
    readonly prerelease: boolean;
    readonly makeLatest: "true" | "false" | "legacy";
  }): Promise<GitHubRelease>;
  patchRelease(
    id: number,
    input: {
      readonly tagName?: string;
      readonly targetCommitish?: string;
      readonly name?: string;
      readonly body?: string;
      readonly draft?: boolean;
      readonly prerelease?: boolean;
      readonly makeLatest?: "true" | "false" | "legacy";
    },
  ): Promise<GitHubRelease>;
  deleteAsset(releaseId: number, assetId: number): Promise<void>;
  uploadAsset(
    releaseId: number,
    uploadUrl: string,
    asset: LocalReleaseAsset,
  ): Promise<GitHubReleaseAsset>;
}

export interface ReleaseTransactionOptions {
  readonly tagName: string;
  readonly targetCommitish: string;
  readonly name: string;
  readonly body: string;
  readonly directory: string;
  readonly prerelease: boolean;
  readonly makeLatest: "true" | "false" | "legacy";
  readonly verifyLocalArtifacts?: (directory: string) => void;
  readonly writeChecksums?: (directory: string) => void;
}

export type ReleasePreflightOptions = Pick<
  ReleaseTransactionOptions,
  "tagName" | "targetCommitish" | "name" | "prerelease" | "makeLatest"
>;

export interface ReleasePreflightResult {
  readonly recoverableReleaseId: number | undefined;
}

export function buildJarvisReleaseBody(input: {
  readonly coreVersion: string;
  readonly channel: "preview" | "stable";
}): string {
  const channelNote =
    input.channel === "preview"
      ? "**Preview only:** these artifacts are unsigned; Windows SmartScreen or macOS Gatekeeper may warn. Verify the hashes before proceeding."
      : "**Stable channel:** publication passed the required signing gates. Verify the release hashes before installation.";

  return [
    `# Jarvis ${input.coreVersion}`,
    "",
    "## Install matrix",
    "",
    "- **Windows:** `Jarvis-Setup.exe` — choose Full, Controller, or Headless during setup.",
    "- **Linux:** Full AppImage, plus Headless x64 and arm64 archives.",
    "- **macOS:** arm64 and x64 DMGs.",
    "",
    "## Verification",
    "",
    "Download `SHA256SUMS` to verify every other release asset's SHA-256 digest; core artifacts also include `.provenance.json` sidecars to inspect before installation.",
    "",
    channelNote,
  ].join("\n");
}

export class ReleaseTransactionError extends Error {
  readonly phase: string;
  readonly releaseId: number | undefined;

  constructor(phase: string, message: string, releaseId?: number) {
    super(`[release transaction:${phase}] ${message}`);
    this.name = "ReleaseTransactionError";
    this.phase = phase;
    this.releaseId = releaseId;
  }
}

const assertReleaseId = (release: GitHubRelease, expectedId: number, phase: string): void => {
  if (release.id !== expectedId) {
    throw new ReleaseTransactionError(
      phase,
      `release lookup returned ${release.id}; expected immutable release ${expectedId}`,
      expectedId,
    );
  }
};

const digestFile = (filePath: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = NodeCrypto.createHash("sha256");
    const stream = NodeFS.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });

const localAssets = async (directory: string): Promise<readonly LocalReleaseAsset[]> => {
  const entries = NodeFS.readdirSync(directory, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile())) {
    throw new ReleaseTransactionError("local", "release staging contains a non-file entry");
  }
  const files = await Promise.all(
    entries.map(async (entry) => {
      const filePath = NodePath.join(directory, entry.name);
      const size = NodeFS.statSync(filePath).size;
      return { name: entry.name, path: filePath, size, sha256: await digestFile(filePath) };
    }),
  );
  return files.sort((left, right) => left.name.localeCompare(right.name));
};

const assertDraftIdentity = (
  release: GitHubRelease,
  options: ReleaseTransactionOptions,
  phase: string,
): void => {
  if (!release.draft) {
    throw new ReleaseTransactionError(
      phase,
      `release ${release.id} is already published`,
      release.id,
    );
  }
  if (release.tag_name !== options.tagName) {
    throw new ReleaseTransactionError(
      phase,
      `release ${release.id} tag is '${release.tag_name}', expected '${options.tagName}'`,
      release.id,
    );
  }
  if (release.target_commitish !== options.targetCommitish) {
    throw new ReleaseTransactionError(
      phase,
      `release ${release.id} target is '${release.target_commitish}', expected '${options.targetCommitish}'`,
      release.id,
    );
  }
  if (release.name !== options.name) {
    throw new ReleaseTransactionError(
      phase,
      `release ${release.id} name is '${release.name}', expected '${options.name}'`,
      release.id,
    );
  }
  if (release.body !== options.body) {
    throw new ReleaseTransactionError(
      phase,
      `release ${release.id} body does not match the current transaction`,
      release.id,
    );
  }
  if (release.prerelease !== options.prerelease) {
    throw new ReleaseTransactionError(
      phase,
      `release ${release.id} prerelease=${String(release.prerelease)}, expected ${String(options.prerelease)}`,
      release.id,
    );
  }
  if (release.make_latest !== undefined && release.make_latest !== options.makeLatest) {
    throw new ReleaseTransactionError(
      phase,
      `release ${release.id} make_latest='${release.make_latest}', expected '${options.makeLatest}'`,
      release.id,
    );
  }
  if (!release.upload_url) {
    throw new ReleaseTransactionError(phase, `release ${release.id} has no upload URL`, release.id);
  }
};

const assertPublishedIdentity = (
  release: GitHubRelease,
  options: ReleaseTransactionOptions,
): void => {
  if (release.draft) {
    throw new ReleaseTransactionError(
      "publish",
      `release ${release.id} remained a draft after publication`,
      release.id,
    );
  }
  if (
    release.tag_name !== options.tagName ||
    release.target_commitish !== options.targetCommitish ||
    release.prerelease !== options.prerelease ||
    release.name !== options.name ||
    release.body !== options.body
  ) {
    throw new ReleaseTransactionError(
      "publish",
      `published release ${release.id} identity does not match ${options.tagName} at ${options.targetCommitish}`,
      release.id,
    );
  }
  if (release.make_latest !== undefined && release.make_latest !== options.makeLatest) {
    throw new ReleaseTransactionError(
      "publish",
      `published release ${release.id} make_latest='${release.make_latest}', expected '${options.makeLatest}'`,
      release.id,
    );
  }
};

const assertLatestRelease = (
  latest: GitHubRelease | undefined,
  release: GitHubRelease,
  options: ReleaseTransactionOptions,
): void => {
  if (options.prerelease) {
    if (latest?.id === release.id || latest?.tag_name === options.tagName) {
      throw new ReleaseTransactionError(
        "publish",
        `preview release ${release.id} unexpectedly became the GitHub latest release`,
        release.id,
      );
    }
    return;
  }
  if (
    latest === undefined ||
    latest.id !== release.id ||
    latest.tag_name !== options.tagName ||
    latest.draft ||
    latest.prerelease
  ) {
    throw new ReleaseTransactionError(
      "publish",
      `stable release ${release.id} is not the GitHub latest release`,
      release.id,
    );
  }
};

const assetNames = (assets: readonly GitHubReleaseAsset[]) =>
  assets.map((asset) => asset.name).sort();

const assertRemoteAssets = (release: GitHubRelease, files: readonly LocalReleaseAsset[]): void => {
  const expectedNames = files.map((file) => file.name).sort();
  const actualNames = assetNames(release.assets);
  if (JSON.stringify(expectedNames) !== JSON.stringify(actualNames)) {
    throw new ReleaseTransactionError(
      "remote-audit",
      `remote asset set mismatch; expected ${expectedNames.join(", ")}, received ${actualNames.join(", ")}`,
      release.id,
    );
  }
  const expected = new Map(files.map((file) => [file.name, file]));
  for (const asset of release.assets) {
    const file = expected.get(asset.name);
    if (!file) continue;
    if (asset.size !== file.size) {
      throw new ReleaseTransactionError(
        "remote-audit",
        `remote asset ${asset.name} size ${asset.size} does not match local size ${file.size}`,
        release.id,
      );
    }
    const remoteDigest = asset.digest ?? "";
    const expectedDigest = `sha256:${file.sha256}`;
    if (remoteDigest !== expectedDigest) {
      throw new ReleaseTransactionError(
        "remote-audit",
        `remote asset ${asset.name} digest '${remoteDigest}' does not match '${expectedDigest}'`,
        release.id,
      );
    }
  }
};

const inspectReleaseState = (
  releases: readonly GitHubRelease[],
  options: ReleasePreflightOptions,
): GitHubRelease | undefined => {
  const published = releases.filter(
    (release) => release.tag_name === options.tagName && !release.draft,
  );
  if (published.length > 0) {
    throw new ReleaseTransactionError(
      "preflight",
      `published release ${options.tagName} already exists; published releases are immutable`,
    );
  }

  const taggedDrafts = releases.filter(
    (release) => release.tag_name === options.tagName && release.draft,
  );
  if (taggedDrafts.length > 1) {
    throw new ReleaseTransactionError(
      "preflight",
      `found ${taggedDrafts.length} draft releases for ${options.tagName}; refusing to guess`,
    );
  }

  const staleUntagged = releases.filter(
    (release) =>
      release.draft && release.tag_name.startsWith("untagged-") && release.name === options.name,
  );
  const candidates = [...taggedDrafts, ...staleUntagged];
  if (candidates.length > 1) {
    const ids = candidates.map((release) => release.id).join(", ");
    throw new ReleaseTransactionError(
      "preflight",
      `found multiple recoverable draft releases (${ids}) for ${options.tagName}; refusing to guess`,
    );
  }

  const recovered = candidates[0];
  return recovered;
};

export async function preflightJarvisRelease(
  transport: ReleaseTransport,
  options: ReleasePreflightOptions,
): Promise<ReleasePreflightResult> {
  try {
    const releases = await transport.listReleases();
    const recovered = inspectReleaseState(releases, options);
    return { recoverableReleaseId: recovered?.id };
  } catch (cause) {
    if (cause instanceof ReleaseTransactionError) throw cause;
    throw new ReleaseTransactionError(
      "preflight",
      cause instanceof Error ? cause.message : String(cause),
    );
  }
}

/**
 * Resume verification of an already-published release without mutating it.
 *
 * A previous run may have published and then failed on a fallible
 * verification read. Retrying must not reject that immutable published
 * state: when the published release matches this transaction's source
 * identity and exact asset set, finish verification read-only and report
 * success. Anything else still refuses explicitly.
 */
const resumePublishedRelease = async (
  transport: ReleaseTransport,
  options: ReleaseTransactionOptions,
  files: readonly LocalReleaseAsset[],
  releases: readonly GitHubRelease[],
): Promise<{ readonly releaseId: number } | undefined> => {
  const published = releases.filter(
    (release) => release.tag_name === options.tagName && !release.draft,
  );
  if (published.length === 0) return undefined;
  if (published.length > 1) {
    throw new ReleaseTransactionError(
      "resume",
      `found ${published.length} published releases for ${options.tagName}; refusing to guess`,
    );
  }
  const candidate = published[0]!;
  // Fail fast on foreign releases from list data alone: a different source
  // identity can never resume, and no read or mutation should follow.
  if (
    candidate.target_commitish !== options.targetCommitish ||
    candidate.prerelease !== options.prerelease ||
    candidate.name !== options.name ||
    candidate.body !== options.body ||
    (candidate.make_latest !== undefined && candidate.make_latest !== options.makeLatest)
  ) {
    throw new ReleaseTransactionError(
      "resume",
      `published release ${options.tagName} does not match this transaction; published releases are immutable`,
      candidate.id,
    );
  }
  try {
    const current = await transport.getRelease(candidate.id);
    assertReleaseId(current, candidate.id, "resume");
    assertPublishedIdentity(current, options);
    assertRemoteAssets(current, files);
    const latest = await transport.getLatestRelease();
    assertLatestRelease(latest, current, options);
    return { releaseId: current.id };
  } catch (cause) {
    if (cause instanceof ReleaseTransactionError) throw cause;
    throw new ReleaseTransactionError(
      "resume",
      cause instanceof Error ? cause.message : String(cause),
      candidate.id,
    );
  }
};

const prepareDraft = async (
  transport: ReleaseTransport,
  options: ReleaseTransactionOptions,
  releases: readonly GitHubRelease[],
): Promise<GitHubRelease> => {
  const recovered = inspectReleaseState(releases, options);
  let release: GitHubRelease;
  if (recovered) {
    release = recovered;
    if (
      release.tag_name.startsWith("untagged-") ||
      release.target_commitish !== options.targetCommitish ||
      release.name !== options.name ||
      release.body !== options.body ||
      release.prerelease !== options.prerelease
    ) {
      release = await transport.patchRelease(release.id, {
        tagName: options.tagName,
        targetCommitish: options.targetCommitish,
        name: options.name,
        body: options.body,
        prerelease: options.prerelease,
        makeLatest: options.makeLatest,
      });
    }
  } else {
    release = await transport.createDraft({
      tagName: options.tagName,
      targetCommitish: options.targetCommitish,
      name: options.name,
      body: options.body,
      prerelease: options.prerelease,
      makeLatest: options.makeLatest,
    });
  }

  assertReleaseId(release, recovered?.id ?? release.id, "prepare");
  const refreshed = await transport.getRelease(release.id);
  assertReleaseId(refreshed, release.id, "prepare");
  assertDraftIdentity(refreshed, options, "prepare");
  return refreshed;
};

export async function runJarvisReleaseTransaction(
  transport: ReleaseTransport,
  options: ReleaseTransactionOptions,
): Promise<{ readonly releaseId: number }> {
  let files: readonly LocalReleaseAsset[];
  try {
    options.verifyLocalArtifacts?.(options.directory);
    options.writeChecksums?.(options.directory);
    files = await localAssets(options.directory);
  } catch (cause) {
    if (cause instanceof ReleaseTransactionError) throw cause;
    throw new ReleaseTransactionError(
      "local",
      cause instanceof Error ? cause.message : String(cause),
    );
  }

  // A previous run may have published before a verification read failed.
  // Resume that immutable result read-only instead of refusing it.
  // The listing is shared with draft preparation below.
  const releases = await transport.listReleases();
  try {
    const resumed = await resumePublishedRelease(transport, options, files, releases);
    if (resumed !== undefined) return resumed;
  } catch (cause) {
    if (cause instanceof ReleaseTransactionError) throw cause;
    throw new ReleaseTransactionError(
      "resume",
      cause instanceof Error ? cause.message : String(cause),
    );
  }

  let release: GitHubRelease;
  try {
    release = await prepareDraft(transport, options, releases);
  } catch (cause) {
    if (cause instanceof ReleaseTransactionError) throw cause;
    throw new ReleaseTransactionError(
      "preflight",
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  let current = release;
  const releaseId = release.id;
  try {
    const expectedByName = new Map(files.map((file) => [file.name, file]));
    const preservedNames = new Set<string>();
    for (const asset of current.assets) {
      const file = expectedByName.get(asset.name);
      const exact =
        file !== undefined &&
        !preservedNames.has(asset.name) &&
        asset.size === file.size &&
        asset.digest === `sha256:${file.sha256}`;
      if (exact) {
        preservedNames.add(asset.name);
      } else {
        await transport.deleteAsset(releaseId, asset.id);
      }
    }
    current = await transport.getRelease(releaseId);
    assertReleaseId(current, releaseId, "asset-cleanup");
    assertDraftIdentity(current, options, "asset-cleanup");
    assertRemoteAssets(
      current,
      files.filter((file) => preservedNames.has(file.name)),
    );
    for (const file of files.filter((candidate) => !preservedNames.has(candidate.name))) {
      await transport.uploadAsset(releaseId, current.upload_url, file);
      current = await transport.getRelease(releaseId);
      assertReleaseId(current, releaseId, "asset-upload");
      assertDraftIdentity(current, options, "asset-upload");
    }
    assertRemoteAssets(current, files);
    await transport.patchRelease(releaseId, {
      draft: false,
      prerelease: options.prerelease,
      makeLatest: options.makeLatest,
    });
    current = await transport.getRelease(releaseId);
    assertReleaseId(current, releaseId, "publish");
    assertPublishedIdentity(current, options);
    assertRemoteAssets(current, files);
    const latest = await transport.getLatestRelease();
    assertLatestRelease(latest, current, options);
    return { releaseId: current.id };
  } catch (cause) {
    if (cause instanceof ReleaseTransactionError) throw cause;
    throw new ReleaseTransactionError(
      "transaction",
      cause instanceof Error ? cause.message : String(cause),
      current.id,
    );
  }
}

/**
 * Rolling preview publications go through the same coordinator as versioned
 * releases. The desktop preview workflow publishes one unsigned DMG per pull
 * request onto a shared prerelease tag; every mutation below is scoped by
 * the PR marker so one PR can never clobber or remove another PR's asset.
 * The eligibility predicate (open PR still carrying the preview label) is
 * checked before mutating and again after uploading, covering both races
 * between the build, the publish, and a concurrent cleanup.
 */
export type PreviewEligibility = () => Promise<boolean>;

export interface PreviewPublishOptions {
  readonly repository: string;
  readonly tag: string;
  readonly targetCommitish: string;
  readonly prNumber: string;
  readonly file: LocalReleaseAsset;
  readonly isEligible: PreviewEligibility;
}

export type PreviewPublishResult =
  | { readonly published: false }
  | {
      readonly published: true;
      readonly releaseId: number;
      readonly assetName: string;
      readonly downloadUrl: string;
    };

export interface PreviewCleanupOptions {
  readonly tag: string;
  readonly prNumber: string;
  readonly isEligible: PreviewEligibility;
}

export type PreviewCleanupResult =
  | { readonly removed: false }
  | { readonly removed: true; readonly releaseId: number; readonly deleted: ReadonlyArray<string> };

const PREVIEW_RELEASE_NAME = "Desktop preview builds";
const PREVIEW_RELEASE_BODY =
  "Rolling unsigned desktop builds from pull requests with a preview label. Each download is removed when its pull request closes or loses the label. Install stable builds from the latest release instead.";

const previewMarker = (prNumber: string): string => `-pr.${prNumber}.`;

export const previewLocalAsset = async (filePath: string): Promise<LocalReleaseAsset> => ({
  name: NodePath.basename(filePath),
  path: filePath,
  size: NodeFS.statSync(filePath).size,
  sha256: await digestFile(filePath),
});

export async function runPreviewPublish(
  transport: ReleaseTransport,
  options: PreviewPublishOptions,
): Promise<PreviewPublishResult> {
  const marker = previewMarker(options.prNumber);
  if (!options.file.name.includes(marker)) {
    throw new ReleaseTransactionError(
      "preview",
      `refusing to publish '${options.file.name}': it does not carry this PR's '${marker}' marker`,
    );
  }
  if (!(await options.isEligible())) return { published: false };
  let releases = await transport.listReleases();
  let release = releases.find(
    (candidate) => candidate.tag_name === options.tag && !candidate.draft,
  );
  if (release === undefined) {
    try {
      release = await transport.createDraft({
        tagName: options.tag,
        targetCommitish: options.targetCommitish,
        name: PREVIEW_RELEASE_NAME,
        body: PREVIEW_RELEASE_BODY,
        prerelease: true,
        makeLatest: "false",
      });
    } catch {
      // A concurrent publish may have created the rolling release between the
      // check and the create; fall onto it instead of failing the build.
      releases = await transport.listReleases();
      const raced = releases.find(
        (candidate) => candidate.tag_name === options.tag && !candidate.draft,
      );
      if (raced === undefined) {
        throw new ReleaseTransactionError(
          "preview",
          `concurrent creation of '${options.tag}' failed and no release appeared`,
        );
      }
      release = raced;
    }
  }
  let current = await transport.getRelease(release.id);
  assertReleaseId(current, release.id, "preview");
  if (current.draft) {
    current = await transport.patchRelease(current.id, {
      draft: false,
      prerelease: true,
      makeLatest: "false",
    });
    assertReleaseId(current, release.id, "preview");
  }
  if (current.prerelease !== true) {
    throw new ReleaseTransactionError(
      "preview",
      `release '${options.tag}' is not a prerelease; refusing to touch it`,
      current.id,
    );
  }
  for (const asset of current.assets.filter((candidate) => candidate.name.includes(marker))) {
    await transport.deleteAsset(current.id, asset.id);
  }
  const uploaded = await transport.uploadAsset(current.id, current.upload_url, options.file);
  current = await transport.getRelease(current.id);
  assertReleaseId(current, release.id, "preview");
  const present = current.assets.find(
    (candidate) => candidate.name === uploaded.name && candidate.size === options.file.size,
  );
  if (present === undefined) {
    throw new ReleaseTransactionError(
      "preview",
      `uploaded asset '${uploaded.name}' is missing after upload`,
      current.id,
    );
  }
  if (!(await options.isEligible())) {
    await transport.deleteAsset(current.id, present.id);
    return { published: false };
  }
  return {
    published: true,
    releaseId: current.id,
    assetName: present.name,
    downloadUrl: `https://github.com/${options.repository}/releases/download/${options.tag}/${present.name}`,
  };
}

export async function runPreviewCleanup(
  transport: ReleaseTransport,
  options: PreviewCleanupOptions,
): Promise<PreviewCleanupResult> {
  // A stale cleanup must not remove a download that became valid again. When
  // the PR is open and labeled once more, the next publish owns this PR's
  // assets and replaces them itself.
  if (await options.isEligible()) return { removed: false };
  const releases = await transport.listReleases();
  const release = releases.find(
    (candidate) => candidate.tag_name === options.tag && !candidate.draft,
  );
  if (release === undefined) return { removed: false };
  const current = await transport.getRelease(release.id);
  assertReleaseId(current, release.id, "preview-cleanup");
  const marker = previewMarker(options.prNumber);
  const owned = current.assets.filter((candidate) => candidate.name.includes(marker));
  for (const asset of owned) {
    await transport.deleteAsset(current.id, asset.id);
  }
  return { removed: true, releaseId: current.id, deleted: owned.map((asset) => asset.name) };
}

interface GitHubApiRelease extends Omit<GitHubRelease, "assets"> {
  readonly assets: GitHubReleaseAsset[];
}

const parseRelease = (value: unknown): GitHubRelease => {
  const release = value as GitHubApiRelease;
  if (
    !release ||
    typeof release.id !== "number" ||
    typeof release.tag_name !== "string" ||
    typeof release.target_commitish !== "string" ||
    typeof release.draft !== "boolean" ||
    typeof release.prerelease !== "boolean" ||
    typeof release.upload_url !== "string" ||
    !Array.isArray(release.assets)
  ) {
    throw new Error("GitHub returned an invalid release payload");
  }
  return release;
};

export function createGitHubReleaseTransport(input: {
  readonly repository: string;
  readonly token: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly requestTimeoutMs?: number;
  readonly uploadTimeoutMs?: number;
  readonly maxReleasePages?: number;
}): ReleaseTransport {
  const request = input.fetch ?? globalThis.fetch;
  const requestTimeoutMs = input.requestTimeoutMs ?? 120_000;
  const uploadTimeoutMs = input.uploadTimeoutMs ?? 600_000;
  const maxReleasePages = input.maxReleasePages ?? 10;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error("GitHub request timeout must be a positive integer.");
  }
  if (!Number.isSafeInteger(maxReleasePages) || maxReleasePages <= 0) {
    throw new Error("GitHub release page limit must be a positive integer.");
  }
  if (!Number.isSafeInteger(uploadTimeoutMs) || uploadTimeoutMs <= 0) {
    throw new Error("GitHub asset upload timeout must be a positive integer.");
  }
  const api = `https://api.github.com/repos/${input.repository}`;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${input.token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const requestWithDeadline = async <T>(
    url: string,
    init: RequestInit | undefined,
    consume: (response: Response) => Promise<T> | T,
    timeoutMs = requestTimeoutMs,
  ): Promise<T> => {
    const controller = new AbortController();
    const timeout = NodeTimers.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await request(url, {
        ...init,
        headers: { ...headers, ...init?.headers },
        signal: controller.signal,
      });
      return await consume(response);
    } catch (cause) {
      if (controller.signal.aborted) {
        throw new Error(`GitHub request timed out after ${timeoutMs}ms: ${url}`, { cause });
      }
      throw cause;
    } finally {
      NodeTimers.clearTimeout(timeout);
    }
  };
  const call = async (
    url: string,
    init?: RequestInit,
    timeoutMs = requestTimeoutMs,
  ): Promise<unknown> =>
    requestWithDeadline(
      url,
      init,
      async (response) => {
        if (!response.ok)
          throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
        if (response.status === 204) return undefined;
        return response.json();
      },
      timeoutMs,
    );
  return {
    async listReleases() {
      const releases: GitHubRelease[] = [];
      let url: string | undefined = `${api}/releases?per_page=100`;
      let pageCount = 0;
      while (url) {
        if (pageCount >= maxReleasePages) {
          throw new Error(`GitHub release pagination exceeded ${maxReleasePages} pages.`);
        }
        pageCount += 1;
        url = await requestWithDeadline(
          url,
          undefined,
          async (response) => {
            if (!response.ok)
              throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
            const payload = (await response.json()) as unknown[];
            releases.push(...payload.map(parseRelease));
            const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "");
            return next?.[1];
          },
          requestTimeoutMs,
        );
      }
      return releases;
    },
    async getRelease(id) {
      return parseRelease(await call(`${api}/releases/${id}`));
    },
    async getLatestRelease() {
      return requestWithDeadline(
        `${api}/releases/latest`,
        undefined,
        async (response) => {
          if (response.status === 404) return undefined;
          if (!response.ok)
            throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
          return parseRelease(await response.json());
        },
        requestTimeoutMs,
      );
    },
    async createDraft(input) {
      return parseRelease(
        await call(`${api}/releases`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tag_name: input.tagName,
            target_commitish: input.targetCommitish,
            name: input.name,
            body: input.body,
            draft: true,
            prerelease: input.prerelease,
            make_latest: input.makeLatest,
          }),
        }),
      );
    },
    async patchRelease(id, input) {
      return parseRelease(
        await call(`${api}/releases/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...(input.tagName === undefined ? {} : { tag_name: input.tagName }),
            ...(input.targetCommitish === undefined
              ? {}
              : { target_commitish: input.targetCommitish }),
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.body === undefined ? {} : { body: input.body }),
            ...(input.draft === undefined ? {} : { draft: input.draft }),
            ...(input.prerelease === undefined ? {} : { prerelease: input.prerelease }),
            ...(input.makeLatest === undefined ? {} : { make_latest: input.makeLatest }),
          }),
        }),
      );
    },
    async deleteAsset(releaseId, assetId) {
      await call(`${api}/releases/assets/${assetId}`, { method: "DELETE" });
      void releaseId;
    },
    async uploadAsset(releaseId, uploadUrl, asset) {
      void releaseId;
      const baseUrl = uploadUrl.replace(/\{[^}]*\}$/, "");
      return (await call(
        `${baseUrl}?name=${encodeURIComponent(asset.name)}`,
        {
          method: "POST",
          headers: {
            "Content-Length": String(asset.size),
            "Content-Type": "application/octet-stream",
          },
          body: NodeFS.createReadStream(asset.path),
          duplex: "half",
        } as RequestInit & { duplex: "half" },
        uploadTimeoutMs,
      )) as GitHubReleaseAsset;
    },
  };
}

const parseBooleanEnvironment = (name: string, fallback: boolean): boolean => {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false, received '${value}'`);
};

const parseMakeLatestEnvironment = (): "true" | "false" | "legacy" => {
  const value = process.env.JARVIS_RELEASE_MAKE_LATEST?.trim().toLowerCase();
  if (value === undefined || value === "") return "true";
  if (value === "true" || value === "false" || value === "legacy") return value;
  throw new Error(`JARVIS_RELEASE_MAKE_LATEST must be true, false, or legacy, received '${value}'`);
};

const previewEligibilityViaGh = async (repository: string, prNumber: string): Promise<boolean> => {
  const label = process.env.JARVIS_PREVIEW_LABEL?.trim() || "preview:mac";
  const viewed = NodeChildProcess.spawnSync(
    "gh",
    [
      "pr",
      "view",
      prNumber,
      "--repo",
      repository,
      "--json",
      "state,labels",
      "--jq",
      `.state + " " + (.labels | map(.name) | contains(["${label}"]) | tostring)`,
    ],
    { encoding: "utf8" },
  );
  return viewed.status === 0 && viewed.stdout.trim() === "OPEN true";
};

const runPreviewCli = async (mode: "preview-publish" | "preview-cleanup"): Promise<void> => {
  const [assetPath] = process.argv.slice(3);
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  const prNumber = process.env.JARVIS_PREVIEW_PR_NUMBER?.trim();
  const tag = process.env.JARVIS_PREVIEW_TAG?.trim() || "desktop-preview";
  if (!repository || !token) {
    throw new Error("preview release needs GITHUB_REPOSITORY and GH_TOKEN");
  }
  if (!prNumber) throw new Error("preview release needs JARVIS_PREVIEW_PR_NUMBER");
  const transport = createGitHubReleaseTransport({ repository, token });
  const isEligible = (): Promise<boolean> => previewEligibilityViaGh(repository, prNumber);
  if (mode === "preview-cleanup") {
    const result = await runPreviewCleanup(transport, { tag, prNumber, isEligible });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const target = process.env.JARVIS_PREVIEW_TARGET?.trim();
  if (!assetPath) {
    throw new Error(
      "usage: node scripts/jarvis-release-transaction.ts preview-publish <asset-path> (with GITHUB_REPOSITORY, GH_TOKEN, JARVIS_PREVIEW_PR_NUMBER, JARVIS_PREVIEW_TARGET)",
    );
  }
  if (!target) throw new Error("preview publish needs JARVIS_PREVIEW_TARGET");
  const result = await runPreviewPublish(transport, {
    repository,
    tag,
    targetCommitish: target,
    prNumber,
    file: await previewLocalAsset(assetPath),
    isEligible,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
};

const runCli = async (): Promise<void> => {
  const [firstArgument, secondArgument, thirdArgument] = process.argv.slice(2);
  if (firstArgument === "preview-publish" || firstArgument === "preview-cleanup") {
    await runPreviewCli(firstArgument);
    return;
  }
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  const preflightOnly = firstArgument === "preflight";
  const directory = preflightOnly ? undefined : firstArgument;
  const version = secondArgument;
  const sourceCommit = thirdArgument;
  if ((!preflightOnly && !directory) || !version || !sourceCommit || !repository || !token) {
    throw new Error(
      "usage: node scripts/jarvis-release-transaction.ts [preflight] <directory-or-version> <version-or-source-commit> [source-commit] (with GITHUB_REPOSITORY and GH_TOKEN)",
    );
  }
  const transport = createGitHubReleaseTransport({ repository, token });
  const prerelease = parseBooleanEnvironment("JARVIS_RELEASE_PRERELEASE", false);
  const makeLatest = parseMakeLatestEnvironment();
  const tagName = process.env.JARVIS_RELEASE_TAG?.trim() || `v${version}`;
  const channel = process.env.JARVIS_RELEASE_CHANNEL?.trim().toLowerCase();
  const releaseChannel: "preview" | "stable" =
    prerelease || channel === "preview" ? "preview" : "stable";
  const releaseOptions = {
    tagName,
    targetCommitish: sourceCommit,
    name: prerelease ? `Jarvis ${version} Preview` : `Jarvis ${version}`,
    body: buildJarvisReleaseBody({
      coreVersion: version,
      channel: releaseChannel,
    }),
    prerelease,
    makeLatest,
  };
  if (preflightOnly) {
    await preflightJarvisRelease(transport, releaseOptions);
    return;
  }
  // @ts-expect-error The verifier is a directly executable Node module without a declaration file.
  const verifier = await import("./verify-jarvis-release.mjs");
  await runJarvisReleaseTransaction(transport, {
    ...releaseOptions,
    directory: directory!,
    verifyLocalArtifacts: (path) =>
      verifier.verifyJarvisReleaseDirectory(path, { version, sourceCommit }),
    writeChecksums: verifier.writeJarvisSha256Sums,
  });
};

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli().catch((cause) => {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  });
}
