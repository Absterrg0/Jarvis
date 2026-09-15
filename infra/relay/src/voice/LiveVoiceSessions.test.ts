import { describe, expect, it } from "@effect/vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { TestClock } from "effect/testing";

import { RelayConfiguration } from "../Config.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as RelayDb from "../db.ts";
import { relayLiveVoiceStarts } from "../persistence/schema.ts";
import * as LiveVoiceSessions from "./LiveVoiceSessions.ts";
import {
  LiveVoiceUpstream,
  LiveVoiceUpstreamCreateFailed,
  LiveVoiceUpstreamEndFailed,
} from "./LiveVoiceUpstream.ts";

interface SessionRow {
  readonly userId: string;
  readonly reservationId: string;
  readonly sessionId: string | null;
  readonly environmentId: string;
  readonly expiresAt: string;
  readonly createdAt: string;
}

interface StartRow {
  readonly sessionId: string;
  readonly userId: string;
  readonly startedAt: string;
}

const dialect = new PgDialect();
const query = (sql: SQL) => dialect.sqlToQuery(sql);

function matchesSession(condition: SQL, row: SessionRow): boolean {
  const { sql: text, params } = query(condition);
  let index = 0;
  if (text.includes('"user_id"')) {
    if (row.userId !== params[index]) return false;
    index += 1;
  }
  if (text.includes('"reservation_id"') && row.reservationId !== params[index]) return false;
  if (text.includes('"expires_at"') && row.expiresAt > String(params[index])) return false;
  if (text.includes('"session_id"') && row.sessionId !== params[index]) return false;
  return true;
}

function makeFakeDb(
  seed: ReadonlyArray<SessionRow> = [],
  options: { readonly failRecordUsage?: boolean; readonly failSessionUpdate?: () => boolean } = {},
) {
  const sessions = new Map<string, SessionRow>(seed.map((row) => [row.userId, row]));
  const starts: StartRow[] = [];
  let nextReservation = 0;
  const service = {
    delete: (table: unknown) => ({
      where: (sql: SQL) =>
        Effect.sync(() => {
          const { sql: text, params } = query(sql);
          if (table === relayLiveVoiceStarts) {
            const cutoff = String(params[0]);
            for (let index = starts.length - 1; index >= 0; index -= 1) {
              const row = starts[index];
              if (row && row.startedAt < cutoff) starts.splice(index, 1);
            }
            return;
          }
          if (text.includes("expires_at")) {
            const cutoff = String(params[0]);
            for (const [key, row] of sessions) {
              if (row.expiresAt < cutoff) sessions.delete(key);
            }
            return;
          }
          const userId = String(params[0]);
          const existing = sessions.get(userId);
          if (existing && matchesSession(sql, existing)) sessions.delete(userId);
        }),
    }),
    insert: (table: unknown) => ({
      values: (value: SessionRow & StartRow) =>
        table === relayLiveVoiceStarts
          ? {
              onConflictDoNothing: () =>
                options.failRecordUsage
                  ? Effect.fail(
                      new LiveVoiceSessions.LiveVoicePersistenceFailed({
                        operation: "record-usage",
                        cause: "fake-failure",
                      }),
                    )
                  : Effect.sync(() => {
                      if (!starts.some((row) => row.sessionId === value.sessionId)) {
                        starts.push({
                          sessionId: value.sessionId,
                          userId: value.userId,
                          startedAt: value.startedAt,
                        });
                      }
                    }),
            }
          : {
              onConflictDoNothing: () => ({
                returning: () =>
                  Effect.sync(() => {
                    if (sessions.has(value.userId)) return [];
                    const reservationId = `reservation-${++nextReservation}`;
                    sessions.set(value.userId, { ...value, reservationId });
                    return [{ reservationId }];
                  }),
              }),
            },
    }),
    update: () => ({
      set: (value: { readonly sessionId?: string; readonly expiresAt?: string }) => ({
        where: (sql: SQL) => {
          const updated = Effect.suspend(() => {
            if (options.failSessionUpdate?.()) {
              return Effect.fail(
                new LiveVoiceSessions.LiveVoicePersistenceFailed({
                  operation: "injected-update-failure",
                  cause: "database write outage",
                }),
              );
            }
            return Effect.sync(() => {
              const userId = String(query(sql).params[0]);
              const existing = sessions.get(userId);
              if (!existing || !matchesSession(sql, existing)) return [];
              sessions.set(userId, { ...existing, ...value });
              return [{ reservationId: existing.reservationId }];
            });
          });
          return Object.assign(updated, { returning: () => updated });
        },
      }),
    }),
    select: (fields: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: (sql: SQL) => {
          const { params } = query(sql);
          if (table === relayLiveVoiceStarts || "used" in fields) {
            const userId = String(params[0]);
            const windowStart = String(params[1]);
            return Effect.sync(() => [
              {
                used: starts.filter((row) => row.userId === userId && row.startedAt >= windowStart)
                  .length,
              },
            ]);
          }
          return {
            limit: () =>
              Effect.sync(() =>
                [...sessions.values()]
                  .filter((row) => matchesSession(sql, row))
                  .map((row) => ({
                    userId: row.userId,
                    sessionId: row.sessionId,
                    reservationId: row.reservationId,
                  })),
              ),
          };
        },
      }),
    }),
  } as unknown as RelayDb.RelayDb["Service"];
  return { db: service, sessions, starts };
}

function makeConfiguration(apiKey: string | null) {
  return RelayConfiguration.of({
    relayIssuer: "https://relay.test",
    apns: null,
    clerkSecretKey: Redacted.make("clerk-secret"),
    clerkPublishableKey: "pk_test",
    clerkJwtAudience: "circe-relay",
    apnsDeliveryJobSigningSecret: Redacted.make("apns-secret"),
    cloudMintPrivateKey: Redacted.make("mint-private"),
    cloudMintPublicKey: "mint-public",
    managedEndpointBaseDomain: undefined,
    managedEndpointNamespace: undefined,
    liveVoice: {
      apiKey: apiKey === null ? null : Redacted.make(apiKey),
      model: "gpt-live-1",
      voice: "marin",
    },
  });
}

function makeLinks(userIds: ReadonlyArray<string>, enabled = true) {
  return EnvironmentLinks.EnvironmentLinks.of({
    listOwnersForEnvironment: () => Effect.succeed(userIds.map((userId) => ({ userId, enabled }))),
    recordUse: () => Effect.void,
  } as unknown as EnvironmentLinks.EnvironmentLinks["Service"]);
}

function makeUpstream(input?: { readonly failCreate?: boolean; readonly failEnd?: boolean }) {
  const active = new Set<string>();
  let next = 0;
  const service = LiveVoiceUpstream.of({
    create: () =>
      input?.failCreate
        ? Effect.fail(new LiveVoiceUpstreamCreateFailed({ outcome: "rejected", cause: "boom" }))
        : Effect.sync(() => {
            const sessionId = `sess_${++next}`;
            active.add(sessionId);
            return { sessionId, sdpAnswer: "answer-sdp" };
          }),
    end: ({ sessionId }) =>
      input?.failEnd
        ? Effect.fail(new LiveVoiceUpstreamEndFailed({ sessionId, cause: "boom" }))
        : Effect.sync(() => {
            active.delete(sessionId);
          }),
  });
  return { service, active };
}

function makeLayer(input: {
  readonly db: RelayDb.RelayDb["Service"];
  readonly links: EnvironmentLinks.EnvironmentLinks["Service"];
  readonly upstream: ReturnType<typeof makeUpstream>["service"];
  readonly apiKey: string | null;
}) {
  return LiveVoiceSessions.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(RelayDb.RelayDb, input.db),
        Layer.succeed(EnvironmentLinks.EnvironmentLinks, input.links),
        Layer.succeed(RelayConfiguration, makeConfiguration(input.apiKey)),
        Layer.succeed(LiveVoiceUpstream, input.upstream),
      ),
    ),
  );
}

describe("LiveVoiceSessions", () => {
  it.effect("reports not-configured when the deployment has no key", () => {
    const { db } = makeFakeDb();
    const { service } = makeUpstream();
    return Effect.gen(function* () {
      const sessions = yield* LiveVoiceSessions.LiveVoiceSessions;
      const error = yield* Effect.flip(
        sessions.create({ environmentId: "env-1", sdpOffer: "offer" }),
      );
      expect(error._tag).toBe("LiveVoiceNotConfigured");
    }).pipe(
      Effect.provide(
        makeLayer({ db, links: makeLinks(["user-1"]), upstream: service, apiKey: null }),
      ),
    );
  });

  it.effect("rejects an environment with no account link", () => {
    const { db } = makeFakeDb();
    const { service } = makeUpstream();
    return Effect.gen(function* () {
      const sessions = yield* LiveVoiceSessions.LiveVoiceSessions;
      const error = yield* Effect.flip(
        sessions.create({ environmentId: "env-1", sdpOffer: "offer" }),
      );
      expect(error._tag).toBe("LiveVoiceEnvironmentNotLinked");
    }).pipe(
      Effect.provide(makeLayer({ db, links: makeLinks([]), upstream: service, apiKey: "sk-test" })),
    );
  });

  it.effect("rejects a shared environment with several account owners", () => {
    const { db } = makeFakeDb();
    const { service } = makeUpstream();
    return Effect.gen(function* () {
      const sessions = yield* LiveVoiceSessions.LiveVoiceSessions;
      const error = yield* Effect.flip(
        sessions.create({ environmentId: "env-1", sdpOffer: "offer" }),
      );
      expect(error._tag).toBe("LiveVoiceEnvironmentAmbiguous");
    }).pipe(
      Effect.provide(
        makeLayer({
          db,
          links: makeLinks(["user-1", "user-2"]),
          upstream: service,
          apiKey: "sk-test",
        }),
      ),
    );
  });

  it.effect("rejects cloud voice for a disabled account link", () => {
    const { db } = makeFakeDb();
    const { service } = makeUpstream();
    return Effect.gen(function* () {
      const sessions = yield* LiveVoiceSessions.LiveVoiceSessions;
      const error = yield* Effect.flip(
        sessions.create({ environmentId: "env-1", sdpOffer: "offer" }),
      );
      expect(error._tag).toBe("LiveVoiceEnvironmentDisabled");
    }).pipe(
      Effect.provide(
        makeLayer({
          db,
          links: makeLinks(["user-1"], false),
          upstream: service,
          apiKey: "sk-test",
        }),
      ),
    );
  });

  it.effect("mints a session, records usage, and stores the issued id", () => {
    const { db, sessions, starts } = makeFakeDb();
    const { service } = makeUpstream();
    return Effect.gen(function* () {
      const voice = yield* LiveVoiceSessions.LiveVoiceSessions;
      const result = yield* voice.create({ environmentId: "env-1", sdpOffer: "offer" });
      expect(result).toEqual({
        sessionId: "sess_1",
        sdpAnswer: "answer-sdp",
        model: "gpt-live-1",
        voice: "marin",
      });
      expect(sessions.get("user-1")?.sessionId).toBe("sess_1");
      expect(starts).toHaveLength(1);
    }).pipe(
      Effect.provide(
        makeLayer({ db, links: makeLinks(["user-1"]), upstream: service, apiKey: "sk-test" }),
      ),
    );
  });

  it.effect("refuses a second active session for the same account", () => {
    const { db } = makeFakeDb([
      {
        userId: "user-1",
        reservationId: "seed-reservation",
        sessionId: "sess_active",
        environmentId: "env-1",
        expiresAt: "2999-01-01T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const { service } = makeUpstream();
    return Effect.gen(function* () {
      const voice = yield* LiveVoiceSessions.LiveVoiceSessions;
      const error = yield* Effect.flip(voice.create({ environmentId: "env-2", sdpOffer: "offer" }));
      expect(error._tag).toBe("LiveVoiceSessionInUse");
    }).pipe(
      Effect.provide(
        makeLayer({ db, links: makeLinks(["user-1"]), upstream: service, apiKey: "sk-test" }),
      ),
    );
  });

  it.effect("releases the reservation when upstream creation fails", () => {
    const { db, sessions } = makeFakeDb();
    const { service } = makeUpstream({ failCreate: true });
    return Effect.gen(function* () {
      const voice = yield* LiveVoiceSessions.LiveVoiceSessions;
      const error = yield* Effect.flip(voice.create({ environmentId: "env-1", sdpOffer: "offer" }));
      expect(error._tag).toBe("LiveVoiceUpstreamFailed");
      expect(sessions.size).toBe(0);
    }).pipe(
      Effect.provide(
        makeLayer({ db, links: makeLinks(["user-1"]), upstream: service, apiKey: "sk-test" }),
      ),
    );
  });

  it.effect("frees the slot only after the upstream confirms the session ended", () => {
    const { db, sessions } = makeFakeDb();
    const { service, active } = makeUpstream();
    return Effect.gen(function* () {
      const voice = yield* LiveVoiceSessions.LiveVoiceSessions;
      const first = yield* voice.create({ environmentId: "env-1", sdpOffer: "offer" });
      yield* voice.release({ environmentId: "env-1", sessionId: first.sessionId });
      yield* voice.create({ environmentId: "env-2", sdpOffer: "offer" });
      expect(active.size).toBe(1);
      expect(sessions.get("user-1")?.sessionId).toBe("sess_2");
    }).pipe(
      Effect.provide(
        makeLayer({ db, links: makeLinks(["user-1"]), upstream: service, apiKey: "sk-test" }),
      ),
    );
  });

  it.effect("retains the slot when the upstream cannot confirm the session ended", () => {
    const { db, sessions } = makeFakeDb();
    const { service } = makeUpstream({ failEnd: true });
    return Effect.gen(function* () {
      const voice = yield* LiveVoiceSessions.LiveVoiceSessions;
      const first = yield* voice.create({ environmentId: "env-1", sdpOffer: "offer" });
      const releaseError = yield* Effect.flip(
        voice.release({ environmentId: "env-1", sessionId: first.sessionId }),
      );
      expect(releaseError._tag).toBe("LiveVoiceUpstreamFailed");
      expect(sessions.get("user-1")?.sessionId).toBe(first.sessionId);
      const createError = yield* Effect.flip(
        voice.create({ environmentId: "env-2", sdpOffer: "offer" }),
      );
      expect(createError._tag).toBe("LiveVoiceSessionInUse");
    }).pipe(
      Effect.provide(
        makeLayer({ db, links: makeLinks(["user-1"]), upstream: service, apiKey: "sk-test" }),
      ),
    );
  });

  it.effect("ends an expired upstream session before discarding its reservation", () => {
    const { db } = makeFakeDb([
      {
        userId: "user-1",
        reservationId: "seed-reservation",
        sessionId: "sess_old",
        environmentId: "env-1",
        expiresAt: "1969-01-01T00:00:00.000Z",
        createdAt: "1999-01-01T00:00:00.000Z",
      },
    ]);
    const { service, active } = makeUpstream();
    active.add("sess_old");
    return Effect.gen(function* () {
      const voice = yield* LiveVoiceSessions.LiveVoiceSessions;
      const result = yield* voice.create({ environmentId: "env-1", sdpOffer: "offer" });
      expect(result.sessionId).toBe("sess_1");
      expect(active.has("sess_old")).toBe(false);
      expect(active.size).toBe(1);
    }).pipe(
      Effect.provide(
        makeLayer({ db, links: makeLinks(["user-1"]), upstream: service, apiKey: "sk-test" }),
      ),
    );
  });

  it.effect("sweeps expired sessions for every account on the server timer", () => {
    const { db, sessions } = makeFakeDb([
      {
        userId: "user-1",
        reservationId: "r-1",
        sessionId: "sess_expired_1",
        environmentId: "env-1",
        expiresAt: "1969-01-01T00:00:00.000Z",
        createdAt: "1999-01-01T00:00:00.000Z",
      },
      {
        userId: "user-2",
        reservationId: "r-2",
        sessionId: "sess_expired_2",
        environmentId: "env-2",
        expiresAt: "1969-01-01T00:00:00.000Z",
        createdAt: "1999-01-01T00:00:00.000Z",
      },
      {
        userId: "user-3",
        reservationId: "r-3",
        sessionId: "sess_live",
        environmentId: "env-3",
        expiresAt: "2999-01-01T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        userId: "user-4",
        reservationId: "r-4",
        sessionId: null,
        environmentId: "env-4",
        expiresAt: "1969-01-01T00:00:00.000Z",
        createdAt: "1999-01-01T00:00:00.000Z",
      },
    ]);
    const { service, active } = makeUpstream();
    active.add("sess_expired_1");
    active.add("sess_expired_2");
    active.add("sess_live");
    return Effect.gen(function* () {
      const voice = yield* LiveVoiceSessions.LiveVoiceSessions;
      yield* voice.sweepExpired();
      // Every expired known session closed across accounts; the live one stays.
      expect(active.has("sess_expired_1")).toBe(false);
      expect(active.has("sess_expired_2")).toBe(false);
      expect(active.has("sess_live")).toBe(true);
      expect(sessions.has("user-1")).toBe(false);
      expect(sessions.has("user-2")).toBe(false);
      expect(sessions.has("user-3")).toBe(true);
      // An unknown upstream identity is never freed by a guess.
      expect(sessions.has("user-4")).toBe(true);
    }).pipe(
      Effect.provide(
        makeLayer({
          db,
          links: makeLinks(["user-1", "user-2", "user-3", "user-4"]),
          upstream: service,
          apiKey: "sk-test",
        }),
      ),
    );
  });

  it.effect("does not delete a different session when releasing a stale session id", () => {
    const { db, sessions } = makeFakeDb([
      {
        userId: "user-1",
        reservationId: "seed-reservation",
        sessionId: "sess_live",
        environmentId: "env-1",
        expiresAt: "2999-01-01T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const { service } = makeUpstream();
    return Effect.gen(function* () {
      const voice = yield* LiveVoiceSessions.LiveVoiceSessions;
      yield* voice.release({ environmentId: "env-1", sessionId: "sess_stale" });
      expect(sessions.get("user-1")?.sessionId).toBe("sess_live");
    }).pipe(
      Effect.provide(
        makeLayer({ db, links: makeLinks(["user-1"]), upstream: service, apiKey: "sk-test" }),
      ),
    );
  });

  it.effect("keeps a recoverable reservation when persistence and close both fail", () => {
    const { db, sessions } = makeFakeDb([], { failRecordUsage: true });
    const { service } = makeUpstream({ failEnd: true });
    return Effect.gen(function* () {
      const voice = yield* LiveVoiceSessions.LiveVoiceSessions;
      const error = yield* Effect.flip(voice.create({ environmentId: "env-1", sdpOffer: "offer" }));
      expect(error._tag).toBe("LiveVoicePersistenceFailed");
      // The upstream identity is retained so a retry cannot start a second
      // live session while the first may still be open.
      expect(sessions.get("user-1")?.sessionId).toBe("sess_1");
      const retry = yield* Effect.flip(voice.create({ environmentId: "env-2", sdpOffer: "offer" }));
      expect(retry._tag).toBe("LiveVoiceSessionInUse");
    }).pipe(
      Effect.provide(
        makeLayer({ db, links: makeLinks(["user-1"]), upstream: service, apiKey: "sk-test" }),
      ),
    );
  });
});

describe("LiveVoiceSessions recovery", () => {
  it.effect(
    "keeps the slot past TTL if both identity writes fail and upstream cannot close",
    () => {
      let failing = true;
      const fake = makeFakeDb([], { failSessionUpdate: () => failing });
      const upstream = makeUpstream({ failEnd: true });
      const db = fake.db;
      return Effect.gen(function* () {
        const voice = yield* LiveVoiceSessions.LiveVoiceSessions;
        const error = yield* Effect.flip(
          voice.create({ environmentId: "env-1", sdpOffer: "offer" }),
        );
        expect(error._tag).toBe("LiveVoicePersistenceFailed");
        expect(upstream.active.size).toBe(1);
        const immediate = yield* Effect.flip(
          voice.create({ environmentId: "env-1", sdpOffer: "offer" }),
        );
        expect(immediate._tag).toBe("LiveVoiceSessionInUse");
        failing = false;
        yield* TestClock.adjust("11 minutes");
        yield* voice
          .create({ environmentId: "env-1", sdpOffer: "offer" })
          .pipe(Effect.catch(() => Effect.void));
        expect(upstream.active.size).toBeLessThanOrEqual(1);
      }).pipe(
        Effect.provide(
          makeLayer({
            db,
            links: makeLinks(["user-1"]),
            upstream: upstream.service,
            apiKey: "sk-test",
          }),
        ),
      );
    },
  );

  it.effect("releases a retained recovery session once upstream closure recovers", () => {
    const fake = makeFakeDb([], { failRecordUsage: true });
    const availability = { failEnd: true };
    const upstream = makeUpstream(availability);
    return Effect.gen(function* () {
      const voice = yield* LiveVoiceSessions.LiveVoiceSessions;
      yield* Effect.flip(voice.create({ environmentId: "env-1", sdpOffer: "offer" }));
      expect(fake.sessions.get("user-1")?.sessionId).toBe("sess_1");
      availability.failEnd = false;
      yield* voice.release({ environmentId: "env-1", sessionId: "sess_1" });
      expect(upstream.active.size).toBe(0);
      expect(fake.sessions.size).toBe(0);
    }).pipe(
      Effect.provide(
        makeLayer({
          db: fake.db,
          links: makeLinks(["user-1"]),
          upstream: upstream.service,
          apiKey: "sk-test",
        }),
      ),
    );
  });

  it.effect("frees a failed-create reservation after confirmed compensation", () => {
    const fake = makeFakeDb([], { failRecordUsage: true });
    const upstream = makeUpstream();
    return Effect.gen(function* () {
      const voice = yield* LiveVoiceSessions.LiveVoiceSessions;
      const error = yield* Effect.flip(voice.create({ environmentId: "env-1", sdpOffer: "offer" }));
      expect(error._tag).toBe("LiveVoicePersistenceFailed");
      expect(upstream.active.size).toBe(0);
      expect(fake.sessions.size).toBe(0);
    }).pipe(
      Effect.provide(
        makeLayer({
          db: fake.db,
          links: makeLinks(["user-1"]),
          upstream: upstream.service,
          apiKey: "sk-test",
        }),
      ),
    );
  });
});

import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";

describe("LiveVoiceSessions reservation ownership", () => {
  it.effect(
    "clears the exact reservation after confirmed close even when both identity writes fail",
    () => {
      const fake = makeFakeDb([], { failSessionUpdate: () => true });
      const upstream = makeUpstream();
      return Effect.gen(function* () {
        const voice = yield* LiveVoiceSessions.LiveVoiceSessions;
        yield* Effect.flip(voice.create({ environmentId: "env-1", sdpOffer: "offer" }));
        expect(upstream.active.size).toBe(0);
        expect(fake.sessions.size).toBe(0);
      }).pipe(
        Effect.provide(
          makeLayer({
            db: fake.db,
            links: makeLinks(["user-1"]),
            upstream: upstream.service,
            apiKey: "sk-test",
          }),
        ),
      );
    },
  );

  it.effect("retains an unknown creation outcome across expiry and service restart", () => {
    const fake = makeFakeDb();
    const upstream = makeUpstream();
    const service = LiveVoiceUpstream.of({
      ...upstream.service,
      create: (input) =>
        upstream.service
          .create(input)
          .pipe(
            Effect.flatMap(() =>
              Effect.fail(
                new LiveVoiceUpstreamCreateFailed({ outcome: "unknown", cause: "lost response" }),
              ),
            ),
          ),
    });
    return Effect.gen(function* () {
      const voice = yield* LiveVoiceSessions.LiveVoiceSessions;
      const error = yield* Effect.flip(voice.create({ environmentId: "env-1", sdpOffer: "offer" }));
      expect(error._tag).toBe("LiveVoiceUpstreamFailed");
      expect(fake.sessions.get("user-1")?.sessionId).toBeNull();
      yield* TestClock.adjust("1 day");
      const restarted = yield* LiveVoiceSessions.make;
      const retry = yield* Effect.flip(
        restarted.create({ environmentId: "env-2", sdpOffer: "offer" }),
      );
      expect(retry._tag).toBe("LiveVoiceSessionInUse");
      expect(upstream.active.size).toBe(1);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          makeLayer({
            db: fake.db,
            links: makeLinks(["user-1"]),
            upstream: service,
            apiKey: "sk-test",
          }),
          Layer.succeed(RelayDb.RelayDb, fake.db),
          Layer.succeed(EnvironmentLinks.EnvironmentLinks, makeLinks(["user-1"])),
          Layer.succeed(RelayConfiguration, makeConfiguration("sk-test")),
          Layer.succeed(LiveVoiceUpstream, service),
        ),
      ),
    );
  });

  it.effect("cannot release an empty legacy reservation", () => {
    const fake = makeFakeDb([
      {
        userId: "user-1",
        reservationId: "legacy",
        sessionId: "",
        environmentId: "env-1",
        createdAt: "1969-01-01",
        expiresAt: "1969-01-02",
      },
    ]);
    const upstream = makeUpstream();
    return Effect.gen(function* () {
      const voice = yield* LiveVoiceSessions.LiveVoiceSessions;
      const release = yield* Effect.flip(voice.release({ environmentId: "env-1", sessionId: "" }));
      expect(release._tag).toBe("LiveVoiceSessionInUse");
      const retry = yield* Effect.flip(voice.create({ environmentId: "env-1", sdpOffer: "offer" }));
      expect(retry._tag).toBe("LiveVoiceSessionInUse");
      expect(fake.sessions.size).toBe(1);
    }).pipe(
      Effect.provide(
        makeLayer({
          db: fake.db,
          links: makeLinks(["user-1"]),
          upstream: upstream.service,
          apiKey: "sk-test",
        }),
      ),
    );
  });

  it.effect("a delayed duplicate release cannot remove a replacement reservation", () =>
    Effect.gen(function* () {
      const fake = makeFakeDb();
      const upstream = makeUpstream();
      const closing = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      let calls = 0;
      const service = LiveVoiceUpstream.of({
        ...upstream.service,
        end: (input) =>
          Effect.gen(function* () {
            if (++calls === 1) {
              yield* Deferred.succeed(closing, undefined);
              yield* Deferred.await(finish);
            }
            yield* upstream.service.end(input);
          }),
      });
      yield* Effect.gen(function* () {
        const voice = yield* LiveVoiceSessions.LiveVoiceSessions;
        const first = yield* voice.create({ environmentId: "env-1", sdpOffer: "offer" });
        const release = yield* voice
          .release({ environmentId: "env-1", sessionId: first.sessionId })
          .pipe(Effect.forkChild);
        yield* Deferred.await(closing);
        yield* voice.release({ environmentId: "env-1", sessionId: first.sessionId });
        const second = yield* voice.create({ environmentId: "env-1", sdpOffer: "offer" });
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(release);
        expect(fake.sessions.get("user-1")?.sessionId).toBe(second.sessionId);
        expect(upstream.active.size).toBe(1);
      }).pipe(
        Effect.provide(
          makeLayer({
            db: fake.db,
            links: makeLinks(["user-1"]),
            upstream: service,
            apiKey: "sk-test",
          }),
        ),
      );
    }),
  );

  it.effect("interruption during upstream creation retains uncertainty", () =>
    Effect.gen(function* () {
      const fake = makeFakeDb();
      const upstream = makeUpstream();
      const created = yield* Deferred.make<void>();
      const service = LiveVoiceUpstream.of({
        ...upstream.service,
        create: (input) =>
          Effect.gen(function* () {
            yield* upstream.service.create(input);
            yield* Deferred.succeed(created, undefined);
            return yield* Effect.never;
          }),
      });
      yield* Effect.gen(function* () {
        const voice = yield* LiveVoiceSessions.LiveVoiceSessions;
        const pending = yield* voice
          .create({ environmentId: "env-1", sdpOffer: "offer" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(created);
        yield* Fiber.interrupt(pending);
        yield* TestClock.adjust("11 minutes");
        const retry = yield* Effect.flip(
          voice.create({ environmentId: "env-1", sdpOffer: "offer" }),
        );
        expect(retry._tag).toBe("LiveVoiceSessionInUse");
        expect(upstream.active.size).toBe(1);
      }).pipe(
        Effect.provide(
          makeLayer({
            db: fake.db,
            links: makeLinks(["user-1"]),
            upstream: service,
            apiKey: "sk-test",
          }),
        ),
      );
    }),
  );
});

it.effect(
  "expiry retains a known session whose close fails and never sweeps another account",
  () => {
    const fake = makeFakeDb([
      {
        userId: "user-1",
        reservationId: "own",
        sessionId: "sess_own",
        environmentId: "env-1",
        createdAt: "1969-01-01",
        expiresAt: "1969-01-02",
      },
      {
        userId: "user-2",
        reservationId: "other",
        sessionId: "sess_other",
        environmentId: "env-2",
        createdAt: "1969-01-01",
        expiresAt: "1969-01-02",
      },
    ]);
    const upstream = makeUpstream();
    const attempted: string[] = [];
    const service = LiveVoiceUpstream.of({
      ...upstream.service,
      end: ({ sessionId }) =>
        Effect.gen(function* () {
          attempted.push(sessionId);
          return yield* new LiveVoiceUpstreamEndFailed({ sessionId, cause: "unavailable" });
        }),
    });
    return Effect.gen(function* () {
      const voice = yield* LiveVoiceSessions.LiveVoiceSessions;
      const retry = yield* Effect.flip(voice.create({ environmentId: "env-1", sdpOffer: "offer" }));
      expect(retry._tag).toBe("LiveVoiceSessionInUse");
      expect(attempted).toEqual(["sess_own"]);
      expect(fake.sessions.size).toBe(2);
    }).pipe(
      Effect.provide(
        makeLayer({
          db: fake.db,
          links: makeLinks(["user-1"]),
          upstream: service,
          apiKey: "sk-test",
        }),
      ),
    );
  },
);

describe("explicit release reconciliation", () => {
  it.effect("retries a failed release through the expired sweep before the next session", () => {
    const fake = makeFakeDb();
    const availability = { failEnd: true };
    const upstream = makeUpstream(availability);
    return Effect.gen(function* () {
      const voice = yield* LiveVoiceSessions.LiveVoiceSessions;
      const first = yield* voice.create({ environmentId: "env-1", sdpOffer: "offer" });
      const before = fake.sessions.get("user-1")?.expiresAt;
      const error = yield* Effect.flip(
        voice.release({ environmentId: "env-1", sessionId: first.sessionId }),
      );
      expect(error._tag).toBe("LiveVoiceUpstreamFailed");
      // The failed release left the exact reservation marked for reconciliation.
      const marked = fake.sessions.get("user-1");
      expect(marked?.sessionId).toBe(first.sessionId);
      expect(marked?.expiresAt).not.toBe(before);
      availability.failEnd = false;
      const second = yield* voice.create({ environmentId: "env-2", sdpOffer: "offer" });
      expect(second.sessionId).not.toBe(first.sessionId);
      expect(upstream.active.has(first.sessionId)).toBe(false);
      expect(upstream.active.size).toBe(1);
      expect(fake.sessions.get("user-1")?.sessionId).toBe(second.sessionId);
    }).pipe(
      Effect.provide(
        makeLayer({
          db: fake.db,
          links: makeLinks(["user-1"]),
          upstream: upstream.service,
          apiKey: "sk-test",
        }),
      ),
    );
  });

  it.effect(
    "reconciles a reservation marked by a crashed release on a new service instance",
    () => {
      const fake = makeFakeDb();
      const availability = { failEnd: true };
      const upstream = makeUpstream(availability);
      return Effect.gen(function* () {
        const voice = yield* LiveVoiceSessions.LiveVoiceSessions;
        const first = yield* voice.create({ environmentId: "env-1", sdpOffer: "offer" });
        yield* Effect.flip(voice.release({ environmentId: "env-1", sessionId: first.sessionId }));
        // Process restart: a fresh service reads the durable marked reservation.
        const restarted = yield* LiveVoiceSessions.make;
        availability.failEnd = false;
        const second = yield* restarted.create({ environmentId: "env-1", sdpOffer: "offer" });
        expect(second.sessionId).not.toBe(first.sessionId);
        expect(upstream.active.has(first.sessionId)).toBe(false);
        expect(upstream.active.size).toBe(1);
        expect(fake.sessions.get("user-1")?.sessionId).toBe(second.sessionId);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            makeLayer({
              db: fake.db,
              links: makeLinks(["user-1"]),
              upstream: upstream.service,
              apiKey: "sk-test",
            }),
            Layer.succeed(RelayDb.RelayDb, fake.db),
            Layer.succeed(EnvironmentLinks.EnvironmentLinks, makeLinks(["user-1"])),
            Layer.succeed(RelayConfiguration, makeConfiguration("sk-test")),
            Layer.succeed(LiveVoiceUpstream, upstream.service),
          ),
        ),
      );
    },
  );

  it.effect("keeps the account blocked when reconciliation cannot confirm closure", () => {
    const fake = makeFakeDb();
    const upstream = makeUpstream({ failEnd: true });
    return Effect.gen(function* () {
      const voice = yield* LiveVoiceSessions.LiveVoiceSessions;
      const first = yield* voice.create({ environmentId: "env-1", sdpOffer: "offer" });
      yield* Effect.flip(voice.release({ environmentId: "env-1", sessionId: first.sessionId }));
      const retry = yield* Effect.flip(voice.create({ environmentId: "env-2", sdpOffer: "offer" }));
      expect(retry._tag).toBe("LiveVoiceSessionInUse");
      expect(fake.sessions.get("user-1")?.sessionId).toBe(first.sessionId);
      expect(upstream.active.has(first.sessionId)).toBe(true);
    }).pipe(
      Effect.provide(
        makeLayer({
          db: fake.db,
          links: makeLinks(["user-1"]),
          upstream: upstream.service,
          apiKey: "sk-test",
        }),
      ),
    );
  });

  it.effect("deletes the reservation immediately on a confirmed release", () => {
    const fake = makeFakeDb();
    const upstream = makeUpstream();
    return Effect.gen(function* () {
      const voice = yield* LiveVoiceSessions.LiveVoiceSessions;
      const first = yield* voice.create({ environmentId: "env-1", sdpOffer: "offer" });
      yield* voice.release({ environmentId: "env-1", sessionId: first.sessionId });
      expect(fake.sessions.size).toBe(0);
      expect(upstream.active.size).toBe(0);
    }).pipe(
      Effect.provide(
        makeLayer({
          db: fake.db,
          links: makeLinks(["user-1"]),
          upstream: upstream.service,
          apiKey: "sk-test",
        }),
      ),
    );
  });
});
