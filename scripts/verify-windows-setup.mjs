import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const SHA256 = /^[0-9a-f]{64}$/u;
const PAYLOAD_IDS = ["desktop", "runtime-win"];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

async function readJson(filePath) {
  return JSON.parse(await NodeFSP.readFile(filePath, "utf8"));
}

function verifyManifest(manifest, manifestPath) {
  assert(manifest.format === 3, "Setup manifest format is not 3.");
  assert(manifest.product === "Jarvis", "Setup manifest product is not Jarvis.");
  assert(manifest.platform === "windows", "Setup manifest platform is not windows.");
  assert(manifest.arch === "x64", "Setup manifest architecture is not x64.");
  assert(
    typeof manifest.version === "string" && manifest.version.length > 0,
    "Setup manifest version is missing.",
  );
  assert(
    manifest.artifactName ===
      `${NodePath.basename(manifestPath).replace(/\.manifest\.json$/u, "")}`,
    "Setup manifest artifact name is incorrect.",
  );
  assert(Array.isArray(manifest.payloads), "Setup manifest payloads are missing.");
  assert(
    manifest.payloads.length === PAYLOAD_IDS.length,
    "Setup manifest does not contain exactly two payloads.",
  );
  for (const [index, payload] of manifest.payloads.entries()) {
    assert(payload.id === PAYLOAD_IDS[index], `Unexpected payload id: ${payload.id}`);
    const expectedModes = payload.id === "runtime-win" ? ["headless"] : ["full", "controller"];
    assert(
      JSON.stringify(payload.modes) === JSON.stringify(expectedModes),
      `Unexpected modes for payload ${payload.id}.`,
    );
    assert(Array.isArray(payload.files), `Payload files are missing for ${payload.id}.`);
    const seen = new Set();
    for (const file of payload.files) {
      assert(
        typeof file.path === "string" && file.path.length > 0,
        `Invalid manifest path in ${payload.id}.`,
      );
      assert(
        !NodePath.isAbsolute(file.path) && !file.path.split(/[\\/]/u).includes(".."),
        `Unsafe manifest path: ${file.path}`,
      );
      assert(
        Number.isInteger(file.bytes) && file.bytes >= 0 && SHA256.test(file.sha256),
        `Invalid manifest hash entry: ${payload.id}/${file.path}`,
      );
      assert(!seen.has(file.path), `Duplicate manifest path: ${payload.id}/${file.path}`);
      seen.add(file.path);
    }
  }
}

function verifyChecksumFile(checksumText, artifactName, expectedHash) {
  const match = checksumText.trim().match(/^([0-9a-f]{64})\s+(.+)$/u);
  assert(
    match && match[1] === expectedHash && match[2] === artifactName,
    "Setup SHA256 sidecar does not match the outer installer.",
  );
}

export async function verifyArtifactBundle({
  artifactPath,
  aliasPath,
  manifestPath,
  checksumPath,
  provenancePath,
}) {
  const artifactName = NodePath.basename(artifactPath);
  const manifestName = NodePath.basename(manifestPath);
  const provenanceName = NodePath.basename(provenancePath);
  const artifactBytes = await NodeFSP.readFile(artifactPath);
  const artifactSha256 = sha256(artifactBytes);
  const manifestBytes = await NodeFSP.readFile(manifestPath);
  const manifestSha256 = sha256(manifestBytes);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const provenance = await readJson(provenancePath);
  verifyManifest(manifest, manifestPath);
  verifyChecksumFile(await NodeFSP.readFile(checksumPath, "utf8"), artifactName, artifactSha256);
  assert(
    sha256(await NodeFSP.readFile(aliasPath)) === artifactSha256,
    "Versioned setup and Jarvis-Setup.exe differ.",
  );
  assert(
    provenance.format === 1 && provenance.product === "Jarvis",
    "Setup provenance schema is invalid.",
  );
  assert(
    provenance.artifactName === artifactName &&
      provenance.manifestName === manifestName &&
      provenance.provenanceName === provenanceName,
    "Setup provenance names do not match the downloaded files.",
  );
  assert(
    provenance.artifactSha256 === artifactSha256 && provenance.manifestSha256 === manifestSha256,
    "Setup provenance hashes do not match the downloaded files.",
  );
  assert(
    provenance.version === manifest.version &&
      provenance.arch === manifest.arch &&
      provenance.sourceCommit === manifest.sourceCommit,
    "Setup provenance identity does not match the manifest.",
  );
  return { manifest, provenance, payloadIds: manifest.payloads.map(({ id }) => id) };
}

async function collectFiles(root) {
  const files = [];
  async function visit(directory) {
    const entries = await NodeFSP.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile())
        files.push(
          NodePath.posix.normalize(NodePath.relative(root, absolute).replaceAll("\\", "/")),
        );
      else throw new Error(`Installed payload contains unsupported entry: ${absolute}`);
    }
  }
  await visit(root);
  return files.sort();
}

export async function verifyInstalledPayload(payload, root) {
  const expected = new Map(payload.files.map((file) => [file.path, file]));
  const actual = await collectFiles(root);
  const actualSet = new Set(actual);
  const extras = actual.filter((file) => !expected.has(file));
  const missing = [...expected.keys()].filter((file) => !actualSet.has(file));
  assert(
    !extras.length && !missing.length,
    `Installed ${payload.id} differs from manifest. Missing: ${missing[0] ?? "none"}; extra: ${extras[0] ?? "none"}`,
  );
  for (const file of payload.files) {
    const bytes = await NodeFSP.readFile(NodePath.join(root, file.path));
    assert(
      bytes.byteLength === file.bytes && sha256(bytes) === file.sha256,
      `Installed payload hash mismatch: ${payload.id}/${file.path}`,
    );
  }
}

function usage() {
  throw new Error(
    "Usage: verify-windows-setup.mjs bundle <artifact> <alias> <manifest> <checksum> <provenance> | installed <manifest> <install-root> <payload-id,...>",
  );
}

async function main(args) {
  if (args[0] === "bundle" && args.length === 6) {
    const result = await verifyArtifactBundle({
      artifactPath: args[1],
      aliasPath: args[2],
      manifestPath: args[3],
      checksumPath: args[4],
      provenancePath: args[5],
    });
    console.log(`Verified release bundle: ${result.payloadIds.join(", ")}`);
    return;
  }
  if (args[0] === "installed" && args.length === 4) {
    const manifest = await readJson(args[1]);
    verifyManifest(manifest, args[1]);
    const ids = args[3].split(",").filter(Boolean);
    for (const id of ids) {
      const payload = manifest.payloads.find((candidate) => candidate.id === id);
      assert(payload, `Unknown installed payload: ${id}`);
      await verifyInstalledPayload(payload, NodePath.join(args[2], id));
    }
    console.log(`Verified installed payload bytes: ${ids.join(", ")}`);
    return;
  }
  usage();
}

if (
  NodePath.resolve(process.argv[1] ?? "") ===
  NodePath.resolve(NodeURL.fileURLToPath(import.meta.url))
) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
