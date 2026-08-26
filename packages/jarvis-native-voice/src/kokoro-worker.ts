// oxlint-disable t3code/no-global-process-runtime -- this is a dedicated native child process.
// @effect-diagnostics nodeBuiltinImport:off noFloatingEffect:off globalProcess:off - this file
// is a dedicated killable native-model process, not application orchestration state.
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

type GeneratedAudio = { readonly samples: Float32Array; readonly sampleRate: number };
type ProgressAudio = { readonly samples: Float32Array; readonly progress: number };
type SherpaKokoro = {
  readonly OfflineTts: {
    readonly createAsync: (config: unknown) => Promise<{
      readonly sampleRate: number;
      readonly generateAsync: (input: {
        readonly text: string;
        readonly sid: number;
        readonly speed: number;
        readonly enableExternalBuffer: boolean;
        readonly generationConfig: unknown;
        readonly onProgress: (info: ProgressAudio) => void;
      }) => Promise<GeneratedAudio>;
    }>;
  };
  readonly GenerationConfig: new (input: unknown) => unknown;
  readonly writeWave: (path: string, audio: GeneratedAudio) => void;
};

type WorkerRequest = {
  readonly type: "synthesize";
  readonly requestId: string;
  readonly text: string;
  readonly outputDirectory: string;
};

function send(message: unknown) {
  process.send?.(message);
}

function workerRequest(value: unknown): WorkerRequest | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<WorkerRequest>;
  return candidate.type === "synthesize" &&
    typeof candidate.requestId === "string" &&
    typeof candidate.text === "string" &&
    typeof candidate.outputDirectory === "string"
    ? (candidate as WorkerRequest)
    : undefined;
}

async function run() {
  const resourceRoot = process.env.JARVIS_KOKORO_ROOT;
  if (resourceRoot === undefined || resourceRoot.length === 0) {
    throw new Error("Kokoro resource root was not provided.");
  }
  const require = NodeModule.createRequire(import.meta.url);
  const sherpa = require("sherpa-onnx-node") as SherpaKokoro;
  const configuredThreads = Number.parseInt(process.env.JARVIS_KOKORO_NUM_THREADS ?? "2", 10);
  const numThreads =
    Number.isInteger(configuredThreads) && configuredThreads >= 1 && configuredThreads <= 4
      ? configuredThreads
      : 2;
  const tts = await sherpa.OfflineTts.createAsync({
    model: {
      kokoro: {
        model: NodePath.join(resourceRoot, "model.int8.onnx"),
        voices: NodePath.join(resourceRoot, "voices.bin"),
        tokens: NodePath.join(resourceRoot, "tokens.txt"),
        dataDir: NodePath.join(resourceRoot, "espeak-ng-data"),
        lexicon: NodePath.join(resourceRoot, "lexicon-us-en.txt"),
      },
      debug: false,
      numThreads,
      provider: "cpu",
    },
    maxNumSentences: 1,
  });
  send({ type: "ready" });
  let busy = false;
  process.on("message", (value) => {
    const request = workerRequest(value);
    if (request === undefined) return;
    if (busy) {
      send({
        type: "failed",
        requestId: request.requestId,
        message: "Kokoro received overlapping synthesis work.",
      });
      return;
    }
    busy = true;
    const startedAt = performance.now();
    let firstChunkAt: number | undefined;
    let chunkIndex = 0;
    let totalSamples = 0;
    let sampleRate = tts.sampleRate;
    const startedCpu = process.cpuUsage();
    void tts
      .generateAsync({
        text: request.text,
        sid: 0,
        speed: 1.02,
        // Electron's V8 memory cage rejects external ArrayBuffers. Keep the
        // generated samples in V8-owned memory before writing the WAV.
        enableExternalBuffer: false,
        generationConfig: new sherpa.GenerationConfig({
          sid: 0,
          speed: 1.02,
          silenceScale: 0.24,
        }),
        onProgress: ({ samples }) => {
          if (samples.length === 0) return;
          if (firstChunkAt === undefined) firstChunkAt = performance.now();
          const index = chunkIndex;
          chunkIndex += 1;
          totalSamples += samples.length;
          const chunkAudio = { samples, sampleRate };
          const chunkPath = NodePath.join(
            request.outputDirectory,
            `chunk-${String(index).padStart(6, "0")}.wav`,
          );
          sherpa.writeWave(chunkPath, chunkAudio);
          send({ type: "chunk", requestId: request.requestId, index });
        },
      })
      .then((audio) => {
        sampleRate = audio.sampleRate;
        // Older compatible native builds may complete without progress
        // callbacks. Preserve speech rather than reporting a silent success.
        if (chunkIndex === 0 && audio.samples.length > 0) {
          firstChunkAt = performance.now();
          totalSamples = audio.samples.length;
          sherpa.writeWave(NodePath.join(request.outputDirectory, "chunk-000000.wav"), audio);
          send({ type: "chunk", requestId: request.requestId, index: 0 });
          chunkIndex = 1;
        }
        // Sherpa's progress buffers are the complete result. They are written
        // as numbered chunks above; never write a second full-length WAV.
        send({
          type: "synthesis-finished",
          requestId: request.requestId,
          chunkCount: chunkIndex,
          totalSamples,
          sampleRate: audio.sampleRate,
          synthesisDurationMs: performance.now() - startedAt,
          synthesisCpuMs: (() => {
            const cpu = process.cpuUsage(startedCpu);
            return (cpu.user + cpu.system) / 1_000;
          })(),
          peakRssBytes: process.resourceUsage().maxRSS * 1_024,
          firstChunkReadyMs: firstChunkAt === undefined ? undefined : firstChunkAt - startedAt,
        });
      })
      .catch((cause: unknown) => {
        send({
          type: "failed",
          requestId: request.requestId,
          message: cause instanceof Error ? cause.message : "Kokoro synthesis failed.",
        });
      })
      .finally(() => {
        busy = false;
      });
  });
}

void run().catch((cause: unknown) => {
  const failure = {
    type: "startup-failed",
    message: cause instanceof Error ? cause.message : "Kokoro could not start.",
  };
  if (process.send === undefined) {
    process.exit(1);
  }
  process.send(failure, () => process.exit(1));
});
