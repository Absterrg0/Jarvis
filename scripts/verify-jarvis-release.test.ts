// @effect-diagnostics nodeBuiltinImport:off

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assert, describe, it } from "@effect/vitest";
// prettier-ignore
// @ts-expect-error The verifier is a directly executable Node module.
import { expectedJarvisReleaseAssets, verifyJarvisReleaseDirectory, writeJarvisSha256Sums } from "./verify-jarvis-release.mjs";

const version = "0.0.39";
const sourceCommit = "a".repeat(40);
const digest = (file: string) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function makeFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-release-verifier-"));
  const assets: string[] = expectedJarvisReleaseAssets(version);
  for (const name of assets) {
    if (
      !name.endsWith(".sha256") &&
      !name.endsWith(".provenance.json") &&
      name !== "Jarvis-Setup.exe"
    ) {
      fs.writeFileSync(path.join(directory, name), `fixture:${name}`);
    }
  }
  const setup = `Jarvis-Setup-${version}-win-x64.exe`;
  fs.copyFileSync(path.join(directory, setup), path.join(directory, "Jarvis-Setup.exe"));
  const linux = `Jarvis-${version}-x86_64.AppImage`;
  fs.writeFileSync(
    path.join(directory, `${linux}.provenance.json`),
    JSON.stringify({
      format: 1,
      product: "Jarvis",
      version,
      platform: "linux",
      arch: "x64",
      artifactName: linux,
      artifactSha256: digest(path.join(directory, linux)),
      sourceCommit,
    }),
  );
  for (const arch of ["x64", "arm64"]) {
    const artifact = `Jarvis-Headless-Node-${version}-linux-${arch}.tar.gz`;
    fs.writeFileSync(
      path.join(directory, `${artifact}.provenance.json`),
      JSON.stringify({
        format: 1,
        artifact,
        sha256: digest(path.join(directory, artifact)),
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
  fs.writeFileSync(
    path.join(directory, manifest),
    JSON.stringify({
      format: 2,
      product: "Jarvis",
      version,
      platform: "windows",
      arch: "x64",
      artifactName: setup,
      sourceCommit,
      payloads: [
        { id: "desktop", modes: ["full"], files: [] },
        { id: "companion", modes: ["full", "controller"], files: [] },
        { id: "runtime-win", modes: ["headless"], files: [] },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(directory, provenance),
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
      artifactSha256: digest(path.join(directory, setup)),
      manifestSha256: digest(path.join(directory, manifest)),
    }),
  );
  for (const name of assets.filter((asset: string) => asset.endsWith(".sha256"))) {
    const artifact = name.replace(/\.sha256$/, "");
    fs.writeFileSync(
      path.join(directory, name),
      `${digest(path.join(directory, artifact))}  ${artifact}\n`,
    );
  }
  return directory;
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
        fs.readFileSync(path.join(directory, "SHA256SUMS"), "utf8").includes("Jarvis-Setup.exe"),
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects an unexpected or missing release asset before publication", () => {
    const directory = makeFixture();
    try {
      fs.unlinkSync(path.join(directory, "Jarvis-Setup.exe"));
      fs.writeFileSync(path.join(directory, "unexpected.txt"), "unexpected");
      assert.throws(
        () => verifyJarvisReleaseDirectory(directory, { version, sourceCommit }),
        /release staging asset set mismatch/,
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects non-canonical checksum sidecars", () => {
    const directory = makeFixture();
    const artifact = `Jarvis-${version}-x86_64.AppImage`;
    const sidecar = path.join(directory, `${artifact}.sha256`);
    const canonical = fs.readFileSync(sidecar, "utf8");
    try {
      fs.writeFileSync(sidecar, `${canonical}unexpected-token`);
      assert.throws(
        () => verifyJarvisReleaseDirectory(directory, { version, sourceCommit }),
        /canonical SHA-256 line/,
      );
      fs.writeFileSync(sidecar, `${canonical}\nsecond-line`);
      assert.throws(
        () => verifyJarvisReleaseDirectory(directory, { version, sourceCommit }),
        /canonical SHA-256 line/,
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects provenance and Windows manifest schema tampering", () => {
    const directory = makeFixture();
    const linux = `Jarvis-${version}-x86_64.AppImage`;
    const linuxProvenancePath = path.join(directory, `${linux}.provenance.json`);
    try {
      const linuxProvenance = JSON.parse(fs.readFileSync(linuxProvenancePath, "utf8"));
      linuxProvenance.extra = true;
      fs.writeFileSync(linuxProvenancePath, JSON.stringify(linuxProvenance));
      assert.throws(
        () => verifyJarvisReleaseDirectory(directory, { version, sourceCommit }),
        /provenance keys mismatch/,
      );

      const validDirectory = makeFixture();
      try {
        const manifestPath = path.join(
          validDirectory,
          `Jarvis-Setup-${version}-win-x64.exe.manifest.json`,
        );
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        manifest.platform = "linux";
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));
        fs.writeFileSync(
          `${manifestPath}.sha256`,
          `${digest(manifestPath)}  ${path.basename(manifestPath)}\n`,
        );
        const provenancePath = path.join(
          validDirectory,
          `Jarvis-Setup-${version}-win-x64.exe.provenance.json`,
        );
        const provenance = JSON.parse(fs.readFileSync(provenancePath, "utf8"));
        provenance.manifestSha256 = digest(manifestPath);
        fs.writeFileSync(provenancePath, JSON.stringify(provenance));
        assert.throws(
          () => verifyJarvisReleaseDirectory(validDirectory, { version, sourceCommit }),
          /expected windows, received linux/,
        );
      } finally {
        fs.rmSync(validDirectory, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
