// @effect-diagnostics nodeBuiltinImport:off

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

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
    release.prerelease !== options.prerelease
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

const inspectReleaseState = async (
  transport: ReleaseTransport,
  options: ReleasePreflightOptions,
): Promise<GitHubRelease | undefined> => {
  const releases = await transport.listReleases();
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
    const recovered = await inspectReleaseState(transport, options);
    return { recoverableReleaseId: recovered?.id };
  } catch (cause) {
    if (cause instanceof ReleaseTransactionError) throw cause;
    throw new ReleaseTransactionError(
      "preflight",
      cause instanceof Error ? cause.message : String(cause),
    );
  }
}

const prepareDraft = async (
  transport: ReleaseTransport,
  options: ReleaseTransactionOptions,
): Promise<GitHubRelease> => {
  const recovered = await inspectReleaseState(transport, options);
  let release: GitHubRelease;
  if (recovered) {
    release = recovered;
    if (
      release.tag_name.startsWith("untagged-") ||
      release.target_commitish !== options.targetCommitish
    ) {
      release = await transport.patchRelease(release.id, {
        tagName: options.tagName,
        targetCommitish: options.targetCommitish,
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
  if (recovered && (refreshed.name !== recovered.name || refreshed.body !== recovered.body)) {
    throw new ReleaseTransactionError(
      "prepare",
      `recovered release ${release.id} changed its name or body during repair`,
      release.id,
    );
  }
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

  let release: GitHubRelease;
  try {
    release = await prepareDraft(transport, options);
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
}): ReleaseTransport {
  const request = input.fetch ?? globalThis.fetch;
  const api = `https://api.github.com/repos/${input.repository}`;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${input.token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const call = async (url: string, init?: RequestInit): Promise<unknown> => {
    const response = await request(url, { ...init, headers: { ...headers, ...init?.headers } });
    if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
    if (response.status === 204) return undefined;
    return response.json();
  };
  return {
    async listReleases() {
      const releases: GitHubRelease[] = [];
      let url: string | undefined = `${api}/releases?per_page=100`;
      while (url) {
        const response = await request(url, { headers });
        if (!response.ok)
          throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
        const payload = (await response.json()) as unknown[];
        releases.push(...payload.map(parseRelease));
        const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "");
        url = next?.[1];
      }
      return releases;
    },
    async getRelease(id) {
      return parseRelease(await call(`${api}/releases/${id}`));
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
      return (await call(`${baseUrl}?name=${encodeURIComponent(asset.name)}`, {
        method: "POST",
        headers: {
          "Content-Length": String(asset.size),
          "Content-Type": "application/octet-stream",
        },
        body: NodeFS.createReadStream(asset.path),
        duplex: "half",
      } as RequestInit & { duplex: "half" })) as GitHubReleaseAsset;
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

const runCli = async (): Promise<void> => {
  const [firstArgument, secondArgument, thirdArgument] = process.argv.slice(2);
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
  const previewBody = `Jarvis ${version} preview\n\n⚠️ Preview release: unsigned artifacts may be unsuitable for production use.`;
  const releaseOptions = {
    tagName,
    targetCommitish: sourceCommit,
    name: prerelease ? `Jarvis ${version} Preview` : `Jarvis ${version}`,
    body: prerelease || channel === "preview" ? previewBody : `Jarvis ${version}`,
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
