import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { inflateRawSync } from "node:zlib";

const piperArchive = {
  url: "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip",
  sha256: "f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea",
};
const hfcFemaleVoice = {
  name: "en_US-hfc_female-medium.onnx",
  url: "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/hfc_female/medium/en_US-hfc_female-medium.onnx?download=true",
  sha256: "914c473788fc1fa8b63ace1cdcdb44588f4ae523d3ab37df1536616835a140b7",
};
const hfcFemaleConfig = {
  name: `${hfcFemaleVoice.name}.json`,
  url: "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/hfc_female/medium/en_US-hfc_female-medium.onnx.json?download=true",
  sha256: "03f1fa0622b80463283592d97aca9f6e89aec345a5c56b7257723e0093c58b6c",
};
const piperRoot = resolve(import.meta.dirname, "../resources/piper");
const runtimePath = join(piperRoot, "runtime");
const voicePath = join(piperRoot, "voice");

async function sha256(path) {
  const contents = await readFile(path);
  return createHash("sha256").update(contents).digest("hex");
}

async function hasExpectedHash(path, expectedHash) {
  return existsSync(path) && (await sha256(path)) === expectedHash;
}

async function downloadVerifiedFile({ url, sha256: expectedHash, destination, label }) {
  const temporaryPath = `${destination}.download`;
  await mkdir(dirname(destination), { recursive: true });
  await rm(temporaryPath, { force: true });

  const response = await fetch(url);
  if (!response.ok || response.body === null) {
    throw new Error(`Could not download ${label}: ${response.status} ${response.statusText}`);
  }

  await pipeline(Readable.fromWeb(response.body), createWriteStream(temporaryPath));
  if ((await sha256(temporaryPath)) !== expectedHash) {
    await rm(temporaryPath, { force: true });
    throw new Error(`${label} failed its SHA-256 check.`);
  }

  await rm(destination, { force: true });
  await rename(temporaryPath, destination);
}

function readUInt16(buffer, offset, label) {
  if (offset < 0 || offset + 2 > buffer.length) throw new Error(`Invalid Piper archive: ${label}.`);
  return buffer.readUInt16LE(offset);
}

function readUInt32(buffer, offset, label) {
  if (offset < 0 || offset + 4 > buffer.length) throw new Error(`Invalid Piper archive: ${label}.`);
  return buffer.readUInt32LE(offset);
}

function zipEntries(archive) {
  const minimumEndOffset = Math.max(0, archive.length - 65_557);
  let endOffset = -1;
  for (let offset = archive.length - 22; offset >= minimumEndOffset; offset -= 1) {
    if (readUInt32(archive, offset, "end of central directory") === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset === -1)
    throw new Error("Invalid Piper archive: end of central directory not found.");

  const entryCount = readUInt16(archive, endOffset + 10, "central directory entry count");
  let offset = readUInt32(archive, endOffset + 16, "central directory offset");
  const entries = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (readUInt32(archive, offset, "central directory signature") !== 0x02014b50) {
      throw new Error("Invalid Piper archive: malformed central directory.");
    }
    const compression = readUInt16(archive, offset + 10, "compression method");
    const compressedSize = readUInt32(archive, offset + 20, "compressed size");
    const uncompressedSize = readUInt32(archive, offset + 24, "uncompressed size");
    const nameLength = readUInt16(archive, offset + 28, "file name length");
    const extraLength = readUInt16(archive, offset + 30, "extra field length");
    const commentLength = readUInt16(archive, offset + 32, "comment length");
    const localOffset = readUInt32(archive, offset + 42, "local file offset");
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > archive.length) throw new Error("Invalid Piper archive: truncated file name.");
    entries.push({
      compression,
      compressedSize,
      localOffset,
      name: archive.subarray(nameStart, nameEnd).toString("utf8"),
      uncompressedSize,
    });
    offset = nameEnd + extraLength + commentLength;
  }
  return entries;
}

function safeRuntimePath(name) {
  if (!name.startsWith("piper/")) return undefined;
  const relativePath = name.slice("piper/".length);
  if (relativePath.length === 0 || relativePath.endsWith("/")) return undefined;
  if (
    relativePath.includes("\\") ||
    relativePath
      .split("/")
      .some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error("Invalid Piper archive: unsafe file path.");
  }
  return relativePath;
}

async function extractPiperRuntime(archive, destination) {
  for (const entry of zipEntries(archive)) {
    const relativePath = safeRuntimePath(entry.name);
    if (relativePath === undefined) continue;
    if (readUInt32(archive, entry.localOffset, "local file signature") !== 0x04034b50) {
      throw new Error("Invalid Piper archive: malformed local file header.");
    }
    const nameLength = readUInt16(archive, entry.localOffset + 26, "local file name length");
    const extraLength = readUInt16(archive, entry.localOffset + 28, "local extra field length");
    const dataStart = entry.localOffset + 30 + nameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > archive.length) throw new Error("Invalid Piper archive: truncated file data.");
    const compressed = archive.subarray(dataStart, dataEnd);
    const contents =
      entry.compression === 0
        ? compressed
        : entry.compression === 8
          ? inflateRawSync(compressed)
          : (() => {
              throw new Error(
                `Invalid Piper archive: unsupported compression method ${entry.compression}.`,
              );
            })();
    if (contents.length !== entry.uncompressedSize) {
      throw new Error("Invalid Piper archive: uncompressed size mismatch.");
    }
    const target = join(destination, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
}

async function hasUsableRuntime() {
  const requiredFiles = [
    [
      join(runtimePath, "piper.exe"),
      "96f3da3811151580073e40bb4dd20eb0fb8115f5f5f76e2fb54282b3edfa5c1f",
    ],
    [join(runtimePath, "piper_phonemize.dll"), undefined],
    [join(runtimePath, "espeak-ng.dll"), undefined],
    [join(runtimePath, "onnxruntime.dll"), undefined],
    [join(runtimePath, "espeak-ng-data", "en_dict"), undefined],
    [join(runtimePath, "espeak-ng-data", "phondata"), undefined],
  ];
  for (const [path, expectedHash] of requiredFiles) {
    if (!existsSync(path)) return false;
    if (expectedHash !== undefined && !(await hasExpectedHash(path, expectedHash))) return false;
  }
  return true;
}

async function ensurePiperRuntime() {
  if (await hasUsableRuntime()) return;

  const archivePath = join(piperRoot, "piper_windows_amd64.zip");
  await downloadVerifiedFile({
    ...piperArchive,
    destination: archivePath,
    label: "the Piper Windows runtime",
  });
  const nextRuntimePath = `${runtimePath}.next`;
  await rm(nextRuntimePath, { recursive: true, force: true });
  await extractPiperRuntime(await readFile(archivePath), nextRuntimePath);
  if (
    !(await hasExpectedHash(
      join(nextRuntimePath, "piper.exe"),
      "96f3da3811151580073e40bb4dd20eb0fb8115f5f5f76e2fb54282b3edfa5c1f",
    ))
  ) {
    throw new Error("The Piper Windows runtime is missing its expected executable.");
  }
  await rm(runtimePath, { recursive: true, force: true });
  await rename(nextRuntimePath, runtimePath);
  await rm(archivePath, { force: true });
}

async function ensurePiperVoice() {
  for (const asset of [hfcFemaleVoice, hfcFemaleConfig]) {
    const destination = join(voicePath, asset.name);
    if (await hasExpectedHash(destination, asset.sha256)) continue;
    await downloadVerifiedFile({ ...asset, destination, label: `the Piper ${asset.name}` });
  }
}

await ensurePiperRuntime();
await ensurePiperVoice();
