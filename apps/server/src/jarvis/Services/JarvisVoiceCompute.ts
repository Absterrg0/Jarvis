// @effect-diagnostics nodeBuiltinImport:off
import * as NodeNet from "node:net";

import {
  DesktopVoiceBrokerResponse,
  jarvisVoiceBase64ByteLength,
  jarvisVoiceMaxPcmBytes,
  JarvisVoiceInvalidInputError,
  JarvisVoiceRuntimeError,
  JarvisVoiceSynthesizeInput,
  JarvisVoiceSynthesizeResult,
  JarvisVoiceTranscribeInput,
  JarvisVoiceTranscribeResult,
  JarvisVoiceUnavailableError,
  type DesktopVoiceBrokerRequest,
  type JarvisVoiceBrokerBootstrap,
  type JarvisVoiceError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";

export interface JarvisVoiceComputeShape {
  readonly transcribe: (
    input: JarvisVoiceTranscribeInput,
  ) => Effect.Effect<JarvisVoiceTranscribeResult, JarvisVoiceError>;
  readonly synthesize: (
    input: JarvisVoiceSynthesizeInput,
  ) => Effect.Effect<JarvisVoiceSynthesizeResult, JarvisVoiceError>;
}

export class JarvisVoiceCompute extends Context.Service<
  JarvisVoiceCompute,
  JarvisVoiceComputeShape
>()("t3/jarvis/Services/JarvisVoiceCompute") {}

const unavailableService: JarvisVoiceComputeShape = {
  transcribe: () =>
    Effect.fail(
      new JarvisVoiceUnavailableError({
        operation: "transcribe",
        message: "Voice transcription is unavailable on this Jarvis node.",
      }),
    ),
  synthesize: () =>
    Effect.fail(
      new JarvisVoiceUnavailableError({
        operation: "synthesize",
        message: "Voice synthesis is unavailable on this Jarvis node.",
      }),
    ),
};

export const unavailableLayer = Layer.succeed(JarvisVoiceCompute, unavailableService);

export interface JarvisVoiceRuntime {
  readonly transcribe: (
    input: {
      readonly audio: Uint8Array;
      readonly sampleRate: number;
      readonly channels: number;
    },
    signal?: AbortSignal,
  ) => Promise<string>;
  readonly synthesize: (
    text: string,
    signal?: AbortSignal,
  ) => Promise<{
    readonly sampleRate: number;
    readonly channels: 1;
    readonly pcm: Uint8Array;
  }>;
}

const decodeBrokerResponse = Schema.decodeUnknownSync(DesktopVoiceBrokerResponse);
const MAX_BROKER_RESPONSE_BYTES = 12_000_000;

function requestBroker(
  broker: JarvisVoiceBrokerBootstrap,
  request: Omit<DesktopVoiceBrokerRequest, "token">,
  signal: AbortSignal,
): Promise<DesktopVoiceBrokerResponse> {
  return new Promise((resolve, reject) => {
    const socket = NodeNet.createConnection({ host: broker.host, port: broker.port });
    let input = "";
    let settled = false;
    const finish = (cause?: unknown, response?: DesktopVoiceBrokerResponse) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      socket.destroy();
      if (cause !== undefined) {
        reject(cause);
      } else if (response === undefined) {
        reject(new Error("Voice broker closed without a response."));
      } else {
        resolve(response);
      }
    };
    const abort = () => finish(new Error("Voice broker request was cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    socket.setTimeout(190_000, () => finish(new Error("Voice broker request timed out.")));
    socket.once("error", finish);
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ ...request, token: broker.token })}\n`);
    });
    socket.on("data", (chunk) => {
      input += chunk.toString("utf8");
      if (Buffer.byteLength(input, "utf8") > MAX_BROKER_RESPONSE_BYTES) {
        finish(new Error("Voice broker response exceeded its limit."));
        return;
      }
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = decodeBrokerResponse(JSON.parse(input.slice(0, newline)));
        if (response.requestId !== request.requestId) {
          throw new Error("Voice broker response identity did not match the request.");
        }
        finish(undefined, response);
      } catch (cause) {
        finish(cause);
      }
    });
  });
}

function brokerRuntime(broker: JarvisVoiceBrokerBootstrap): JarvisVoiceRuntime {
  let sequence = 0;
  return {
    transcribe: async ({ audio, sampleRate, channels }, providedSignal) => {
      const signal = providedSignal ?? new AbortController().signal;
      const response = await requestBroker(
        broker,
        {
          requestId: `server-voice-${++sequence}`,
          operation: "transcribe",
          input: {
            format: "pcm-s16le",
            audioBase64: Buffer.from(audio).toString("base64"),
            sampleRate,
            channels,
          },
        },
        signal,
      );
      if (!response.ok) throw new Error(response.message);
      if (response.operation !== "transcribe") {
        throw new Error("Voice broker returned the wrong operation.");
      }
      return response.text;
    },
    synthesize: async (text, providedSignal) => {
      const signal = providedSignal ?? new AbortController().signal;
      const response = await requestBroker(
        broker,
        {
          requestId: `server-voice-${++sequence}`,
          operation: "synthesize",
          input: { text },
        },
        signal,
      );
      if (!response.ok) throw new Error(response.message);
      if (response.operation !== "synthesize") {
        throw new Error("Voice broker returned the wrong operation.");
      }
      return {
        sampleRate: response.sampleRate,
        channels: 1 as const,
        pcm: Buffer.from(response.pcmBase64, "base64"),
      };
    },
  };
}

function runtimeError(operation: "transcribe" | "synthesize", cause: unknown) {
  return new JarvisVoiceRuntimeError({
    operation,
    message: cause instanceof Error ? cause.message : `Voice ${operation} failed.`,
  });
}

/** Wrap mono signed 16-bit PCM in the smallest valid RIFF/WAVE container. */
export function encodePcmS16LeWav(input: {
  readonly pcm: Uint8Array;
  readonly sampleRate: number;
  readonly channels: 1;
}): Uint8Array {
  const headerBytes = 44;
  const output = new Uint8Array(headerBytes + input.pcm.byteLength);
  const view = new DataView(output.buffer);
  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      output[offset + index] = value.charCodeAt(index);
    }
  };
  const blockAlign = input.channels * 2;
  writeAscii(0, "RIFF");
  view.setUint32(4, output.byteLength - 8, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, input.channels, true);
  view.setUint32(24, input.sampleRate, true);
  view.setUint32(28, input.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, input.pcm.byteLength, true);
  output.set(input.pcm, headerBytes);
  return output;
}

export function makeLiveService(
  sidecar: JarvisVoiceRuntime,
): Effect.Effect<JarvisVoiceComputeShape> {
  return Effect.gen(function* () {
    const runtimeMutex = yield* Semaphore.make(1);
    const guarded = <A, E>(effect: Effect.Effect<A, E>) => runtimeMutex.withPermits(1)(effect);
    return {
      transcribe: (input) =>
        guarded(
          validateJarvisVoiceTranscribeInput(input).pipe(
            Effect.andThen(
              Effect.tryPromise({
                try: async (signal) => {
                  const audio = Buffer.from(input.audioBase64, "base64");
                  const text = (
                    await sidecar.transcribe(
                      {
                        audio,
                        sampleRate: input.sampleRate,
                        channels: input.channels,
                      },
                      signal,
                    )
                  ).trim();
                  if (text.length === 0) throw new Error("Parakeet returned an empty transcript.");
                  return { text };
                },
                catch: (cause) => runtimeError("transcribe", cause),
              }),
            ),
          ),
        ),
      synthesize: (input) =>
        guarded(
          Effect.tryPromise({
            try: async (signal) => {
              const result = await sidecar.synthesize(input.text, signal);
              const wav = encodePcmS16LeWav(result);
              return { wavBase64: Buffer.from(wav).toString("base64") };
            },
            catch: (cause) => runtimeError("synthesize", cause),
          }),
        ),
    };
  });
}

/**
 * A desktop backend reaches Desktop's one voice worker through an authenticated
 * loopback broker. Plain servers stay inert and never start model processes.
 */
export const layer = Layer.effect(
  JarvisVoiceCompute,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const broker = config.jarvisVoiceBroker;
    if (broker === undefined) {
      return unavailableService;
    }
    return yield* makeLiveService(brokerRuntime(broker));
  }),
);

/** Validate the decoded payload before handing it to a local voice runtime. */
export function validateJarvisVoiceTranscribeInput(
  input: JarvisVoiceTranscribeInput,
): Effect.Effect<void, JarvisVoiceInvalidInputError> {
  const byteLength = jarvisVoiceBase64ByteLength(input.audioBase64);
  const maximumByteLength = jarvisVoiceMaxPcmBytes(input.sampleRate, input.channels);
  if (byteLength === null || byteLength === 0 || byteLength > maximumByteLength) {
    return Effect.fail(
      new JarvisVoiceInvalidInputError({
        operation: "transcribe",
        message: "The encoded voice utterance is empty, malformed, or too large.",
      }),
    );
  }
  if (byteLength % (input.channels * Int16Array.BYTES_PER_ELEMENT) !== 0) {
    return Effect.fail(
      new JarvisVoiceInvalidInputError({
        operation: "transcribe",
        message: "PCM voice audio must contain complete signed 16-bit samples.",
      }),
    );
  }
  return Effect.void;
}
