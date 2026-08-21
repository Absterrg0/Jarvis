import * as NodeModule from "node:module";
import * as NodePath from "node:path";

const require = NodeModule.createRequire(import.meta.url);
const cpal = require("node-cpal");
const sherpa = require("sherpa-onnx-node");
const parakeet = NodePath.resolve(import.meta.dirname, "../resources/parakeet");
const kokoro = NodePath.resolve(import.meta.dirname, "../resources/kokoro");

const hosts = cpal.getHosts();
if (!Array.isArray(hosts)) throw new Error("node-cpal did not load its Windows audio backend.");

const recognizer = await sherpa.OfflineRecognizer.createAsync({
  featConfig: { sampleRate: 16_000, featureDim: 80 },
  modelConfig: {
    transducer: {
      encoder: NodePath.resolve(parakeet, "encoder.int8.onnx"),
      decoder: NodePath.resolve(parakeet, "decoder.int8.onnx"),
      joiner: NodePath.resolve(parakeet, "joiner.int8.onnx"),
    },
    tokens: NodePath.resolve(parakeet, "tokens.txt"),
    numThreads: 2,
    provider: "cpu",
    debug: false,
  },
});
const stream = recognizer.createStream();
stream.acceptWaveform({ samples: new Float32Array(16_000), sampleRate: 16_000 });
await recognizer.decodeAsync(stream);

const tts = await sherpa.OfflineTts.createAsync({
  model: {
    kokoro: {
      model: NodePath.resolve(kokoro, "model.int8.onnx"),
      voices: NodePath.resolve(kokoro, "voices.bin"),
      tokens: NodePath.resolve(kokoro, "tokens.txt"),
      dataDir: NodePath.resolve(kokoro, "espeak-ng-data"),
      lexicon: NodePath.resolve(kokoro, "lexicon-us-en.txt"),
    },
    debug: false,
    numThreads: 2,
    provider: "cpu",
  },
  maxNumSentences: 1,
});
const audio = await tts.generateAsync({
  text: "Jarvis voice is ready.",
  sid: 0,
  speed: 1,
  enableExternalBuffer: false,
  generationConfig: new sherpa.GenerationConfig({ sid: 0, speed: 1, silenceScale: 0.24 }),
});
if (!(audio.samples instanceof Float32Array) || audio.samples.length === 0) {
  throw new Error("Kokoro loaded but did not synthesize audio.");
}

console.log(
  `Speech runtime smoke passed (${hosts.length} audio host(s), ${audio.samples.length} Kokoro samples).`,
);
