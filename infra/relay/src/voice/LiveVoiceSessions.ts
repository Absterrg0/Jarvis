import { and, eq, lt } from "drizzle-orm";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import type { RelayLiveVoiceSessionCreateResponse } from "@t3tools/contracts/relay";
import {
  JARVIS_LIVE_VOICE_DEFAULT_MODEL,
  JARVIS_LIVE_VOICE_DEFAULT_VOICE,
} from "@t3tools/contracts";

import { RelayConfiguration } from "../Config.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as RelayDb from "../db.ts";
import { relayLiveVoiceSessions } from "../persistence/schema.ts";

export const OPENAI_LIVE_SESSIONS_URL = "https://api.openai.com/v1/live/sessions";
const LIVE_SESSION_TIMEOUT = "30 seconds";
/** Backstop when a device disappears without releasing its session. */
const LIVE_VOICE_SESSION_TTL_MILLIS = 10 * 60_000;

/**
 * The node sends the product instructions it already builds; the relay only
 * pins model and voice so the deployment key cannot be spent on arbitrary
 * configurations.
 */
const FALLBACK_INSTRUCTIONS =
  "You are Jarvis, a calm, friendly voice assistant for the user's coding workspace. Keep replies brief and delegate work to the backend.";

const LiveSessionResponse = Schema.Struct({
  session: Schema.Struct({ id: Schema.String.check(Schema.isMinLength(1)) }),
  transport: Schema.Struct({ sdp: Schema.String.check(Schema.isMinLength(1)) }),
});

export class LiveVoiceNotConfigured extends Schema.TaggedError<LiveVoiceNotConfigured>()(
  "LiveVoiceNotConfigured",
  {},
) {}

export class LiveVoiceEnvironmentNotLinked extends Schema.TaggedError<LiveVoiceEnvironmentNotLinked>()(
  "LiveVoiceEnvironmentNotLinked",
  { environmentId: Schema.String },
) {}

export class LiveVoiceSessionInUse extends Schema.TaggedError<LiveVoiceSessionInUse>()(
  "LiveVoiceSessionInUse",
  { userId: Schema.String },
) {}

export class LiveVoiceUpstreamFailed extends Schema.TaggedError<LiveVoiceUpstreamFailed>()(
  "LiveVoiceUpstreamFailed",
  { environmentId: Schema.String, cause: Schema.Defect() },
) {}

export class LiveVoicePersistenceFailed extends Schema.TaggedError<LiveVoicePersistenceFailed>()(
  "LiveVoicePersistenceFailed",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export type LiveVoiceSessionsError =
  | LiveVoiceNotConfigured
  | LiveVoiceEnvironmentNotLinked
  | LiveVoiceSessionInUse
  | LiveVoiceUpstreamFailed
  | LiveVoicePersistenceFailed;

export interface LiveVoiceSessionsShape {
  readonly create: (input: {
    readonly environmentId: string;
    readonly sdpOffer: string;
    readonly instructions?: string;
  }) => Effect.Effect<RelayLiveVoiceSessionCreateResponse, LiveVoiceSessionsError>;
  readonly release: (input: {
    readonly environmentId: string;
    readonly sessionId: string;
  }) => Effect.Effect<void, LiveVoiceSessionsError>;
}

export class LiveVoiceSessions extends Context.Service<LiveVoiceSessions, LiveVoiceSessionsShape>()(
  "@t3tools/jarvis-relay/voice/LiveVoiceSessions",
) {}

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const links = yield* EnvironmentLinks.EnvironmentLinks;
  const configuration = yield* RelayConfiguration;
  const client = yield* HttpClient.HttpClient;

  const persistence = (operation: string) => (cause: unknown) =>
    new LiveVoicePersistenceFailed({ operation, cause });

  // Cloud voice is account-scoped, so the calling environment must resolve to
  // exactly one linked user. Shared environments are rejected rather than
  // guessing which account pays.
  const resolveUserId = (environmentId: string) =>
    links.listUsersForEnvironment({ environmentId }).pipe(
      Effect.mapError(persistence("list-users")),
      Effect.flatMap((userIds) =>
        userIds.length === 1
          ? Effect.succeed(userIds[0] as string)
          : Effect.fail(new LiveVoiceEnvironmentNotLinked({ environmentId })),
      ),
    );

  const releaseReservation = (userId: string) =>
    db
      .delete(relayLiveVoiceSessions)
      .where(eq(relayLiveVoiceSessions.userId, userId))
      .pipe(Effect.mapError(persistence("release-reservation")), Effect.orDie);

  return LiveVoiceSessions.of({
    create: Effect.fn("relay.live_voice.create")(function* (input) {
      const liveVoice = configuration.liveVoice;
      const publicKey = liveVoice?.apiKey ?? null;
      if (publicKey === null) {
        return yield* new LiveVoiceNotConfigured();
      }
      const model = liveVoice?.model ?? JARVIS_LIVE_VOICE_DEFAULT_MODEL;
      const voice = liveVoice?.voice ?? JARVIS_LIVE_VOICE_DEFAULT_VOICE;
      const userId = yield* resolveUserId(input.environmentId);
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const expiresAt = DateTime.formatIso(
        DateTime.add(now, { milliseconds: LIVE_VOICE_SESSION_TTL_MILLIS }),
      );

      // Drop expired backstops, then reserve the account's single slot. The
      // primary key on user_id makes the reservation atomic across devices.
      yield* db
        .delete(relayLiveVoiceSessions)
        .where(lt(relayLiveVoiceSessions.expiresAt, nowIso))
        .pipe(Effect.mapError(persistence("expire-sessions")), Effect.orDie);
      const reserved = yield* db
        .insert(relayLiveVoiceSessions)
        .values({
          userId,
          sessionId: "",
          environmentId: input.environmentId,
          expiresAt,
          createdAt: nowIso,
        })
        .onConflictDoNothing({ target: relayLiveVoiceSessions.userId })
        .returning({ userId: relayLiveVoiceSessions.userId })
        .pipe(Effect.mapError(persistence("reserve-session")), Effect.orDie);
      if (reserved.length === 0) {
        return yield* new LiveVoiceSessionInUse({ userId });
      }

      const instructions = input.instructions?.trim();
      const upstream = yield* client
        .execute(
          HttpClientRequest.post(OPENAI_LIVE_SESSIONS_URL).pipe(
            HttpClientRequest.setHeader("Authorization", `Bearer ${Redacted.value(publicKey)}`),
            HttpClientRequest.bodyJsonUnsafe({
              session: {
                model,
                instructions:
                  instructions !== undefined && instructions.length > 0
                    ? instructions
                    : FALLBACK_INSTRUCTIONS,
                delegation: { type: "client" },
                audio: { output: { voice } },
              },
              transport: { type: "webrtc", sdp: input.sdpOffer },
            }),
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(LiveSessionResponse)),
          Effect.timeout(LIVE_SESSION_TIMEOUT),
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* releaseReservation(userId);
              return yield* new LiveVoiceUpstreamFailed({
                environmentId: input.environmentId,
                cause,
              });
            }),
          ),
        );

      yield* db
        .update(relayLiveVoiceSessions)
        .set({ sessionId: upstream.session.id })
        .where(eq(relayLiveVoiceSessions.userId, userId))
        .pipe(Effect.mapError(persistence("finalize-session")), Effect.orDie);

      return {
        sessionId: upstream.session.id,
        sdpAnswer: upstream.transport.sdp,
        model,
        voice,
      };
    }),

    release: Effect.fn("relay.live_voice.release")(function* (input) {
      const userId = yield* resolveUserId(input.environmentId);
      // Deleting by user and session id keeps release idempotent and prevents
      // one environment from clearing another account's session.
      yield* db
        .delete(relayLiveVoiceSessions)
        .where(
          and(
            eq(relayLiveVoiceSessions.userId, userId),
            eq(relayLiveVoiceSessions.sessionId, input.sessionId),
          ),
        )
        .pipe(Effect.mapError(persistence("release-session")), Effect.orDie);
    }),
  });
});

export const layer = Layer.effect(LiveVoiceSessions, make);
