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
const archive = {
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-multi-lang-v1_1.tar.bz2",
  sha256: "a1e94694776049035c4f2c6529f003aaece993c76aae9a78995831c3c4dcafc6",
};
const resourceRoot = NodePath.resolve(import.meta.dirname, "../resources/kokoro");
const markerPath = NodePath.join(resourceRoot, ".resources-sha256");
const marker = `${archive.sha256}\n`;
const required = [
  "model.int8.onnx",
  "voices.bin",
  "tokens.txt",
  "lexicon-us-en.txt",
  "espeak-ng-data/phondata",
  "LICENSE",
];

async function sha256(path) {
  const contents = await NodeFSP.readFile(path);
  return NodeCrypto.createHash("sha256").update(contents).digest("hex");
}

async function downloadVerified(destination) {
  const temporaryPath = `${destination}.download`;
  await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
  await NodeFSP.rm(temporaryPath, { force: true });
  const response = await fetch(archive.url);
  if (!response.ok || response.body === null) {
    throw new Error(
      `Could not download the Kokoro int8 voice model: ${response.status} ${response.statusText}`,
    );
  }
  await NodeStreamPromises.pipeline(
    NodeStream.Readable.fromWeb(response.body),
    NodeFS.createWriteStream(temporaryPath),
  );
  if ((await sha256(temporaryPath)) !== archive.sha256) {
    await NodeFSP.rm(temporaryPath, { force: true });
    throw new Error("The Kokoro int8 voice model failed its SHA-256 check.");
  }
  await NodeFSP.rename(temporaryPath, destination);
}

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
if (!NodeFS.existsSync(archivePath) || (await sha256(archivePath)) !== archive.sha256) {
  await downloadVerified(archivePath);
}
await executeFile("tar", ["-xjf", archivePath, "--strip-components=1", "-C", nextRoot]);
for (const name of required) {
  if (!NodeFS.existsSync(NodePath.join(nextRoot, name))) {
    throw new Error(`The Kokoro resource archive is missing ${name}.`);
  }
}
await NodeFSP.writeFile(NodePath.join(nextRoot, ".resources-sha256"), marker, "utf8");
await NodeFSP.rm(resourceRoot, { recursive: true, force: true });
await NodeFSP.rename(nextRoot, resourceRoot);
await NodeFSP.rm(archivePath, { force: true });
