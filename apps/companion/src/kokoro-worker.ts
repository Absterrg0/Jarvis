// oxlint-disable t3code/no-global-process-runtime -- this is a dedicated native child process.
// @effect-diagnostics nodeBuiltinImport:off noFloatingEffect:off globalProcess:off - this file
// is a dedicated killable native-model process, not application orchestration state.
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

type GeneratedAudio = { readonly samples: Float32Array; readonly sampleRate: number };
type SherpaKokoro = {
  readonly OfflineTts: {
    readonly createAsync: (config: unknown) => Promise<{
      readonly generateAsync: (input: unknown) => Promise<GeneratedAudio>;
    }>;
  };
  readonly GenerationConfig: new (input: unknown) => unknown;
  readonly writeWave: (path: string, audio: GeneratedAudio) => void;
};

type WorkerRequest = {
  readonly type: "synthesize";
  readonly requestId: string;
  readonly text: string;
  readonly outputPath: string;
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
    typeof candidate.outputPath === "string"
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
      numThreads: 2,
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
    void tts
      .generateAsync({
        text: request.text,
        sid: 0,
        speed: 1.02,
        enableExternalBuffer: true,
        generationConfig: new sherpa.GenerationConfig({
          sid: 0,
          speed: 1.02,
          silenceScale: 0.24,
        }),
      })
      .then((audio) => {
        sherpa.writeWave(request.outputPath, audio);
        send({ type: "synthesized", requestId: request.requestId });
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
