import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

export const OPENAI_LIVE_SESSIONS_URL = "https://api.openai.com/v1/live/sessions";
const CREATE_TIMEOUT = "30 seconds";
const END_TIMEOUT = "10 seconds";

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
  /** A confirmed hangup or exact session_id_not_found response proves the slot is free. */
  readonly end: (input: {
    readonly apiKey: Redacted.Redacted<string>;
    readonly sessionId: string;
  }) => Effect.Effect<void, LiveVoiceUpstreamEndFailed>;
}

export class LiveVoiceUpstream extends Context.Service<LiveVoiceUpstream, LiveVoiceUpstreamShape>()(
  "@circe/relay/voice/LiveVoiceUpstream",
) {}

const SessionNotFound = Schema.Struct({
  error: Schema.Struct({
    code: Schema.Literal("session_id_not_found"),
    param: Schema.Literal("session_id"),
  }),
});

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
        client
          .execute(
            HttpClientRequest.post(
              `${OPENAI_LIVE_SESSIONS_URL}/${encodeURIComponent(input.sessionId)}/hangup`,
            ).pipe(
              HttpClientRequest.setHeader(
                "Authorization",
                `Bearer ${Redacted.value(input.apiKey)}`,
              ),
            ),
          )
          .pipe(
            Effect.flatMap((response) => {
              if (response.status >= 200 && response.status < 300) return Effect.void;
              // A generic 404 is not proof: it could be a missing route or proxy response.
              if (response.status === 404)
                return HttpClientResponse.schemaBodyJson(SessionNotFound)(response).pipe(
                  Effect.asVoid,
                );
              return HttpClientResponse.filterStatusOk(response).pipe(Effect.asVoid);
            }),
            Effect.timeout(END_TIMEOUT),
            Effect.mapError(
              (cause) => new LiveVoiceUpstreamEndFailed({ sessionId: input.sessionId, cause }),
            ),
          ),
    });
  }),
);
