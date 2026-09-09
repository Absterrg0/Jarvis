import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import { DesktopVoiceBrokerAudio, type JarvisVoiceAudioChunk } from "@t3tools/contracts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeNet from "node:net";
import * as NodeStringDecoder from "node:string_decoder";

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
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";

export interface JarvisVoiceComputeShape {
  readonly streamSpeech: (
    input: JarvisVoiceSynthesizeInput,
  ) => Stream.Stream<JarvisVoiceAudioChunk, JarvisVoiceError>;
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
  streamSpeech: () =>
    Stream.fail(
      new JarvisVoiceUnavailableError({
        operation: "synthesize",
        message: "Voice streaming is unavailable on this node.",
      }),
    ),
  transcribe: () =>
    Effect.fail(
      new JarvisVoiceUnavailableError({
        operation: "transcribe",
        message: "Voice transcription is unavailable on this ARIS node.",
      }),
    ),
  synthesize: () =>
    Effect.fail(
      new JarvisVoiceUnavailableError({
        operation: "synthesize",
        message: "Voice synthesis is unavailable on this ARIS node.",
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
    onAudio?: (chunk: JarvisVoiceAudioChunk) => void,
  ) => Promise<{
    readonly sampleRate: number;
    readonly channels: 1;
    readonly pcm: Uint8Array;
  }>;
}

const isBrokerAudio = Schema.is(DesktopVoiceBrokerAudio);
const decodeBrokerResponse = Schema.decodeUnknownSync(DesktopVoiceBrokerResponse);
const MAX_BROKER_RESPONSE_BYTES = 12_000_000;

/** Single-owner socket request to the desktop voice broker (exported for tests). */
export function requestBroker(
  broker: JarvisVoiceBrokerBootstrap,
  request: Omit<DesktopVoiceBrokerRequest, "token">,
  signal: AbortSignal,
  onAudio?: (chunk: JarvisVoiceAudioChunk) => void,
): Promise<DesktopVoiceBrokerResponse> {
  if (signal.aborted) return Promise.reject(new Error("Voice broker request was cancelled."));
  return new Promise((resolve, reject) => {
    const socket = NodeNet.createConnection({ host: broker.host, port: broker.port });
    const decoder = new NodeStringDecoder.StringDecoder("utf8");
    let input = "";
    let inputBytes = 0;
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
    // One owner settles the request on exactly one of: complete response,
    // clean EOF, close, timeout, or abort. A broker that closes normally
    // before returning a complete line used to leave this promise pending
    // after the socket was gone.
    const settleEarlyClose = () => {
      if (settled) return;
      input += decoder.end();
      const newline = input.indexOf("\n");
      if (newline >= 0) {
        settleLine(input.slice(0, newline));
        return;
      }
      finish(new Error("Voice broker closed without a response."));
    };
    const settleLine = (line: string) => {
      try {
        const parsed: unknown = JSON.parse(line);
        if (isBrokerAudio(parsed)) {
          if (parsed.requestId !== request.requestId || onAudio === undefined)
            throw new Error("Unexpected voice audio.");
          onAudio(parsed.chunk);
          return;
        }
        const response = decodeBrokerResponse(parsed);
        if (response.requestId !== request.requestId) {
          throw new Error("Voice broker response identity did not match the request.");
        }
        finish(undefined, response);
      } catch (cause) {
        finish(cause);
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    socket.setTimeout(190_000, () => finish(new Error("Voice broker request timed out.")));
    socket.once("error", finish);
    socket.once("end", settleEarlyClose);
    socket.once("close", settleEarlyClose);
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ ...request, token: broker.token })}\n`);
    });
    socket.on("data", (chunk) => {
      // Decode statefully: a multi-byte UTF-8 sequence (common in
      // non-English transcripts) can split across socket chunks, and decoding
      // each chunk alone would corrupt it into replacement characters.
      input += decoder.write(chunk);
      inputBytes += chunk.length;
      if (inputBytes > MAX_BROKER_RESPONSE_BYTES) {
        finish(new Error("Voice broker response exceeded its limit."));
        return;
      }
      let newline: number;
      while ((newline = input.indexOf("\n")) >= 0) {
        if (settled) break;
        const line = input.slice(0, newline);
        input = input.slice(newline + 1);
        settleLine(line);
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
    synthesize: async (text, providedSignal, onAudio) => {
      const signal = providedSignal ?? new AbortController().signal;
      const response = await requestBroker(
        broker,
        {
          requestId: `server-voice-${++sequence}`,
          operation: "synthesize",
          ...(onAudio === undefined ? {} : { stream: true }),
          input: { text },
        },
        signal,
        onAudio,
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
  return Effect.succeed({
    transcribe: (input) =>
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
    streamSpeech: (input) =>
      Stream.callback<JarvisVoiceAudioChunk, JarvisVoiceError>(
        (queue) => {
          let sequence = 0;
          let audioBytes = 0;
          return Effect.tryPromise({
            try: async (signal) => {
              await sidecar.synthesize(input.text, signal, (chunk) => {
                const bytes = jarvisVoiceBase64ByteLength(chunk.pcmBase64);
                if (
                  chunk.sequence !== sequence ||
                  chunk.sampleRate !== 24_000 ||
                  chunk.channels !== 1 ||
                  bytes === null ||
                  bytes === 0 ||
                  bytes % 2 !== 0 ||
                  bytes > 45_000 ||
                  audioBytes + bytes > 8_000_000
                ) {
                  throw new Error("Voice stream audio is invalid or out of order.");
                }
                if (!Queue.offerUnsafe(queue, chunk))
                  throw new Error("Voice stream buffer exceeded its limit.");
                sequence += 1;
                audioBytes += bytes;
              });
              if (audioBytes === 0) throw new Error("Voice stream produced no audio.");
            },
            catch: (cause) => runtimeError("synthesize", cause),
          }).pipe(Effect.tap(() => Effect.sync(() => Queue.endUnsafe(queue))));
        },
        { bufferSize: 8192 },
      ),
    synthesize: (input) =>
      Effect.tryPromise({
        try: async (signal) => {
          const result = await sidecar.synthesize(input.text, signal);
          const wav = encodePcmS16LeWav(result);
          return { wavBase64: Buffer.from(wav).toString("base64") };
        },
        catch: (cause) => runtimeError("synthesize", cause),
      }),
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
