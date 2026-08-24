import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const sha256 = (file) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");

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

export const expectedJarvisCompanionReleaseAssets = (version) => [
  `Jarvis-Companion-${version}-x64.exe`,
  `Jarvis-Companion-${version}-x64.exe.blockmap`,
  "latest.yml",
  `Jarvis-Companion-${version}-x86_64.AppImage`,
  "latest-linux.yml",
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

const stripYamlScalar = (value) => {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
  return trimmed;
};

const parseCompanionUpdateManifest = (file) => {
  const lines = NodeFS.readFileSync(file, "utf8").split(/\r?\n/);
  let version;
  const files = [];
  let current;
  const finish = () => {
    if (current) {
      if (
        typeof current.url !== "string" ||
        typeof current.sha512 !== "string" ||
        typeof current.size !== "number"
      ) {
        throw new Error(`Incomplete Companion update entry in ${NodePath.basename(file)}`);
      }
      files.push(current);
      current = undefined;
    }
  };
  for (const line of lines) {
    const versionMatch = /^version:\s*(.+)$/.exec(line.trimEnd());
    if (versionMatch) {
      version = stripYamlScalar(versionMatch[1]);
      continue;
    }
    const urlMatch = /^  - url:\s*(.+)$/.exec(line.trimEnd());
    if (urlMatch) {
      finish();
      current = { url: stripYamlScalar(urlMatch[1]) };
      continue;
    }
    const shaMatch = /^    sha512:\s*(.+)$/.exec(line.trimEnd());
    if (shaMatch && current) {
      current.sha512 = stripYamlScalar(shaMatch[1]);
      continue;
    }
    const sizeMatch = /^    size:\s*(\d+)$/.exec(line.trimEnd());
    if (sizeMatch && current) {
      current.size = Number(sizeMatch[1]);
    }
  }
  finish();
  if (typeof version !== "string" || files.length === 0) {
    throw new Error(`Invalid Companion update manifest ${NodePath.basename(file)}`);
  }
  return { version, files };
};

const sha512Base64 = (file) =>
  NodeCrypto.createHash("sha512").update(NodeFS.readFileSync(file)).digest("base64");

const verifyCompanionUpdateManifest = (directory, manifestName, version, expectedNames) => {
  const manifestPath = NodePath.join(directory, manifestName);
  const manifest = parseCompanionUpdateManifest(manifestPath);
  assertEqual(manifest.version, version, `Companion manifest version for ${manifestName}`);
  const actualNames = manifest.files
    .map((entry) => NodePath.basename(entry.url.split("?")[0]))
    .sort();
  if (JSON.stringify(actualNames) !== JSON.stringify([...expectedNames].sort())) {
    throw new Error(
      `Companion manifest ${manifestName} file set mismatch: expected ${expectedNames.join(", ")}, received ${actualNames.join(", ")}`,
    );
  }
  for (const entry of manifest.files) {
    const name = NodePath.basename(entry.url.split("?")[0]);
    const artifact = NodePath.join(directory, name);
    assertEqual(entry.size, NodeFS.statSync(artifact).size, `Companion size for ${name}`);
    assertEqual(entry.sha512, sha512Base64(artifact), `Companion sha512 for ${name}`);
  }
};

export function verifyJarvisCompanionReleaseAssets(directory, { version }) {
  const expected = expectedJarvisCompanionReleaseAssets(version);
  for (const name of expected.filter((candidate) => !candidate.endsWith(".yml"))) {
    if (!NodeFS.statSync(NodePath.join(directory, name)).isFile()) {
      throw new Error(`Missing Companion release asset ${name}`);
    }
  }
  verifyCompanionUpdateManifest(directory, "latest.yml", version, expected.slice(0, 1));
  verifyCompanionUpdateManifest(directory, "latest-linux.yml", version, [expected[3]]);
}

export function verifyJarvisReleaseDirectory(
  directory,
  { version, sourceCommit, companionVersion },
) {
  const expected = [
    ...expectedJarvisReleaseAssets(version),
    ...(companionVersion ? expectedJarvisCompanionReleaseAssets(companionVersion) : []),
  ].sort();
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
  if (companionVersion) {
    verifyJarvisCompanionReleaseAssets(directory, { version: companionVersion });
  }
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
