// @effect-diagnostics nodeBuiltinImport:off

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";
// prettier-ignore
// @ts-expect-error The verifier is a directly executable Node module.
import { expectedJarvisCompanionReleaseAssets, expectedJarvisReleaseAssets, verifyJarvisReleaseDirectory, writeJarvisSha256Sums } from "./verify-jarvis-release.mjs";

const version = "0.0.39";
const sourceCommit = "a".repeat(40);
const digest = (file: string) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");
const digestSha512 = (file: string) =>
  NodeCrypto.createHash("sha512").update(NodeFS.readFileSync(file)).digest("base64");

function makeFixture() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "jarvis-release-verifier-"));
  const assets: string[] = expectedJarvisReleaseAssets(version);
  for (const name of assets) {
    if (
      !name.endsWith(".sha256") &&
      !name.endsWith(".provenance.json") &&
      name !== "Jarvis-Setup.exe"
    ) {
      NodeFS.writeFileSync(NodePath.join(directory, name), `fixture:${name}`);
    }
  }
  const setup = `Jarvis-Setup-${version}-win-x64.exe`;
  NodeFS.copyFileSync(
    NodePath.join(directory, setup),
    NodePath.join(directory, "Jarvis-Setup.exe"),
  );
  const linux = `Jarvis-${version}-x86_64.AppImage`;
  NodeFS.writeFileSync(
    NodePath.join(directory, `${linux}.provenance.json`),
    JSON.stringify({
      format: 1,
      product: "Jarvis",
      version,
      platform: "linux",
      arch: "x64",
      artifactName: linux,
      artifactSha256: digest(NodePath.join(directory, linux)),
      sourceCommit,
    }),
  );
  for (const arch of ["arm64", "x64"]) {
    const artifact = `Jarvis-${version}-${arch}.dmg`;
    NodeFS.writeFileSync(
      NodePath.join(directory, `${artifact}.provenance.json`),
      JSON.stringify({
        format: 1,
        product: "Jarvis",
        version,
        platform: "mac",
        arch,
        artifactName: artifact,
        artifactSha256: digest(NodePath.join(directory, artifact)),
        sourceCommit,
      }),
    );
  }
  for (const arch of ["x64", "arm64"]) {
    const artifact = `Jarvis-Headless-Node-${version}-linux-${arch}.tar.gz`;
    NodeFS.writeFileSync(
      NodePath.join(directory, `${artifact}.provenance.json`),
      JSON.stringify({
        format: 1,
        artifact,
        sha256: digest(NodePath.join(directory, artifact)),
        sourceCommit,
        version,
        arch,
        nodeVersion: "22.0.0",
        platform: "linux",
      }),
    );
  }
  const manifest = `Jarvis-Setup-${version}-win-x64.exe.manifest.json`;
  const provenance = `Jarvis-Setup-${version}-win-x64.exe.provenance.json`;
  NodeFS.writeFileSync(
    NodePath.join(directory, manifest),
    JSON.stringify({
      format: 3,
      product: "Jarvis",
      version,
      platform: "windows",
      arch: "x64",
      artifactName: setup,
      sourceCommit,
      payloads: [
        { id: "desktop", modes: ["full", "controller"], files: [] },
        { id: "runtime-win", modes: ["headless"], files: [] },
      ],
    }),
  );
  NodeFS.writeFileSync(
    NodePath.join(directory, provenance),
    JSON.stringify({
      format: 1,
      product: "Jarvis",
      version,
      arch: "x64",
      sourceCommit,
      artifactName: setup,
      aliasName: "Jarvis-Setup.exe",
      manifestName: manifest,
      provenanceName: provenance,
      artifactSha256: digest(NodePath.join(directory, setup)),
      manifestSha256: digest(NodePath.join(directory, manifest)),
    }),
  );
  for (const name of assets.filter((asset: string) => asset.endsWith(".sha256"))) {
    const artifact = name.replace(/\.sha256$/, "");
    NodeFS.writeFileSync(
      NodePath.join(directory, name),
      `${digest(NodePath.join(directory, artifact))}  ${artifact}\n`,
    );
  }
  return directory;
}

function addCompanionFixture(directory: string): void {
  const companionAssets = expectedJarvisCompanionReleaseAssets(version).filter(
    (name: string) => !name.endsWith(".yml"),
  );
  for (const name of companionAssets) {
    NodeFS.writeFileSync(NodePath.join(directory, name), `companion:${name}`);
  }
  const windows = companionAssets
    .slice(0, 1)
    .map(
      (name: string) =>
        `  - url: ${name}\n    sha512: ${digestSha512(NodePath.join(directory, name))}\n    size: ${NodeFS.statSync(NodePath.join(directory, name)).size}`,
    )
    .join("\n");
  const linux = companionAssets
    .slice(2)
    .map(
      (name: string) =>
        `  - url: ${name}\n    sha512: ${digestSha512(NodePath.join(directory, name))}\n    size: ${NodeFS.statSync(NodePath.join(directory, name)).size}`,
    )
    .join("\n");
  NodeFS.writeFileSync(
    NodePath.join(directory, "latest.yml"),
    `version: '${version}'\nfiles:\n${windows}\npath: ${companionAssets[0]}\nreleaseDate: '2026-08-24T00:00:00.000Z'\n`,
  );
  NodeFS.writeFileSync(
    NodePath.join(directory, "latest-linux.yml"),
    `version: '${version}'\nfiles:\n${linux}\npath: ${companionAssets[2]}\nreleaseDate: '2026-08-24T00:00:00.000Z'\n`,
  );
}

describe("Jarvis release staging verifier", () => {
  it("accepts the exact cross-platform asset set and writes a deterministic manifest", () => {
    const directory = makeFixture();
    try {
      verifyJarvisReleaseDirectory(directory, { version, sourceCommit });
      const names = writeJarvisSha256Sums(directory);
      assert.deepStrictEqual(names, [...names].sort());
      assert.notInclude(names, "SHA256SUMS");
      assert.isTrue(
        NodeFS.readFileSync(NodePath.join(directory, "SHA256SUMS"), "utf8").includes(
          "Jarvis-Setup.exe",
        ),
      );
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("requires all Companion assets and verifies updater metadata cryptographically", () => {
    const directory = makeFixture();
    addCompanionFixture(directory);
    try {
      verifyJarvisReleaseDirectory(directory, { version, sourceCommit, companionVersion: version });
      const manifestPath = NodePath.join(directory, "latest.yml");
      const manifest = NodeFS.readFileSync(manifestPath, "utf8");
      NodeFS.writeFileSync(manifestPath, manifest.replace(/size: \d+/, "size: 0"));
      assert.throws(
        () =>
          verifyJarvisReleaseDirectory(directory, {
            version,
            sourceCommit,
            companionVersion: version,
          }),
        /Companion size/,
      );
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects an unexpected or missing release asset before publication", () => {
    const directory = makeFixture();
    try {
      NodeFS.unlinkSync(NodePath.join(directory, "Jarvis-Setup.exe"));
      NodeFS.writeFileSync(
        NodePath.join(directory, `Jarvis-${version}-arm64.zip`),
        "unused updater payload",
      );
      assert.throws(
        () => verifyJarvisReleaseDirectory(directory, { version, sourceCommit }),
        /release staging asset set mismatch/,
      );
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a missing or misnamed macOS DMG before publication", () => {
    const directory = makeFixture();
    const artifact = `Jarvis-${version}-x64.dmg`;
    try {
      NodeFS.unlinkSync(NodePath.join(directory, artifact));
      NodeFS.writeFileSync(
        NodePath.join(directory, `Jarvis-${version}-x64.zip`),
        "misnamed macOS payload",
      );
      assert.throws(
        () => verifyJarvisReleaseDirectory(directory, { version, sourceCommit }),
        /release staging asset set mismatch/,
      );
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects non-canonical checksum sidecars", () => {
    const directory = makeFixture();
    const artifact = `Jarvis-${version}-x86_64.AppImage`;
    const sidecar = NodePath.join(directory, `${artifact}.sha256`);
    const canonical = NodeFS.readFileSync(sidecar, "utf8");
    try {
      NodeFS.writeFileSync(sidecar, `${canonical}unexpected-token`);
      assert.throws(
        () => verifyJarvisReleaseDirectory(directory, { version, sourceCommit }),
        /canonical SHA-256 line/,
      );
      NodeFS.writeFileSync(sidecar, `${canonical}\nsecond-line`);
      assert.throws(
        () => verifyJarvisReleaseDirectory(directory, { version, sourceCommit }),
        /canonical SHA-256 line/,
      );
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects provenance and Windows manifest schema tampering", () => {
    const directory = makeFixture();
    const linux = `Jarvis-${version}-x86_64.AppImage`;
    const linuxProvenancePath = NodePath.join(directory, `${linux}.provenance.json`);
    try {
      const linuxProvenance = JSON.parse(NodeFS.readFileSync(linuxProvenancePath, "utf8"));
      linuxProvenance.extra = true;
      NodeFS.writeFileSync(linuxProvenancePath, JSON.stringify(linuxProvenance));
      assert.throws(
        () => verifyJarvisReleaseDirectory(directory, { version, sourceCommit }),
        /provenance keys mismatch/,
      );

      const validDirectory = makeFixture();
      try {
        const manifestPath = NodePath.join(
          validDirectory,
          `Jarvis-Setup-${version}-win-x64.exe.manifest.json`,
        );
        const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8"));
        manifest.platform = "linux";
        NodeFS.writeFileSync(manifestPath, JSON.stringify(manifest));
        NodeFS.writeFileSync(
          `${manifestPath}.sha256`,
          `${digest(manifestPath)}  ${NodePath.basename(manifestPath)}\n`,
        );
        const provenancePath = NodePath.join(
          validDirectory,
          `Jarvis-Setup-${version}-win-x64.exe.provenance.json`,
        );
        const provenance = JSON.parse(NodeFS.readFileSync(provenancePath, "utf8"));
        provenance.manifestSha256 = digest(manifestPath);
        NodeFS.writeFileSync(provenancePath, JSON.stringify(provenance));
        assert.throws(
          () => verifyJarvisReleaseDirectory(validDirectory, { version, sourceCommit }),
          /expected windows, received linux/,
        );
      } finally {
        NodeFS.rmSync(validDirectory, { recursive: true, force: true });
      }
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a mislabeled macOS artifact provenance record", () => {
    const directory = makeFixture();
    const artifact = `Jarvis-${version}-arm64.dmg`;
    const provenancePath = NodePath.join(directory, `${artifact}.provenance.json`);
    try {
      const provenance = JSON.parse(NodeFS.readFileSync(provenancePath, "utf8"));
      provenance.arch = "x64";
      NodeFS.writeFileSync(provenancePath, JSON.stringify(provenance));
      assert.throws(
        () => verifyJarvisReleaseDirectory(directory, { version, sourceCommit }),
        /provenance arch .* expected arm64, received x64/,
      );
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});
