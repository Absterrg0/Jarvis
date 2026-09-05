import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const digestCache = new Map();

const cacheKey = (file) => {
  const stat = NodeFS.statSync(file);
  return `${NodePath.resolve(file)}:${stat.size}:${stat.mtimeMs}`;
};

// Stream each artifact in fixed chunks and reuse its digest within a
// verification run: buffering whole installers with readFileSync repeats
// peak-RSS memory and I/O for every checksum, alias, and provenance read.
export const sha256 = (file) => {
  const key = cacheKey(file);
  const cached = digestCache.get(key);
  if (cached !== undefined) return cached;
  const hash = NodeCrypto.createHash("sha256");
  const fd = NodeFS.openSync(file, "r");
  try {
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let read = 0;
    do {
      read = NodeFS.readSync(fd, chunk, 0, chunk.length, null);
      if (read > 0) hash.update(chunk.subarray(0, read));
    } while (read > 0);
  } finally {
    NodeFS.closeSync(fd);
  }
  const digest = hash.digest("hex");
  digestCache.set(key, digest);
  return digest;
};

export const expectedJarvisReleaseAssets = (version) => [
  ...["arm64", "x64"].flatMap((arch) => {
    const artifact = `Jarvis-${version}-${arch}.dmg`;
    return [artifact, `${artifact}.sha256`, `${artifact}.provenance.json`];
  }),
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

const readJson = (file) => JSON.parse(NodeFS.readFileSync(file, "utf8"));

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
  const contents = NodeFS.readFileSync(sidecar, "utf8");
  const match = /^([0-9a-f]{64})  ([^\r\n]+)\n?$/.exec(contents);
  if (!match) {
    throw new Error(
      `checksum sidecar for ${NodePath.basename(file)} is not one canonical SHA-256 line`,
    );
  }
  assertEqual(
    match[2],
    NodePath.basename(file),
    `checksum filename for ${NodePath.basename(file)}`,
  );
  assertEqual(match[1], sha256(file), `checksum for ${NodePath.basename(file)}`);
};

const verifyProvenance = (file, provenance, fields) => {
  for (const [name, expected] of Object.entries(fields)) {
    assertEqual(provenance[name], expected, `provenance ${name} for ${NodePath.basename(file)}`);
  }
};

export function verifyJarvisReleaseDirectory(directory, { version, sourceCommit }) {
  const expected = expectedJarvisReleaseAssets(version).sort();
  const actual = NodeFS.readdirSync(directory, { withFileTypes: true })
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

  const file = (name) => NodePath.join(directory, name);
  const linuxArtifact = `Jarvis-${version}-x86_64.AppImage`;
  const macArtifacts = ["arm64", "x64"].map((arch) => `Jarvis-${version}-${arch}.dmg`);
  const setupArtifact = `Jarvis-Setup-${version}-win-x64.exe`;
  const setupManifest = `${setupArtifact}.manifest.json`;
  const setupProvenance = `${setupArtifact}.provenance.json`;
  const headlessArtifacts = [
    `Jarvis-Headless-Node-${version}-linux-x64.tar.gz`,
    `Jarvis-Headless-Node-${version}-linux-arm64.tar.gz`,
  ];

  verifySidecar(file(linuxArtifact), file(`${linuxArtifact}.sha256`));
  for (const artifact of macArtifacts) verifySidecar(file(artifact), file(`${artifact}.sha256`));
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

  for (const artifact of macArtifacts) {
    const provenance = readJson(file(`${artifact}.provenance.json`));
    const arch = artifact.match(/-(arm64|x64)\.dmg$/)?.[1];
    assertExactKeys(
      provenance,
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
      `${artifact} provenance`,
    );
    verifyProvenance(file(artifact), provenance, {
      format: 1,
      product: "Jarvis",
      version,
      platform: "mac",
      arch,
      artifactName: artifact,
      artifactSha256: sha256(file(artifact)),
      sourceCommit,
    });
  }

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
    format: 3,
    product: "Jarvis",
    version,
    platform: "windows",
    arch: "x64",
    artifactName: setupArtifact,
    sourceCommit,
  });
  if (!Array.isArray(setupManifestJson.payloads) || setupManifestJson.payloads.length !== 2) {
    throw new Error("Windows setup manifest must contain exactly two payloads");
  }
  const payloadIds = setupManifestJson.payloads
    .map((payload) => {
      assertExactKeys(payload, ["id", "modes", "files"], "Windows setup payload");
      return payload.id;
    })
    .sort();
  assertEqual(payloadIds.join(","), "desktop,runtime-win", "Windows setup payload IDs");

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
  const names = NodeFS.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== "SHA256SUMS")
    .map((entry) => entry.name)
    .sort();
  const output =
    names.map((name) => `${sha256(NodePath.join(directory, name))}  ${name}`).join("\n") + "\n";
  NodeFS.writeFileSync(NodePath.join(directory, "SHA256SUMS"), output);
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
