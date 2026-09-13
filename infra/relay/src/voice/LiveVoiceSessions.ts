import { and, count, eq, gte, lt } from "drizzle-orm";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { RelayLiveVoiceSessionCreateResponse } from "@t3tools/contracts/relay";
import { CIRCE_LIVE_VOICE_DEFAULT_MODEL, CIRCE_LIVE_VOICE_DEFAULT_VOICE } from "@t3tools/contracts";

import { RelayConfiguration } from "../Config.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as RelayDb from "../db.ts";
import { relayLiveVoiceSessions, relayLiveVoiceStarts } from "../persistence/schema.ts";
import { LiveVoiceUpstream } from "./LiveVoiceUpstream.ts";

/** When to attempt closure after a device disappears; never proof of closure. */
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
  "You are Circe, a calm, friendly voice assistant for the user's coding workspace. Keep replies brief and delegate work to the backend.";

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

export class LiveVoiceEnvironmentDisabled extends Schema.TaggedError<LiveVoiceEnvironmentDisabled>()(
  "LiveVoiceEnvironmentDisabled",
  { environmentId: Schema.String, userId: Schema.String },
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
  | LiveVoiceEnvironmentDisabled
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
  "@circe/relay/voice/LiveVoiceSessions",
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
  // environments instead of guessing which account pays. Creation requires the
  // owning link to be enabled; release must still work to clean up a session
  // after the device is disabled.
  const resolveUserId = (environmentId: string, requireEnabled: boolean) =>
    Effect.gen(function* () {
      const owners = yield* links
        .listOwnersForEnvironment({ environmentId })
        .pipe(Effect.mapError(persistence("list-owners")));
      const owner = owners[0];
      if (owner === undefined) {
        return yield* new LiveVoiceEnvironmentNotLinked({ environmentId });
      }
      if (owners.length > 1) {
        return yield* new LiveVoiceEnvironmentAmbiguous({
          environmentId,
          owners: owners.length,
        });
      }
      if (requireEnabled && !owner.enabled) {
        return yield* new LiveVoiceEnvironmentDisabled({
          environmentId,
          userId: owner.userId,
        });
      }
      return owner.userId;
    });

  const reservationIdentity = (userId: string, reservationId: string) =>
    and(
      eq(relayLiveVoiceSessions.userId, userId),
      eq(relayLiveVoiceSessions.reservationId, reservationId),
    );

  // Only a confirmed rejection or closure can free an account's slot. The
  // token fences delayed cleanup from a later reservation for the same account.
  const deleteReservation = (userId: string, reservationId: string) =>
    db
      .delete(relayLiveVoiceSessions)
      .where(reservationIdentity(userId, reservationId))
      .pipe(Effect.mapError(persistence("release-reservation")));

  return LiveVoiceSessions.of({
    create: Effect.fn("relay.live_voice.create")(function* (input) {
      const liveVoice = configuration.liveVoice;
      const publicKey = liveVoice?.apiKey ?? null;
      if (publicKey === null) {
        return yield* new LiveVoiceNotConfigured();
      }
      const model = liveVoice?.model ?? CIRCE_LIVE_VOICE_DEFAULT_MODEL;
      const voice = liveVoice?.voice ?? CIRCE_LIVE_VOICE_DEFAULT_VOICE;
      const userId = yield* resolveUserId(input.environmentId, true);
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const expiresAt = DateTime.formatIso(
        DateTime.add(now, { milliseconds: LIVE_VOICE_SESSION_TTL_MILLIS }),
      );
      const windowStartIso = DateTime.formatIso(
        DateTime.add(now, { milliseconds: -LIVE_VOICE_USAGE_WINDOW_MILLIS }),
      );

      // End the requesting account's expired backstop session before reserving.
      // A failed close keeps the row so a still-live session cannot free its
      // slot. Scoped to this account so one request never sweeps the fleet.
      const expired = yield* db
        .select({
          reservationId: relayLiveVoiceSessions.reservationId,
          sessionId: relayLiveVoiceSessions.sessionId,
        })
        .from(relayLiveVoiceSessions)
        .where(
          and(
            eq(relayLiveVoiceSessions.userId, userId),
            lt(relayLiveVoiceSessions.expiresAt, nowIso),
          ),
        )
        .limit(1)
        .pipe(Effect.mapError(persistence("list-expired")));
      const expiredRow = expired[0];
      // Missing identity is uncertainty, not proof that nothing was created.
      // This also handles empty ids written by earlier relay versions. Leave
      // such reservations blocked through expiry and process restarts.
      if (expiredRow?.sessionId) {
        const ended = yield* upstream
          .end({ apiKey: publicKey, sessionId: expiredRow.sessionId })
          .pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
          );
        if (ended) {
          yield* deleteReservation(userId, expiredRow.reservationId);
        }
      }

      yield* db
        .delete(relayLiveVoiceStarts)
        .where(lt(relayLiveVoiceStarts.startedAt, windowStartIso))
        .pipe(Effect.mapError(persistence("expire-usage")));
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
          sessionId: null,
          environmentId: input.environmentId,
          expiresAt,
          createdAt: nowIso,
        })
        .onConflictDoNothing({ target: relayLiveVoiceSessions.userId })
        .returning({ reservationId: relayLiveVoiceSessions.reservationId })
        .pipe(Effect.mapError(persistence("reserve-session")));
      const reservation = reserved[0];
      if (reservation === undefined) {
        return yield* new LiveVoiceSessionInUse({ userId });
      }

      const { reservationId } = reservation;
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
              if (cause.outcome === "rejected") {
                yield* deleteReservation(userId, reservationId);
              }
              return yield* new LiveVoiceUpstreamFailed({
                environmentId: input.environmentId,
                cause,
              });
            }),
          ),
        );

      const rememberSession = db
        .update(relayLiveVoiceSessions)
        .set({ sessionId: created.sessionId })
        .where(reservationIdentity(userId, reservationId))
        .returning({ reservationId: relayLiveVoiceSessions.reservationId })
        .pipe(
          Effect.mapError(persistence("finalize-session")),
          Effect.flatMap((rows) =>
            rows.length > 0
              ? Effect.void
              : Effect.fail(
                  new LiveVoicePersistenceFailed({
                    operation: "finalize-session",
                    cause: "The voice reservation was replaced before finalization",
                  }),
                ),
          ),
        );

      // Save the identity before accounting, so a usage-write failure still
      // leaves a session another request can close. If both identity writes
      // fail, the preexisting null-id reservation remains authoritative.
      yield* Effect.gen(function* () {
        yield* rememberSession;
        yield* db
          .insert(relayLiveVoiceStarts)
          .values({ sessionId: created.sessionId, userId, startedAt: nowIso })
          .onConflictDoNothing({ target: relayLiveVoiceStarts.sessionId })
          .pipe(Effect.mapError(persistence("record-usage")));
      }).pipe(
        Effect.onError(() =>
          Effect.gen(function* () {
            yield* rememberSession.pipe(Effect.catch(() => Effect.void));
            const closed = yield* upstream
              .end({ apiKey: publicKey, sessionId: created.sessionId })
              .pipe(
                Effect.as(true),
                Effect.catch(() => Effect.succeed(false)),
              );
            if (closed) {
              // Closure is sufficient even if the identity never persisted.
              yield* deleteReservation(userId, reservationId).pipe(Effect.catch(() => Effect.void));
            } else {
              yield* Effect.logError("Cloud voice cleanup requires confirmed upstream closure", {
                userId,
                reservationId,
                sessionId: created.sessionId,
              });
            }
          }),
        ),
      );

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
      const userId = yield* resolveUserId(input.environmentId, false);
      const rows = yield* db
        .select({
          reservationId: relayLiveVoiceSessions.reservationId,
          sessionId: relayLiveVoiceSessions.sessionId,
        })
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
      // Public release accepts an upstream session id, never a reservation
      // token or an empty identity. Internal callers cannot clear uncertainty.
      if (!row.sessionId) {
        return yield* new LiveVoiceSessionInUse({ userId });
      }
      yield* upstream
        .end({ apiKey: publicKey, sessionId: row.sessionId })
        .pipe(
          Effect.mapError(
            (cause) => new LiveVoiceUpstreamFailed({ environmentId: input.environmentId, cause }),
          ),
        );
      yield* deleteReservation(userId, row.reservationId);
    }),
  });
});

export const layer = Layer.effect(LiveVoiceSessions, make);
