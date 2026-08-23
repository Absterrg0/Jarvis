import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

export const expectedJarvisReleaseAssets = (version) => [
  `Jarvis-${version}-x86_64.AppImage`,
  `Jarvis-${version}-x86_64.AppImage.provenance.json`,
  `Jarvis-${version}-x86_64.AppImage.sha256`,
  `Jarvis-Headless-Node-${version}-linux-arm64.tar.gz`,
  `Jarvis-Headless-Node-${version}-linux-arm64.tar.gz.provenance.json`,
  `Jarvis-Headless-Node-${version}-linux-arm64.tar.gz.sha256`,
  `Jarvis-Headless-Node-${version}-linux-x64.tar.gz`,
  `Jarvis-Headless-Node-${version}-linux-x64.tar.gz.provenance.json`,
  `Jarvis-Headless-Node-${version}-linux-x64.tar.gz.sha256`,
  `Jarvis-Setup-${version}-win-x64.exe`,
  `Jarvis-Setup-${version}-win-x64.exe.sha256`,
  `Jarvis-Setup-${version}-win-x64.exe.manifest.json`,
  `Jarvis-Setup-${version}-win-x64.exe.manifest.json.sha256`,
  `Jarvis-Setup-${version}-win-x64.exe.provenance.json`,
  "Jarvis-Setup.exe",
];

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const assertExactKeys = (value, keys, label) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label} keys mismatch: expected ${expected.join(", ")}, received ${actual.join(", ")}`,
    );
  }
};

const assertEqual = (actual, expected, message) => {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, received ${actual}`);
};

const verifySidecar = (file, sidecar) => {
  const contents = fs.readFileSync(sidecar, "utf8");
  const match = /^([0-9a-f]{64})  ([^\r\n]+)\n?$/.exec(contents);
  if (!match) {
    throw new Error(
      `checksum sidecar for ${path.basename(file)} is not one canonical SHA-256 line`,
    );
  }
  assertEqual(match[2], path.basename(file), `checksum filename for ${path.basename(file)}`);
  assertEqual(match[1], sha256(file), `checksum for ${path.basename(file)}`);
};

const verifyProvenance = (file, provenance, fields) => {
  for (const [name, expected] of Object.entries(fields)) {
    assertEqual(provenance[name], expected, `provenance ${name} for ${path.basename(file)}`);
  }
};

export function verifyJarvisReleaseDirectory(directory, { version, sourceCommit }) {
  const expected = expectedJarvisReleaseAssets(version).sort();
  const actual = fs
    .readdirSync(directory, { withFileTypes: true })
    .map((entry) => {
      if (!entry.isFile())
        throw new Error(`release staging contains non-file entry: ${entry.name}`);
      return entry.name;
    })
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `release staging asset set mismatch:\nexpected: ${expected.join(", ")}\nactual: ${actual.join(", ")}`,
    );
  }

  const file = (name) => path.join(directory, name);
  const linuxArtifact = `Jarvis-${version}-x86_64.AppImage`;
  const setupArtifact = `Jarvis-Setup-${version}-win-x64.exe`;
  const setupManifest = `${setupArtifact}.manifest.json`;
  const setupProvenance = `${setupArtifact}.provenance.json`;
  const headlessArtifacts = [
    `Jarvis-Headless-Node-${version}-linux-x64.tar.gz`,
    `Jarvis-Headless-Node-${version}-linux-arm64.tar.gz`,
  ];

  verifySidecar(file(linuxArtifact), file(`${linuxArtifact}.sha256`));
  verifySidecar(file(setupArtifact), file(`${setupArtifact}.sha256`));
  verifySidecar(file(setupManifest), file(`${setupManifest}.sha256`));
  for (const artifact of headlessArtifacts)
    verifySidecar(file(artifact), file(`${artifact}.sha256`));
  assertEqual(
    sha256(file("Jarvis-Setup.exe")),
    sha256(file(setupArtifact)),
    "restored setup alias",
  );

  const linuxProvenance = readJson(file(`${linuxArtifact}.provenance.json`));
  assertExactKeys(
    linuxProvenance,
    [
      "format",
      "product",
      "version",
      "platform",
      "arch",
      "artifactName",
      "artifactSha256",
      "sourceCommit",
    ],
    `${linuxArtifact} provenance`,
  );
  verifyProvenance(file(linuxArtifact), linuxProvenance, {
    format: 1,
    product: "Jarvis",
    version,
    platform: "linux",
    arch: "x64",
    artifactName: linuxArtifact,
    artifactSha256: sha256(file(linuxArtifact)),
    sourceCommit,
  });

  for (const arch of ["x64", "arm64"]) {
    const artifact = `Jarvis-Headless-Node-${version}-linux-${arch}.tar.gz`;
    const provenance = readJson(file(`${artifact}.provenance.json`));
    assertExactKeys(
      provenance,
      [
        "format",
        "artifact",
        "sha256",
        "sourceCommit",
        "version",
        "arch",
        "nodeVersion",
        "platform",
      ],
      `${artifact} provenance`,
    );
    verifyProvenance(file(artifact), provenance, {
      format: 1,
      version,
      arch,
      artifact,
      sha256: sha256(file(artifact)),
      sourceCommit,
      platform: "linux",
    });
    if (typeof provenance.nodeVersion !== "string" || provenance.nodeVersion.length === 0) {
      throw new Error(`${artifact} provenance nodeVersion must be non-empty`);
    }
  }

  const setupManifestJson = readJson(file(setupManifest));
  assertExactKeys(
    setupManifestJson,
    [
      "format",
      "product",
      "version",
      "platform",
      "arch",
      "artifactName",
      "sourceCommit",
      "payloads",
    ],
    "Windows setup manifest",
  );
  verifyProvenance(file(setupArtifact), setupManifestJson, {
    format: 2,
    product: "Jarvis",
    version,
    platform: "windows",
    arch: "x64",
    artifactName: setupArtifact,
    sourceCommit,
  });
  if (!Array.isArray(setupManifestJson.payloads) || setupManifestJson.payloads.length !== 3) {
    throw new Error("Windows setup manifest must contain exactly three payloads");
  }
  const payloadIds = setupManifestJson.payloads
    .map((payload) => {
      assertExactKeys(payload, ["id", "modes", "files"], "Windows setup payload");
      return payload.id;
    })
    .sort();
  assertEqual(payloadIds.join(","), "companion,desktop,runtime-win", "Windows setup payload IDs");

  const setupProvenanceJson = readJson(file(setupProvenance));
  assertExactKeys(
    setupProvenanceJson,
    [
      "format",
      "product",
      "artifactName",
      "artifactSha256",
      "aliasName",
      "manifestName",
      "manifestSha256",
      "provenanceName",
      "sourceCommit",
      "version",
      "arch",
    ],
    "Windows setup provenance",
  );
  verifyProvenance(file(setupArtifact), setupProvenanceJson, {
    format: 1,
    product: "Jarvis",
    version,
    arch: "x64",
    sourceCommit,
    artifactName: setupArtifact,
    aliasName: "Jarvis-Setup.exe",
    manifestName: setupManifest,
    provenanceName: setupProvenance,
    artifactSha256: sha256(file(setupArtifact)),
    manifestSha256: sha256(file(setupManifest)),
  });
}

export function writeJarvisSha256Sums(directory) {
  const names = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== "SHA256SUMS")
    .map((entry) => entry.name)
    .sort();
  const output =
    names.map((name) => `${sha256(path.join(directory, name))}  ${name}`).join("\n") + "\n";
  fs.writeFileSync(path.join(directory, "SHA256SUMS"), output);
  return names;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [directory, version, sourceCommit, option] = process.argv.slice(2);
  if (!directory || !version || !sourceCommit) {
    throw new Error(
      "usage: node scripts/verify-jarvis-release.mjs <directory> <version> <source-commit> [--write-sha256sums]",
    );
  }
  verifyJarvisReleaseDirectory(directory, { version, sourceCommit });
  if (option === "--write-sha256sums") writeJarvisSha256Sums(directory);
}
