// oxlint-disable t3code/no-global-process-runtime -- standalone resource preparation script.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeUtil from "node:util";

const executeFile = NodeUtil.promisify(NodeChildProcess.execFile);
const parakeetArchive = {
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8.tar.bz2",
  sha256: "f628312e9fdf8686374cb01a69425c41732529d540860311f16f37cbc32cfe9b",
};
const resourceBase = process.argv[2] ?? NodePath.resolve(import.meta.dirname, "../resources");
const resourceRoot = NodePath.resolve(resourceBase, "parakeet");
const markerPath = NodePath.join(resourceRoot, ".resources-sha256");
const marker = `${parakeetArchive.sha256}\n`;

async function sha256(path) {
  const contents = await NodeFSP.readFile(path);
  return NodeCrypto.createHash("sha256").update(contents).digest("hex");
}

async function downloadVerified({ url, sha256: expectedHash, destination, label }) {
  const temporaryPath = `${destination}.download`;
  await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
  await NodeFSP.rm(temporaryPath, { force: true });
  const response = await fetch(url);
  if (!response.ok || response.body === null) {
    throw new Error(`Could not download ${label}: ${response.status} ${response.statusText}`);
  }
  await NodeStreamPromises.pipeline(
    NodeStream.Readable.fromWeb(response.body),
    NodeFS.createWriteStream(temporaryPath),
  );
  if ((await sha256(temporaryPath)) !== expectedHash) {
    await NodeFSP.rm(temporaryPath, { force: true });
    throw new Error(`${label} failed its SHA-256 check.`);
  }
  await NodeFSP.rename(temporaryPath, destination);
}

const required = ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"];
if (
  NodeFS.existsSync(markerPath) &&
  (await NodeFSP.readFile(markerPath, "utf8").catch(() => "")) === marker &&
  required.every((name) => NodeFS.existsSync(NodePath.join(resourceRoot, name)))
) {
  process.exit(0);
}

const nextRoot = `${resourceRoot}.next`;
const archivePath = `${resourceRoot}.tar.bz2`;
await NodeFSP.rm(nextRoot, { recursive: true, force: true });
await NodeFSP.mkdir(nextRoot, { recursive: true });
if (!NodeFS.existsSync(archivePath) || (await sha256(archivePath)) !== parakeetArchive.sha256) {
  await downloadVerified({
    ...parakeetArchive,
    destination: archivePath,
    label: "the Parakeet TDT/CTC 110M int8 model",
  });
}
await executeFile("tar", ["-xjf", archivePath, "--strip-components=2", "-C", nextRoot]);
for (const name of required) {
  if (!NodeFS.existsSync(NodePath.join(nextRoot, name))) {
    throw new Error(`The Parakeet resource archive is missing ${name}.`);
  }
}
await NodeFSP.writeFile(NodePath.join(nextRoot, ".resources-sha256"), marker, "utf8");
await NodeFSP.rm(resourceRoot, { recursive: true, force: true });
await NodeFSP.rename(nextRoot, resourceRoot);
await NodeFSP.rm(archivePath, { force: true });
