// oxlint-disable t3code/no-global-process-runtime -- standalone hardware benchmark.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeReadline from "node:readline";

const argumentsByName = new Map(
  process.argv
    .slice(2)
    .filter((argument) => argument !== "--")
    .map((argument) => {
      const separator = argument.indexOf("=");
      if (separator === -1) throw new Error(`Expected --name=value, received ${argument}`);
      return [argument.slice(0, separator), argument.slice(separator + 1)];
    }),
);
for (const name of argumentsByName.keys()) {
  if (
    ![
      "--cycles",
      "--resource-root",
      "--project-root",
      "--audio-fixture",
      "--max-peak-rss-mib",
    ].includes(name)
  ) {
    throw new Error(`Unknown option ${name}`);
  }
}
const cycles = Number(argumentsByName.get("--cycles") ?? "2");
if (!Number.isInteger(cycles) || cycles < 2 || cycles > 5) {
  throw new Error("Cycles must be between 2 and 5 so at least one full model swap is measured.");
}
const maxPeakRssMiB = Number(argumentsByName.get("--max-peak-rss-mib") ?? "1024");
if (!Number.isFinite(maxPeakRssMiB) || maxPeakRssMiB < 512 || maxPeakRssMiB > 4096) {
  throw new Error("Peak RSS limit must be between 512 and 4096 MiB.");
}

const resourceRoot = NodePath.resolve(
  argumentsByName.get("--resource-root") ?? NodePath.resolve(import.meta.dirname, "../resources"),
);
const projectRoot = NodePath.resolve(
  argumentsByName.get("--project-root") ??
    NodePath.resolve(import.meta.dirname, "../../../apps/desktop/pipecat"),
);
const audioFixture = NodePath.resolve(
  argumentsByName.get("--audio-fixture") ??
    NodePath.resolve(resourceRoot, "parakeet/test_wavs/en-english.wav"),
);

function readPcmS16LeWav(path) {
  const wav = NodeFS.readFileSync(path);
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`Expected a RIFF/WAVE fixture: ${path}`);
  }
  let format;
  let pcm;
  for (let offset = 12; offset + 8 <= wav.length; ) {
    const name = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > wav.length) throw new Error(`WAV chunk ${name} exceeds ${path}`);
    if (name === "fmt ") {
      format = {
        encoding: wav.readUInt16LE(dataStart),
        channels: wav.readUInt16LE(dataStart + 2),
        sampleRate: wav.readUInt32LE(dataStart + 4),
        bitsPerSample: wav.readUInt16LE(dataStart + 14),
      };
    } else if (name === "data") {
      pcm = wav.subarray(dataStart, dataEnd);
    }
    offset = dataEnd + (size % 2);
  }
  if (
    format?.encoding !== 1 ||
    format.channels !== 1 ||
    format.sampleRate !== 16_000 ||
    format.bitsPerSample !== 16 ||
    pcm === undefined ||
    pcm.length === 0
  ) {
    throw new Error(`Expected non-empty 16 kHz mono PCM-S16LE audio: ${path}`);
  }
  return pcm;
}

const pcm = readPcmS16LeWav(audioFixture);
const child = NodeChildProcess.spawn(
  "uv",
  ["run", "--project", projectRoot, "python", NodePath.resolve(projectRoot, "scripts/launch.py")],
  {
    env: {
      ...process.env,
      JARVIS_PIPECAT_MODEL_ROOT: NodePath.resolve(resourceRoot, "parakeet"),
      JARVIS_PIPECAT_KOKORO_ROOT: NodePath.resolve(resourceRoot, "kokoro"),
    },
    stdio: ["pipe", "pipe", "inherit"],
  },
);
const pending = [];
const received = [];
const awaitMessage = (matches) => {
  const existingIndex = received.findIndex(({ message }) => matches(message));
  if (existingIndex >= 0) return Promise.resolve(received.splice(existingIndex, 1)[0]);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for Pipecat.")), 120_000);
    pending.push({
      matches,
      resolve: (record) => {
        clearTimeout(timer);
        resolve(record);
      },
    });
  });
};
NodeReadline.createInterface({ input: child.stdout }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    child.kill();
    throw new Error(`Pipecat emitted malformed JSON: ${line}`);
  }
  const record = { message, receivedAt: NodePerfHooks.performance.now() };
  const index = pending.findIndex(({ matches }) => matches(message));
  if (index >= 0) pending.splice(index, 1)[0].resolve(record);
  else received.push(record);
});
const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
const text = "Jarvis measured the voice model transition and finished the report.";
const measuredPeakRssBytes = [];
const measuredCurrentRssBytes = [];

try {
  const processStartedAt = NodePerfHooks.performance.now();
  const ready = await awaitMessage((message) => message.type === "ready");
  console.log(
    JSON.stringify({
      event: "benchmark-config",
      cpu: NodeOS.cpus()[0]?.model,
      logicalCpus: NodeOS.cpus().length,
      os: `${NodeOS.platform()} ${NodeOS.release()}`,
      node: process.version,
      cycles,
      audioFixture,
      audioDurationMs: (pcm.length / (16_000 * 2)) * 1000,
      runtimeReadyMs: ready.receivedAt - processStartedAt,
      measurement: "Production Pipecat Parakeet/Kokoro model swaps and remote PCM synthesis.",
    }),
  );

  for (let cycle = 0; cycle < cycles; cycle += 1) {
    const captureId = `benchmark-capture-${cycle}`;
    const captureStartedAt = NodePerfHooks.performance.now();
    send({
      type: "capture-start",
      requestId: `${captureId}-start`,
      captureId,
      sampleRate: 16_000,
      channels: 1,
      contextualPhrases: [],
    });
    const captureReady = await awaitMessage(
      (message) => message.type === "capture-ready" && message.captureId === captureId,
    );
    send({
      type: "pcm",
      requestId: `${captureId}-pcm`,
      captureId,
      sequence: 0,
      sampleRate: 16_000,
      channels: 1,
      data: pcm.toString("base64"),
    });
    await awaitMessage(
      (message) => message.type === "result" && message.requestId === `${captureId}-pcm`,
    );
    send({ type: "capture-release", requestId: `${captureId}-release`, captureId });
    const stt = await awaitMessage(
      (message) => message.type === "stt-timing" && message.timing?.captureId === captureId,
    );
    const captureResult = await awaitMessage(
      (message) => message.type === "capture-result" && message.captureId === captureId,
    );
    if (!captureResult.message.ok) {
      throw new Error(`Parakeet failed: ${captureResult.message.message}`);
    }

    const synthesisId = `benchmark-synthesis-${cycle}`;
    const synthesisStartedAt = NodePerfHooks.performance.now();
    send({
      type: "synthesis-start",
      requestId: `${synthesisId}-start`,
      synthesisId,
      text,
    });
    const prepared = await awaitMessage(
      (message) => message.type === "result" && message.requestId === `${synthesisId}-start`,
    );
    if (!prepared.message.ok)
      throw new Error(`Kokoro preparation failed: ${prepared.message.message}`);
    const firstAudio = await awaitMessage(
      (message) => message.type === "synthesis-audio" && message.synthesisId === synthesisId,
    );
    const synthesis = await awaitMessage(
      (message) => message.type === "synthesis-result" && message.synthesisId === synthesisId,
    );
    if (!synthesis.message.ok) throw new Error(`Kokoro failed: ${synthesis.message.message}`);
    measuredPeakRssBytes.push(
      stt.message.timing.peakRssBytes,
      synthesis.message.timing?.peakRssBytes ?? 0,
    );
    measuredCurrentRssBytes.push(
      stt.message.timing.currentRssBytes ?? 0,
      synthesis.message.timing?.currentRssBytes ?? 0,
    );

    console.log(
      JSON.stringify({
        event: "benchmark-cycle",
        cycle,
        parakeetReadyMs: captureReady.receivedAt - captureStartedAt,
        ...stt.message.timing,
        parakeetToKokoroPrepareMs: prepared.receivedAt - synthesisStartedAt,
        kokoroFirstResponseAudioMs: firstAudio.receivedAt - synthesisStartedAt,
        kokoroAudioBytes: synthesis.message.audioBytes,
        kokoroTiming: synthesis.message.timing,
      }),
    );
  }

  send({ type: "shutdown", requestId: "benchmark-shutdown" });
  await awaitMessage(
    (message) => message.type === "result" && message.requestId === "benchmark-shutdown",
  );
  const peakRssBytes = Math.max(...measuredPeakRssBytes);
  const peakLimitBytes = maxPeakRssMiB * 1024 * 1024;
  console.log(
    JSON.stringify({
      event: "benchmark-summary",
      cycles,
      peakRssBytes,
      maximumObservedCurrentRssBytes: Math.max(...measuredCurrentRssBytes),
      peakLimitBytes,
      withinPeakLimit: peakRssBytes <= peakLimitBytes,
    }),
  );
  if (peakRssBytes > peakLimitBytes) {
    throw new Error(
      `Pipecat peak RSS ${peakRssBytes} exceeded the ${peakLimitBytes}-byte model-swap limit.`,
    );
  }
} finally {
  child.kill();
}
