// @effect-diagnostics globalFetch:off globalTimers:off -- the GPT-Live sideband is a
// Workers WebSocket upgrade, which HttpClient and Effect timers cannot express.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

export const OPENAI_LIVE_SESSIONS_URL = "https://api.openai.com/v1/live/sessions";
const CREATE_TIMEOUT = "30 seconds";
/** Bounded wait for the upstream to acknowledge `session.close`. */
const END_TIMEOUT_MS = 5_000;

const LiveSessionResponse = Schema.Struct({
  session: Schema.Struct({ id: Schema.String.check(Schema.isMinLength(1)) }),
  transport: Schema.Struct({ sdp: Schema.String.check(Schema.isMinLength(1)) }),
});

export class LiveVoiceUpstreamCreateFailed extends Schema.TaggedError<LiveVoiceUpstreamCreateFailed>()(
  "LiveVoiceUpstreamCreateFailed",
  { outcome: Schema.Literals(["rejected", "unknown"]), cause: Schema.Defect() },
) {}

export class LiveVoiceUpstreamEndFailed extends Schema.TaggedError<LiveVoiceUpstreamEndFailed>()(
  "LiveVoiceUpstreamEndFailed",
  { sessionId: Schema.String, cause: Schema.Defect() },
) {}

export interface LiveVoiceUpstreamShape {
  /** A transport/decode failure may have created a session; only rejection proves otherwise. */
  readonly create: (input: {
    readonly apiKey: Redacted.Redacted<string>;
    readonly sdpOffer: string;
    readonly instructions: string;
    readonly model: string;
    readonly voice: string;
  }) => Effect.Effect<
    { readonly sessionId: string; readonly sdpAnswer: string },
    LiveVoiceUpstreamCreateFailed
  >;
  /**
   * Ends the upstream session over its sideband socket and resolves only after
   * the service acknowledges `session.closed`. A failure here means the session
   * may still be live, so the caller must not free its account slot.
   */
  readonly end: (input: {
    readonly apiKey: Redacted.Redacted<string>;
    readonly sessionId: string;
  }) => Effect.Effect<void, LiveVoiceUpstreamEndFailed>;
}

export class LiveVoiceUpstream extends Context.Service<LiveVoiceUpstream, LiveVoiceUpstreamShape>()(
  "@t3tools/jarvis-relay/voice/LiveVoiceUpstream",
) {}

/** Closes the sideband socket after a verified `session.closed`, or on failure. */
async function closeSideband(apiKey: Redacted.Redacted<string>, sessionId: string): Promise<void> {
  const response = await fetch(
    `${OPENAI_LIVE_SESSIONS_URL}/${encodeURIComponent(sessionId)}/attach`,
    {
      headers: {
        Upgrade: "websocket",
        Authorization: `Bearer ${Redacted.value(apiKey)}`,
      },
    },
  );
  const socket = (response as unknown as { readonly webSocket?: WebSocket }).webSocket;
  if (socket === undefined) {
    throw new Error("The live session sideband is unavailable");
  }
  socket.accept();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // The socket may already be closed by the peer.
      }
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error("Timed out waiting for session.closed")),
      END_TIMEOUT_MS,
    );
    socket.addEventListener("message", (event) => {
      try {
        const parsed: unknown = JSON.parse(String(event.data));
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          (parsed as { readonly type?: unknown }).type === "session.closed"
        ) {
          finish();
        }
      } catch {
        // Ignore non-JSON frames; the timeout remains the backstop.
      }
    });
    socket.addEventListener("error", () => finish(new Error("Sideband socket error")));
    socket.send(JSON.stringify({ type: "session.close", event_id: "relay-close" }));
  });
}

export const layer = Layer.effect(
  LiveVoiceUpstream,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return LiveVoiceUpstream.of({
      create: (input) =>
        client
          .execute(
            HttpClientRequest.post(OPENAI_LIVE_SESSIONS_URL).pipe(
              HttpClientRequest.setHeader(
                "Authorization",
                `Bearer ${Redacted.value(input.apiKey)}`,
              ),
              HttpClientRequest.bodyJsonUnsafe({
                session: {
                  model: input.model,
                  instructions: input.instructions,
                  delegation: { type: "client" },
                  audio: { output: { voice: input.voice } },
                },
                transport: { type: "webrtc", sdp: input.sdpOffer },
              }),
            ),
          )
          .pipe(
            Effect.mapError(
              (cause) => new LiveVoiceUpstreamCreateFailed({ outcome: "unknown", cause }),
            ),
            Effect.flatMap((response) => {
              if (response.status < 200 || response.status >= 300) {
                return Effect.fail(
                  new LiveVoiceUpstreamCreateFailed({
                    // A received rejection is distinct from a lost response.
                    // Treat timeouts and server failures conservatively.
                    outcome:
                      response.status >= 400 && response.status < 500 && response.status !== 408
                        ? "rejected"
                        : "unknown",
                    cause: { status: response.status },
                  }),
                );
              }
              return HttpClientResponse.schemaBodyJson(LiveSessionResponse)(response).pipe(
                Effect.mapError(
                  (cause) => new LiveVoiceUpstreamCreateFailed({ outcome: "unknown", cause }),
                ),
              );
            }),
            Effect.timeout(CREATE_TIMEOUT),
            Effect.catchTag("TimeoutError", (cause) =>
              Effect.fail(new LiveVoiceUpstreamCreateFailed({ outcome: "unknown", cause })),
            ),
            Effect.map((response) => ({
              sessionId: response.session.id,
              sdpAnswer: response.transport.sdp,
            })),
          ),
      end: (input) =>
        Effect.tryPromise({
          try: () => closeSideband(input.apiKey, input.sessionId),
          catch: (cause) => new LiveVoiceUpstreamEndFailed({ sessionId: input.sessionId, cause }),
        }),
    });
  }),
);
