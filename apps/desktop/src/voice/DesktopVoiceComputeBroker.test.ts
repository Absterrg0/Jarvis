import * as NodeNet from "node:net";

import { DesktopVoiceBrokerResponse, type DesktopVoiceBrokerRequest } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { DesktopJarvisVoiceService, type DesktopJarvisVoice } from "./DesktopJarvisVoice.ts";
import {
  DesktopVoiceComputeBroker,
  layer as desktopVoiceComputeBrokerLayer,
} from "./DesktopVoiceComputeBroker.ts";

const decodeResponse = Schema.decodeUnknownSync(DesktopVoiceBrokerResponse);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function openRequest(
  bootstrap: { readonly host: string; readonly port: number; readonly token: string },
  request: Omit<DesktopVoiceBrokerRequest, "token">,
) {
  const socket = NodeNet.createConnection({ host: bootstrap.host, port: bootstrap.port });
  let input = "";
  const response = new Promise<ReturnType<typeof decodeResponse>>((resolve, reject) => {
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      input += chunk.toString("utf8");
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      try {
        resolve(decodeResponse(JSON.parse(input.slice(0, newline))));
      } catch (cause) {
        reject(cause);
      }
    });
  });
  socket.once("connect", () => {
    socket.write(`${JSON.stringify({ ...request, token: bootstrap.token })}\n`);
  });
  return { socket, response };
}

function makeVoice(input: {
  readonly firstStarted: () => void;
  readonly firstAborted: () => void;
  readonly firstResult: Promise<string>;
  readonly secondStarted: () => void;
}): DesktopJarvisVoice {
  let active = false;
  return {
    getState: () => ({ status: "ready", native: true }),
    prepare: async () => ({ status: "ready", native: true }),
    prepareSpeech: async () => ({ accepted: true }),
    playAcknowledgement: async () => ({ accepted: true }),
    startCapture: async () => ({ accepted: false }),
    pushPcmFrame: async () => ({ accepted: false }),
    releaseCapture: async () => ({ accepted: false }),
    cancelCapture: async () => ({ accepted: false }),
    speak: async () => ({ status: "deferred", reason: "busy" }),
    cancelSpeech: async () => ({ accepted: false }),
    interrupt: async () => ({ accepted: false }),
    transcribeRemote: async (_input, signal) => {
      if (active) throw new Error("Desktop voice is busy.");
      active = true;
      signal?.addEventListener(
        "abort",
        () => {
          active = false;
          input.firstAborted();
        },
        { once: true },
      );
      input.firstStarted();
      return await input.firstResult;
    },
    synthesizeRemote: async () => {
      if (active) throw new Error("Desktop voice is busy.");
      input.secondStarted();
      return { sampleRate: 24_000, channels: 1, pcmBase64: "AAAA" };
    },
    onState: () => () => undefined,
    onLevel: () => () => undefined,
    stop: () => undefined,
  };
}

describe("DesktopVoiceComputeBroker", () => {
  it.effect("releases cancelled work before accepting the next request", () => {
    const firstStarted = deferred<void>();
    const firstAborted = deferred<void>();
    const secondStarted = deferred<void>();
    const firstResult = deferred<string>();
    const voice = makeVoice({
      firstStarted: () => firstStarted.resolve(),
      firstAborted: () => firstAborted.resolve(),
      firstResult: firstResult.promise,
      secondStarted: () => secondStarted.resolve(),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* DesktopVoiceComputeBroker;
        const first = openRequest(broker.bootstrap, {
          requestId: "first-request",
          operation: "transcribe",
          input: {
            format: "pcm-s16le",
            audioBase64: "AAAA",
            sampleRate: 16_000,
            channels: 1,
          },
        });
        void first.response.catch(() => undefined);
        yield* Effect.promise(() => firstStarted.promise);

        first.socket.destroy();
        yield* Effect.promise(() => firstAborted.promise);

        const second = openRequest(broker.bootstrap, {
          requestId: "second-request",
          operation: "synthesize",
          input: { text: "fresh" },
        });
        yield* Effect.promise(() => secondStarted.promise);

        // This is the old operation completing after its caller disconnected.
        firstResult.resolve("stale");
        yield* Effect.promise(() => second.response).pipe(
          Effect.tap((response) =>
            Effect.sync(() => {
              expect(response).toEqual({
                requestId: "second-request",
                ok: true,
                operation: "synthesize",
                sampleRate: 24_000,
                channels: 1,
                pcmBase64: "AAAA",
              });
            }),
          ),
        );
        second.socket.destroy();
      }).pipe(
        Effect.provide(
          desktopVoiceComputeBrokerLayer.pipe(
            Layer.provide(Layer.succeed(DesktopJarvisVoiceService, voice)),
          ),
        ),
      ),
    );
  });
});
