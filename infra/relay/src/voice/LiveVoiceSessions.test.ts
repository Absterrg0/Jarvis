import { describe, expect, it } from "@effect/vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import { RelayConfiguration } from "../Config.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as RelayDb from "../db.ts";
import { relayLiveVoiceSessions, relayLiveVoiceStarts } from "../persistence/schema.ts";
import * as LiveVoiceSessions from "./LiveVoiceSessions.ts";
import {
  LiveVoiceUpstream,
  LiveVoiceUpstreamCreateFailed,
  LiveVoiceUpstreamEndFailed,
} from "./LiveVoiceUpstream.ts";

interface SessionRow {
  readonly userId: string;
  readonly sessionId: string;
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

function makeFakeDb(seed: ReadonlyArray<SessionRow> = []) {
  const sessions = new Map<string, SessionRow>(seed.map((row) => [row.userId, row]));
  const starts: StartRow[] = [];
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
          sessions.delete(String(params[0]));
        }),
    }),
    insert: (table: unknown) => ({
      values: (value: SessionRow & StartRow) =>
        table === relayLiveVoiceStarts
          ? {
              onConflictDoNothing: () =>
                Effect.sync(() => {
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
                    sessions.set(value.userId, value);
                    return [{ userId: value.userId }];
                  }),
              }),
            },
    }),
    update: () => ({
      set: (value: { readonly sessionId: string }) => ({
        where: (sql: SQL) =>
          Effect.sync(() => {
            const userId = String(query(sql).params[0]);
            const existing = sessions.get(userId);
            if (existing) sessions.set(userId, { ...existing, sessionId: value.sessionId });
          }),
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
              Effect.sync(() => {
                const userId = String(params[0]);
                const sessionId = String(params[1]);
                const row = sessions.get(userId);
                return row && row.sessionId === sessionId ? [{ sessionId: row.sessionId }] : [];
              }),
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
    clerkJwtAudience: "t3-code-relay",
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

function makeLinks(userIds: ReadonlyArray<string>) {
  return EnvironmentLinks.EnvironmentLinks.of({
    listUsersForEnvironment: () => Effect.succeed(userIds),
    listOwnersForEnvironment: () => Effect.succeed(userIds),
  } as unknown as EnvironmentLinks.EnvironmentLinks["Service"]);
}

function makeUpstream(input?: { readonly failCreate?: boolean; readonly failEnd?: boolean }) {
  const active = new Set<string>();
  let next = 0;
  const service = LiveVoiceUpstream.of({
    create: () =>
      input?.failCreate
        ? Effect.fail(new LiveVoiceUpstreamCreateFailed({ cause: "boom" }))
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
});
