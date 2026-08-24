// @effect-diagnostics nodeBuiltinImport:off

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  ReleaseTransactionError,
  createGitHubReleaseTransport,
  preflightJarvisRelease,
  runJarvisReleaseTransaction,
  type GitHubRelease,
  type GitHubReleaseAsset,
  type LocalReleaseAsset,
  type ReleaseTransport,
} from "./jarvis-release-transaction.js";

const sha256 = (contents: string) => NodeCrypto.createHash("sha256").update(contents).digest("hex");

class FakeTransport implements ReleaseTransport {
  readonly calls: string[] = [];
  readonly patches: Array<Parameters<ReleaseTransport["patchRelease"]>[1]> = [];
  releases: GitHubRelease[] = [];
  nextId = 100;
  publishPatchResponseDraft = false;

  async listReleases(): Promise<readonly GitHubRelease[]> {
    this.calls.push("list");
    return this.releases;
  }

  async getRelease(id: number): Promise<GitHubRelease> {
    this.calls.push(`get:${id}`);
    const release = this.releases.find((candidate) => candidate.id === id);
    if (!release) throw new Error(`missing release ${id}`);
    return release;
  }

  async createDraft(input: {
    readonly tagName: string;
    readonly targetCommitish: string;
    readonly name: string;
    readonly body: string;
    readonly prerelease: boolean;
    readonly makeLatest: "true" | "false" | "legacy";
  }): Promise<GitHubRelease> {
    this.calls.push("create");
    const release: GitHubRelease = {
      id: this.nextId++,
      tag_name: input.tagName,
      target_commitish: input.targetCommitish,
      name: input.name,
      body: input.body,
      draft: true,
      prerelease: input.prerelease,
      make_latest: input.makeLatest,
      upload_url: "https://uploads.example/releases/100/assets{?name,label}",
      assets: [],
    };
    this.releases.push(release);
    return release;
  }

  async patchRelease(
    id: number,
    input: {
      readonly tagName?: string;
      readonly targetCommitish?: string;
      readonly draft?: boolean;
      readonly prerelease?: boolean;
      readonly makeLatest?: "true" | "false" | "legacy";
    },
  ): Promise<GitHubRelease> {
    this.calls.push(`patch:${id}`);
    this.patches.push(input);
    const release = await this.getRelease(id);
    Object.assign(release, {
      ...(input.tagName === undefined ? {} : { tag_name: input.tagName }),
      ...(input.targetCommitish === undefined ? {} : { target_commitish: input.targetCommitish }),
      ...(input.draft === undefined ? {} : { draft: input.draft }),
      ...(input.prerelease === undefined ? {} : { prerelease: input.prerelease }),
      ...(input.makeLatest === undefined ? {} : { make_latest: input.makeLatest }),
    });
    return input.draft === false && this.publishPatchResponseDraft
      ? { ...release, draft: true }
      : release;
  }

  async deleteAsset(releaseId: number, assetId: number): Promise<void> {
    this.calls.push(`delete:${releaseId}:${assetId}`);
    const release = await this.getRelease(releaseId);
    release.assets = release.assets.filter((asset: GitHubReleaseAsset) => asset.id !== assetId);
  }

  async uploadAsset(
    releaseId: number,
    uploadUrl: string,
    file: LocalReleaseAsset,
  ): Promise<GitHubReleaseAsset> {
    this.calls.push(`upload:${releaseId}:${file.name}`);
    expect(uploadUrl).toContain("uploads.example");
    const asset: GitHubReleaseAsset = {
      id: this.nextId++,
      name: file.name,
      size: file.size,
      digest: `sha256:${file.sha256}`,
    };
    const release = await this.getRelease(releaseId);
    release.assets.push(asset);
    return asset;
  }
}

function makeDirectory(files: Record<string, string>): string {
  const directory = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "jarvis-release-transaction-"),
  );
  for (const [name, contents] of Object.entries(files)) {
    NodeFS.writeFileSync(NodePath.join(directory, name), contents);
  }
  return directory;
}

const options = (directory: string) => ({
  tagName: "v1.2.3",
  targetCommitish: "a".repeat(40),
  name: "Jarvis 1.2.3",
  body: "Jarvis 1.2.3",
  directory,
  prerelease: false,
  makeLatest: "true" as const,
});

describe("Jarvis release transaction", () => {
  it("preflights release state read-only and permits one repairable draft", async () => {
    const transport = new FakeTransport();
    transport.releases = [
      {
        id: 9,
        tag_name: "untagged-old-run",
        target_commitish: "old-failed-commit",
        name: "Jarvis 1.2.3",
        body: "Jarvis 1.2.3",
        draft: true,
        prerelease: false,
        upload_url: "https://uploads.example/releases/9/assets{?name,label}",
        assets: [],
      },
    ];
    const result = await preflightJarvisRelease(transport, {
      tagName: "v1.2.3",
      targetCommitish: "a".repeat(40),
      name: "Jarvis 1.2.3",
      prerelease: false,
      makeLatest: "true",
    });
    expect(result).toEqual({ recoverableReleaseId: 9 });
    expect(transport.calls).toEqual(["list"]);
    expect(transport.patches).toEqual([]);
  });

  it("creates once, uploads by immutable release id, audits exact assets, and publishes", async () => {
    const directory = makeDirectory({ "one.txt": "one", "two.provenance.json": "two" });
    const transport = new FakeTransport();
    transport.publishPatchResponseDraft = true;
    try {
      await runJarvisReleaseTransaction(transport, options(directory));
      expect(transport.calls).toEqual([
        "list",
        "create",
        "get:100",
        "get:100",
        "upload:100:one.txt",
        "get:100",
        "get:100",
        "upload:100:two.provenance.json",
        "get:100",
        "get:100",
        "patch:100",
        "get:100",
        "get:100",
      ]);
      expect(transport.releases[0]?.draft).toBe(false);
      expect(transport.patches.at(-1)).toEqual({
        draft: false,
        prerelease: false,
        makeLatest: "true",
      });
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a draft whose prerelease identity does not match the requested channel", async () => {
    const directory = makeDirectory({ "one.txt": "one" });
    const transport = new FakeTransport();
    transport.releases = [
      {
        id: 77,
        tag_name: "v1.2.3-preview.9",
        target_commitish: "a".repeat(40),
        name: "Jarvis 1.2.3 Preview",
        body: "preview",
        draft: true,
        prerelease: false,
        upload_url: "https://uploads.example/releases/77/assets{?name,label}",
        assets: [],
      },
    ];
    try {
      await expect(
        runJarvisReleaseTransaction(transport, {
          ...options(directory),
          tagName: "v1.2.3-preview.9",
          name: "Jarvis 1.2.3 Preview",
          body: "preview",
          prerelease: true,
          makeLatest: "false",
        }),
      ).rejects.toMatchObject({ phase: "prepare", releaseId: 77 });
      expect(transport.calls).toEqual(["list", "get:77"]);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("resumes by preserving exact assets and reconciling only stale or unexpected assets", async () => {
    const directory = makeDirectory({ "one.txt": "one", "two.txt": "two" });
    const transport = new FakeTransport();
    transport.releases = [
      {
        id: 55,
        tag_name: "v1.2.3",
        target_commitish: "a".repeat(40),
        name: "Jarvis 1.2.3",
        body: "Jarvis 1.2.3",
        draft: true,
        prerelease: false,
        upload_url: "https://uploads.example/releases/55/assets{?name,label}",
        assets: [
          { id: 1, name: "one.txt", size: 3, digest: `sha256:${sha256("one")}` },
          { id: 2, name: "one.txt", size: 3, digest: `sha256:${sha256("one")}` },
          { id: 3, name: "two.txt", size: 3, digest: "sha256:stale" },
          { id: 4, name: "unexpected.txt", size: 10, digest: "sha256:unexpected" },
        ],
      },
    ];
    try {
      await runJarvisReleaseTransaction(transport, options(directory));
      expect(transport.calls).toContain("upload:55:two.txt");
      expect(transport.calls).not.toContain("upload:55:one.txt");
      expect(transport.calls).toContain("delete:55:2");
      expect(transport.calls).toContain("delete:55:3");
      expect(transport.calls).toContain("delete:55:4");
      expect(transport.releases[0]?.assets.map((asset) => asset.name).sort()).toEqual([
        "one.txt",
        "two.txt",
      ]);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("recovers exactly one tagged draft and sends tag and target together", async () => {
    const directory = makeDirectory({ "one.txt": "one" });
    const transport = new FakeTransport();
    transport.releases = [
      {
        id: 42,
        tag_name: "v1.2.3",
        target_commitish: "old",
        name: "Jarvis 1.2.3",
        body: "old",
        draft: true,
        prerelease: false,
        upload_url: "https://uploads.example/releases/42/assets{?name,label}",
        assets: [],
      },
    ];
    try {
      await runJarvisReleaseTransaction(transport, options(directory));
      expect(transport.calls).toContain("patch:42");
      expect(transport.patches).toContainEqual({
        tagName: "v1.2.3",
        targetCommitish: "a".repeat(40),
        prerelease: false,
        makeLatest: "true",
      });
      expect(transport.releases[0]?.tag_name).toBe("v1.2.3");
      expect(transport.releases[0]?.target_commitish).toBe("a".repeat(40));
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed if a release lookup changes the immutable release id", async () => {
    const directory = makeDirectory({ "one.txt": "one" });
    const transport = new FakeTransport();
    const getRelease = transport.getRelease.bind(transport);
    transport.getRelease = async (id) => ({ ...(await getRelease(id)), id: id + 1 });
    try {
      await expect(
        runJarvisReleaseTransaction(transport, options(directory)),
      ).rejects.toMatchObject({
        phase: "prepare",
        releaseId: 100,
      });
      expect(transport.calls).toEqual(["list", "create", "get:100"]);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("repairs one stale untagged draft while preserving name and body", async () => {
    const directory = makeDirectory({ "one.txt": "one" });
    const transport = new FakeTransport();
    transport.releases = [
      {
        id: 3,
        tag_name: "untagged-123",
        target_commitish: "old-failed-commit",
        name: "Jarvis 1.2.3",
        body: "repair me",
        draft: true,
        prerelease: false,
        upload_url: "https://uploads.example/releases/3/assets{?name,label}",
        assets: [],
      },
    ];
    try {
      await runJarvisReleaseTransaction(transport, options(directory));
      expect(transport.patches[0]).toEqual({
        tagName: "v1.2.3",
        targetCommitish: "a".repeat(40),
        prerelease: false,
        makeLatest: "true",
      });
      expect(transport.releases[0]?.name).toBe("Jarvis 1.2.3");
      expect(transport.releases[0]?.body).toBe("repair me");
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed for published, ambiguous, and multiple stale untagged releases", async () => {
    const directory = makeDirectory({ "one.txt": "one" });
    try {
      for (const releases of [
        [
          {
            id: 1,
            tag_name: "v1.2.3",
            target_commitish: "a".repeat(40),
            name: "Jarvis 1.2.3",
            body: "",
            draft: false,
            prerelease: false,
            upload_url: "",
            assets: [],
          },
        ],
        [
          {
            id: 1,
            tag_name: "v1.2.3",
            target_commitish: "a".repeat(40),
            name: "Jarvis 1.2.3",
            body: "",
            draft: true,
            prerelease: false,
            upload_url: "",
            assets: [],
          },
          {
            id: 2,
            tag_name: "v1.2.3",
            target_commitish: "a".repeat(40),
            name: "Jarvis 1.2.3",
            body: "",
            draft: true,
            prerelease: false,
            upload_url: "",
            assets: [],
          },
        ],
        [
          {
            id: 3,
            tag_name: "untagged-1",
            target_commitish: "a".repeat(40),
            name: "Jarvis 1.2.3",
            body: "",
            draft: true,
            prerelease: false,
            upload_url: "",
            assets: [],
          },
          {
            id: 4,
            tag_name: "untagged-2",
            target_commitish: "a".repeat(40),
            name: "Jarvis 1.2.3",
            body: "",
            draft: true,
            prerelease: false,
            upload_url: "",
            assets: [],
          },
        ],
      ]) {
        const transport = new FakeTransport();
        transport.releases = releases;
        await expect(
          runJarvisReleaseTransaction(transport, options(directory)),
        ).rejects.toBeInstanceOf(ReleaseTransactionError);
        expect(transport.calls).toEqual(["list"]);
      }
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("leaves a draft repairable when an upload or audit fails", async () => {
    const directory = makeDirectory({ "one.txt": "one" });
    const transport = new FakeTransport();
    transport.uploadAsset = async () => {
      throw new Error("upload failed");
    };
    try {
      await expect(runJarvisReleaseTransaction(transport, options(directory))).rejects.toThrow(
        /upload failed/,
      );
      expect(transport.releases[0]?.draft).toBe(true);
      expect(transport.releases[0]?.id).toBe(100);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses GitHub's string make_latest enum and streams upload bodies", async () => {
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const release: GitHubRelease = {
      id: 7,
      tag_name: "v1.2.3",
      target_commitish: "a".repeat(40),
      name: "Jarvis 1.2.3",
      body: "",
      draft: true,
      prerelease: false,
      upload_url: "https://uploads.example/releases/7/assets{?name,label}",
      assets: [],
    };
    const fakeFetch: typeof globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), init: init ?? {} });
      const url = String(input);
      if (url.includes("uploads.example")) {
        const stream = init?.body as AsyncIterable<Uint8Array> | undefined;
        if (stream?.[Symbol.asyncIterator]) {
          for await (const _chunk of stream) {
            // Consume the stream before the temporary fixture is removed.
          }
        }
        return new Response(
          JSON.stringify({ id: 8, name: "one.txt", size: 1, digest: "sha256:x" }),
          {
            status: 201,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify(release), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const transport = createGitHubReleaseTransport({
      repository: "example/jarvis",
      token: "token",
      fetch: fakeFetch,
    });
    const directory = makeDirectory({ "one.txt": "one" });
    try {
      await transport.createDraft({
        tagName: "v1.2.3-preview.9",
        targetCommitish: "a".repeat(40),
        name: "Jarvis 1.2.3 Preview",
        body: "preview",
        prerelease: true,
        makeLatest: "false",
      });
      const create = JSON.parse(String(requests[0]?.init.body));
      expect(create.prerelease).toBe(true);
      expect(create.make_latest).toBe("false");
      await transport.patchRelease(7, {
        draft: false,
        prerelease: false,
        makeLatest: "true",
      });
      const patch = JSON.parse(String(requests[1]?.init.body));
      expect(patch.prerelease).toBe(false);
      expect(patch.make_latest).toBe("true");
      await transport.uploadAsset(7, release.upload_url, {
        name: "one.txt",
        path: NodePath.join(directory, "one.txt"),
        size: 3,
        sha256: "x",
      });
      expect(requests[2]?.init.duplex).toBe("half");
      expect((requests[2]?.init.headers as Record<string, string>)?.["Content-Length"]).toBe("3");
      expect(requests[2]?.init.body).not.toBeInstanceOf(Uint8Array);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});
