// @effect-diagnostics nodeBuiltinImport:off globalErrorInEffectFailure:off globalErrorInEffectCatch:off
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import { StringDecoder } from "node:string_decoder";

import {
  DesktopVoiceBrokerRequest,
  type DesktopVoiceBrokerResponse,
  type JarvisVoiceBrokerBootstrap,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { DesktopJarvisVoiceService } from "./DesktopJarvisVoice.ts";

const MAX_BROKER_LINE_BYTES = 12_000_000;
const decodeRequest = Schema.decodeUnknownSync(DesktopVoiceBrokerRequest);

export class DesktopVoiceComputeBroker extends Context.Service<
  DesktopVoiceComputeBroker,
  { readonly bootstrap: JarvisVoiceBrokerBootstrap }
>()("@t3tools/desktop/voice/DesktopVoiceComputeBroker") {}

function errorMessage(cause: unknown): string {
  return cause instanceof Error && cause.message.trim().length > 0
    ? cause.message
    : "Desktop voice compute failed.";
}

export const layer = Layer.effect(
  DesktopVoiceComputeBroker,
  Effect.gen(function* () {
    const voice = yield* DesktopJarvisVoiceService;
    const token = NodeCrypto.randomBytes(32).toString("base64url");
    const sockets = new Set<NodeNet.Socket>();
    const runVoiceOperation = <A>(
      signal: AbortSignal,
      operation: (signal: AbortSignal) => Promise<A>,
    ): Promise<A> => {
      if (signal.aborted) return Promise.reject(new Error("Voice broker request was cancelled."));
      return operation(signal);
    };
    const server = NodeNet.createServer((socket) => {
      sockets.add(socket);
      const cancellation = new AbortController();
      socket.once("close", () => {
        sockets.delete(socket);
        cancellation.abort();
      });
      let input = "";
      let inputBytes = 0;
      let handled = false;
      const respond = (response: DesktopVoiceBrokerResponse): void => {
        if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
      };
      socket.setTimeout(190_000, () =>
        socket.destroy(new Error("Voice broker request timed out.")),
      );
      const decoder = new StringDecoder("utf8");
      socket.on("data", (chunk) => {
        if (handled) return;
        // Decode statefully so a multi-byte sequence in request text cannot
        // split across chunks and corrupt into replacement characters.
        input += decoder.write(chunk);
        inputBytes += chunk.length;
        if (inputBytes > MAX_BROKER_LINE_BYTES) {
          handled = true;
          socket.destroy(new Error("Voice broker request exceeded its limit."));
          return;
        }
        const newline = input.indexOf("\n");
        if (newline < 0) return;
        handled = true;
        void (async () => {
          let requestId = "invalid-request";
          try {
            const request = decodeRequest(JSON.parse(input.slice(0, newline)));
            requestId = request.requestId;
            if (request.token !== token) throw new Error("Voice broker authentication failed.");
            if (request.operation === "transcribe") {
              const text = (
                await runVoiceOperation(cancellation.signal, (signal) =>
                  voice.transcribeRemote(request.input, signal),
                )
              ).trim();
              if (text.length === 0) throw new Error("Parakeet returned an empty transcript.");
              respond({ requestId, ok: true, operation: "transcribe", text });
              return;
            }
            const synthesized = await runVoiceOperation(cancellation.signal, (signal) =>
              voice.synthesizeRemote(request.input.text, signal),
            );
            respond({ requestId, ok: true, operation: "synthesize", ...synthesized });
          } catch (cause) {
            respond({ requestId, ok: false, message: errorMessage(cause) });
          }
        })();
      });
      socket.on("error", () => undefined);
    });
    const bootstrap = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          new Promise<JarvisVoiceBrokerBootstrap>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => {
              server.off("error", reject);
              // A later server error (for example a failed accept) must not
              // become an unhandled error event that crashes the worker.
              server.on("error", () => undefined);
              const address = server.address();
              if (address === null || typeof address === "string") {
                reject(new Error("Desktop voice broker did not bind a TCP port."));
                return;
              }
              resolve({ host: "127.0.0.1", port: address.port, token });
            });
          }),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      }),
      () =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              for (const socket of sockets) socket.destroy();
              server.close(() => resolve());
            }),
        ),
    );
    return { bootstrap };
  }),
);
