import { and, count, eq, gte, lt } from "drizzle-orm";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { RelayLiveVoiceSessionCreateResponse } from "@t3tools/contracts/relay";
import {
  JARVIS_LIVE_VOICE_DEFAULT_MODEL,
  JARVIS_LIVE_VOICE_DEFAULT_VOICE,
} from "@t3tools/contracts";

import { RelayConfiguration } from "../Config.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as RelayDb from "../db.ts";
import { relayLiveVoiceSessions, relayLiveVoiceStarts } from "../persistence/schema.ts";
import { LiveVoiceUpstream } from "./LiveVoiceUpstream.ts";

/** Backstop when a device disappears without releasing its session. */
const LIVE_VOICE_SESSION_TTL_MILLIS = 10 * 60_000;
/** Sessions one account may start in the rolling usage window. */
export const DEFAULT_LIVE_VOICE_SESSION_LIMIT = 60;
const LIVE_VOICE_USAGE_WINDOW_MILLIS = 24 * 60 * 60_000;

/**
 * The node sends the product instructions it already builds; the relay only
 * pins model and voice so the deployment key cannot be spent on arbitrary
 * configurations.
 */
const FALLBACK_INSTRUCTIONS =
  "You are Jarvis, a calm, friendly voice assistant for the user's coding workspace. Keep replies brief and delegate work to the backend.";

export class LiveVoiceNotConfigured extends Schema.TaggedError<LiveVoiceNotConfigured>()(
  "LiveVoiceNotConfigured",
  {},
) {}

export class LiveVoiceEnvironmentNotLinked extends Schema.TaggedError<LiveVoiceEnvironmentNotLinked>()(
  "LiveVoiceEnvironmentNotLinked",
  { environmentId: Schema.String },
) {}

export class LiveVoiceEnvironmentAmbiguous extends Schema.TaggedError<LiveVoiceEnvironmentAmbiguous>()(
  "LiveVoiceEnvironmentAmbiguous",
  { environmentId: Schema.String, owners: Schema.Number },
) {}

export class LiveVoiceSessionInUse extends Schema.TaggedError<LiveVoiceSessionInUse>()(
  "LiveVoiceSessionInUse",
  { userId: Schema.String },
) {}

export class LiveVoiceUsageLimitExceeded extends Schema.TaggedError<LiveVoiceUsageLimitExceeded>()(
  "LiveVoiceUsageLimitExceeded",
  { userId: Schema.String, limit: Schema.Number },
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
  | LiveVoiceEnvironmentAmbiguous
  | LiveVoiceSessionInUse
  | LiveVoiceUsageLimitExceeded
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
  const upstream = yield* LiveVoiceUpstream;

  const persistence = (operation: string) => (cause: unknown) =>
    new LiveVoicePersistenceFailed({ operation, cause });

  // Cloud voice is account-scoped. Resolve ownership from every non-revoked
  // link, independent of notification preferences, and reject shared
  // environments instead of guessing which account pays.
  const resolveUserId = (environmentId: string) =>
    Effect.gen(function* () {
      const owners = yield* links
        .listOwnersForEnvironment({ environmentId })
        .pipe(Effect.mapError(persistence("list-owners")));
      if (owners.length === 1) return owners[0] as string;
      if (owners.length === 0) {
        return yield* new LiveVoiceEnvironmentNotLinked({ environmentId });
      }
      return yield* new LiveVoiceEnvironmentAmbiguous({
        environmentId,
        owners: owners.length,
      });
    });

  const deleteReservation = (userId: string) =>
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
      const windowStartIso = DateTime.formatIso(
        DateTime.add(now, { milliseconds: -LIVE_VOICE_USAGE_WINDOW_MILLIS }),
      );

      // Drop expired backstops and stale usage rows before enforcing the bound.
      yield* db
        .delete(relayLiveVoiceSessions)
        .where(lt(relayLiveVoiceSessions.expiresAt, nowIso))
        .pipe(Effect.mapError(persistence("expire-sessions")), Effect.orDie);
      yield* db
        .delete(relayLiveVoiceStarts)
        .where(lt(relayLiveVoiceStarts.startedAt, windowStartIso))
        .pipe(Effect.mapError(persistence("expire-usage")), Effect.orDie);
      const usedRows = yield* db
        .select({ used: count() })
        .from(relayLiveVoiceStarts)
        .where(
          and(
            eq(relayLiveVoiceStarts.userId, userId),
            gte(relayLiveVoiceStarts.startedAt, windowStartIso),
          ),
        )
        .pipe(Effect.mapError(persistence("count-usage")));
      const used = usedRows[0]?.used ?? 0;
      if (used >= DEFAULT_LIVE_VOICE_SESSION_LIMIT) {
        return yield* new LiveVoiceUsageLimitExceeded({
          userId,
          limit: DEFAULT_LIVE_VOICE_SESSION_LIMIT,
        });
      }

      // Reserve the account's single slot. The primary key on user_id makes the
      // reservation atomic across devices.
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
      const created = yield* upstream
        .create({
          apiKey: publicKey,
          sdpOffer: input.sdpOffer,
          instructions:
            instructions !== undefined && instructions.length > 0
              ? instructions
              : FALLBACK_INSTRUCTIONS,
          model,
          voice,
        })
        .pipe(
          Effect.catch((cause) =>
            Effect.gen(function* () {
              yield* deleteReservation(userId);
              return yield* new LiveVoiceUpstreamFailed({
                environmentId: input.environmentId,
                cause,
              });
            }),
          ),
        );

      yield* db
        .insert(relayLiveVoiceStarts)
        .values({ sessionId: created.sessionId, userId, startedAt: nowIso })
        .onConflictDoNothing({ target: relayLiveVoiceStarts.sessionId })
        .pipe(Effect.mapError(persistence("record-usage")), Effect.orDie);
      yield* db
        .update(relayLiveVoiceSessions)
        .set({ sessionId: created.sessionId })
        .where(eq(relayLiveVoiceSessions.userId, userId))
        .pipe(Effect.mapError(persistence("finalize-session")), Effect.orDie);

      return {
        sessionId: created.sessionId,
        sdpAnswer: created.sdpAnswer,
        model,
        voice,
      };
    }),

    release: Effect.fn("relay.live_voice.release")(function* (input) {
      const liveVoice = configuration.liveVoice;
      const publicKey = liveVoice?.apiKey ?? null;
      if (publicKey === null) {
        return yield* new LiveVoiceNotConfigured();
      }
      const userId = yield* resolveUserId(input.environmentId);
      const rows = yield* db
        .select({ sessionId: relayLiveVoiceSessions.sessionId })
        .from(relayLiveVoiceSessions)
        .where(
          and(
            eq(relayLiveVoiceSessions.userId, userId),
            eq(relayLiveVoiceSessions.sessionId, input.sessionId),
          ),
        )
        .limit(1)
        .pipe(Effect.mapError(persistence("lookup-session")));
      const row = rows[0];
      // Idempotent: nothing to release.
      if (row === undefined) return;
      // The session never reached the upstream, so there is nothing to end.
      if (row.sessionId.length > 0) {
        // Only free the slot once the upstream confirms the session closed.
        // A failed end leaves the reservation in place so a still-live session
        // cannot be replaced by a second one.
        yield* upstream.end({ apiKey: publicKey, sessionId: row.sessionId }).pipe(
          Effect.catch((cause) =>
            Effect.fail(
              new LiveVoiceUpstreamFailed({
                environmentId: input.environmentId,
                cause,
              }),
            ),
          ),
        );
      }
      yield* db
        .delete(relayLiveVoiceSessions)
        .where(eq(relayLiveVoiceSessions.userId, userId))
        .pipe(Effect.mapError(persistence("release-session")), Effect.orDie);
    }),
  });
});

export const layer = Layer.effect(LiveVoiceSessions, make);
