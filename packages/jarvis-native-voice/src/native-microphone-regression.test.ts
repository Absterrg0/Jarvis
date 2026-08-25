// @effect-diagnostics nodeBuiltinImport:off - this test deliberately loads the
// same native module that the packaged Full Desktop loads at the microphone boundary.
// oxlint-disable t3code/no-global-process-runtime -- the exact host target is the integration-test gate.
import { assert, describe, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import {
  parakeetModelPaths,
  parakeetSampleRate,
  prepareNativeMicrophone,
  startParakeetCapture,
  validateNativeMicrophone,
  type ParakeetCaptureDependencies,
} from "./native-speech.ts";

const require = NodeModule.createRequire(import.meta.url);
const nativeMicrophoneEntry = require.resolve("node-cpal");
const nativeMicrophoneBinary = NodePath.join(
  NodePath.dirname(nativeMicrophoneEntry),
  "bin",
  `${process.platform}-${process.arch}`,
  "index.node",
);
const hasExactHostBinary =
  NodeFS.existsSync(nativeMicrophoneBinary) && NodeFS.statSync(nativeMicrophoneBinary).isFile();

describe("packaged microphone adapter", () => {
  it("keeps the production loader on exact node-cpal", () => {
    const source = NodeFS.readFileSync(new URL("./native-speech.ts", import.meta.url), "utf8");
    assert.include(source, 'require("node-cpal")');
    assert.notInclude(source, "@t3tools/jarvis-native-microphone");
  });

  it("validates the capture contract without opening a physical device", () => {
    const microphone = {
      getDefaultInputDevice: () => ({ deviceId: "test-microphone" }),
      getDefaultInputConfig: () => ({
        sampleRate: parakeetSampleRate,
        channels: 1,
        sampleFormat: "f32" as const,
      }),
      createStream: () => "capture",
      closeStream: () => undefined,
    };

    assert.strictEqual(validateNativeMicrophone(microphone), microphone as unknown);
    assert.throws(
      () => validateNativeMicrophone({ ...microphone, createStream: undefined }),
      /createStream/,
    );
  });

  describe.runIf(hasExactHostBinary)("node-cpal microphone integration", () => {
    it("exercises the node-cpal microphone object at the capture call site", async () => {
      const nativeMicrophone = require("node-cpal") as Record<string, unknown>;

      prepareNativeMicrophone(process.platform);

      // The 0.1.1 runtime exports createStream, not the legacy
      // createInputStream/createOutputStream pair. Keep the production boundary
      // aligned with the native export shape.
      assert.isUndefined(nativeMicrophone.createInputStream);
      assert.isFunction(nativeMicrophone.createStream);

      let opened = false;
      let closed = false;
      const microphone = {
        ...nativeMicrophone,
        // Keep device discovery deterministic while retaining the real native
        // module object and its stream API at the production call site.
        getDefaultInputDevice: () => ({
          name: "test microphone",
          hostId: "test-host",
          deviceId: "test-microphone",
          isDefaultInput: true,
          isDefaultOutput: false,
        }),
        getDefaultInputConfig: () => ({
          sampleRate: parakeetSampleRate,
          channels: 1,
          sampleFormat: "f32" as const,
        }),
        // Keep the actual node-cpal export shape (which has createStream) but
        // avoid opening host audio hardware in this deterministic test.
        createStream: (
          deviceId: string,
          isInput: boolean,
          config: {
            readonly sampleRate: number;
            readonly channels: number;
            readonly sampleFormat: string;
          },
          onData?: (data: Float32Array) => void,
        ) => {
          assert.equal(deviceId, "test-microphone");
          assert.isTrue(isInput);
          assert.equal(config.sampleRate, parakeetSampleRate);
          opened = true;
          onData?.(Float32Array.from([0.25]));
          return `${deviceId}:capture`;
        },
        closeStream: () => {
          closed = true;
        },
      } as unknown as ParakeetCaptureDependencies["microphone"];

      const dependencies: ParakeetCaptureDependencies = {
        microphone,
        runtime: {
          OfflineRecognizer: {
            createAsync: async () => ({
              createStream: () => ({
                acceptWaveform: () => undefined,
              }),
              decodeAsync: async () => ({ text: "unused" }),
            }),
          },
          LinearResampler: class {
            resample(samples: Float32Array) {
              return samples;
            }
            flush() {
              return new Float32Array();
            }
          },
          writeWave: () => undefined,
        },
      };

      const capture = startParakeetCapture({
        paths: parakeetModelPaths("C:/Jarvis/parakeet"),
        dependencies,
        platform: "win32",
      });

      // A compatible adapter must open, receive one sample, close, and decode
      // the utterance through the runtime's createStream API.
      queueMicrotask(() => capture.release());
      assert.equal(await capture.result, "unused");
      assert.isTrue(opened);
      assert.isTrue(closed);
    });
  });
});
