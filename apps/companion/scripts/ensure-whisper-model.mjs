import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const modelUrl =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin?download=true";
const modelSha256 = "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002";
const modelPath = resolve(import.meta.dirname, "../resources/whisper/ggml-base.en.bin");

async function sha256(path) {
  const contents = await readFile(path);
  return createHash("sha256").update(contents).digest("hex");
}

if (existsSync(modelPath) && (await sha256(modelPath)) === modelSha256) {
  process.exit(0);
}

await mkdir(dirname(modelPath), { recursive: true });
const temporaryPath = `${modelPath}.download`;
await rm(temporaryPath, { force: true });

const response = await fetch(modelUrl);
if (!response.ok || response.body === null) {
  throw new Error(
    `Could not download the local Whisper model: ${response.status} ${response.statusText}`,
  );
}

await pipeline(Readable.fromWeb(response.body), createWriteStream(temporaryPath));
if ((await sha256(temporaryPath)) !== modelSha256) {
  await rm(temporaryPath, { force: true });
  throw new Error("The downloaded local Whisper model failed its SHA-256 check.");
}

await rename(temporaryPath, modelPath);
