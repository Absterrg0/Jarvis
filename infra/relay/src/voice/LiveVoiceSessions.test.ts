import { describe, expect, it } from "@effect/vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { RelayConfiguration } from "../Config.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as RelayDb from "../db.ts";
import * as LiveVoiceSessions from "./LiveVoiceSessions.ts";

interface SessionRow {
  readonly userId: string;
  readonly sessionId: string;
  readonly environmentId: string;
  readonly expiresAt: string;
  readonly createdAt: string;
}

const dialect = new PgDialect();
const query = (sql: SQL) => dialect.sqlToQuery(sql);

function makeFakeDb(seed: ReadonlyArray<SessionRow> = []) {
  const rows = new Map<string, SessionRow>(seed.map((row) => [row.userId, row]));
  const service = {
    delete: () => ({
      where: (sql: SQL) =>
        Effect.sync(() => {
          const { sql: text, params } = query(sql);
          if (text.includes("expires_at")) {
            const cutoff = String(params[0]);
            for (const [key, row] of rows) {
              if (row.expiresAt < cutoff) rows.delete(key);
            }
            return;
          }
          if (text.includes("session_id")) {
            const userId = String(params[0]);
            const sessionId = String(params[1]);
            if (rows.get(userId)?.sessionId === sessionId) rows.delete(userId);
            return;
          }
          rows.delete(String(params[0]));
        }),
    }),
    insert: () => ({
      values: (value: SessionRow) => ({
        onConflictDoNothing: () => ({
          returning: () =>
            Effect.sync(() => {
              if (rows.has(value.userId)) return [];
              rows.set(value.userId, value);
              return [{ userId: value.userId }];
            }),
        }),
      }),
    }),
    update: () => ({
      set: (value: { readonly sessionId: string }) => ({
        where: (sql: SQL) =>
          Effect.sync(() => {
            const userId = String(query(sql).params[0]);
            const existing = rows.get(userId);
            if (existing) rows.set(userId, { ...existing, sessionId: value.sessionId });
          }),
      }),
    }),
  } as unknown as RelayDb.RelayDb["Service"];
  return { db: service, rows };
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
  } as unknown as EnvironmentLinks.EnvironmentLinks["Service"]);
}

function makeClient(respond: () => Response) {
  return HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, respond())),
  );
}

const successResponse = () =>
  new Response(JSON.stringify({ session: { id: "sess_1" }, transport: { sdp: "answer-sdp" } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function makeLayer(input: {
  readonly db: RelayDb.RelayDb["Service"];
  readonly links: EnvironmentLinks.EnvironmentLinks["Service"];
  readonly client: ReturnType<typeof HttpClient.make>;
  readonly apiKey: string | null;
}) {
  return LiveVoiceSessions.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(RelayDb.RelayDb, input.db),
        Layer.succeed(EnvironmentLinks.EnvironmentLinks, input.links),
        Layer.succeed(RelayConfiguration, makeConfiguration(input.apiKey)),
        Layer.succeed(HttpClient.HttpClient, input.client),
      ),
    ),
  );
}

describe("LiveVoiceSessions", () => {
  it.effect("reports not-configured when the deployment has no key", () => {
    const { db } = makeFakeDb();
    return Effect.gen(function* () {
      const sessions = yield* LiveVoiceSessions.LiveVoiceSessions;
      const error = yield* Effect.flip(
        sessions.create({ environmentId: "env-1", sdpOffer: "offer" }),
      );
      expect(error._tag).toBe("LiveVoiceNotConfigured");
    }).pipe(
      Effect.provide(
        makeLayer({
          db,
          links: makeLinks(["user-1"]),
          client: makeClient(successResponse),
          apiKey: null,
        }),
      ),
    );
  });

  it.effect("rejects an environment that is not linked to exactly one account", () => {
    const { db } = makeFakeDb();
    return Effect.gen(function* () {
      const sessions = yield* LiveVoiceSessions.LiveVoiceSessions;
      const error = yield* Effect.flip(
        sessions.create({ environmentId: "env-1", sdpOffer: "offer" }),
      );
      expect(error._tag).toBe("LiveVoiceEnvironmentNotLinked");
    }).pipe(
      Effect.provide(
        makeLayer({
          db,
          links: makeLinks([]),
          client: makeClient(successResponse),
          apiKey: "sk-test",
        }),
      ),
    );
  });

  it.effect("mints a session and stores the issued id", () => {
    const { db, rows } = makeFakeDb();
    return Effect.gen(function* () {
      const sessions = yield* LiveVoiceSessions.LiveVoiceSessions;
      const result = yield* sessions.create({ environmentId: "env-1", sdpOffer: "offer" });
      expect(result).toEqual({
        sessionId: "sess_1",
        sdpAnswer: "answer-sdp",
        model: "gpt-live-1",
        voice: "marin",
      });
      expect(rows.get("user-1")?.sessionId).toBe("sess_1");
    }).pipe(
      Effect.provide(
        makeLayer({
          db,
          links: makeLinks(["user-1"]),
          client: makeClient(successResponse),
          apiKey: "sk-test",
        }),
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
    return Effect.gen(function* () {
      const sessions = yield* LiveVoiceSessions.LiveVoiceSessions;
      const error = yield* Effect.flip(
        sessions.create({ environmentId: "env-2", sdpOffer: "offer" }),
      );
      expect(error._tag).toBe("LiveVoiceSessionInUse");
    }).pipe(
      Effect.provide(
        makeLayer({
          db,
          links: makeLinks(["user-1"]),
          client: makeClient(successResponse),
          apiKey: "sk-test",
        }),
      ),
    );
  });

  it.effect("releases the reservation when the upstream call fails", () => {
    const { db, rows } = makeFakeDb();
    return Effect.gen(function* () {
      const sessions = yield* LiveVoiceSessions.LiveVoiceSessions;
      const error = yield* Effect.flip(
        sessions.create({ environmentId: "env-1", sdpOffer: "offer" }),
      );
      expect(error._tag).toBe("LiveVoiceUpstreamFailed");
      expect(rows.size).toBe(0);
    }).pipe(
      Effect.provide(
        makeLayer({
          db,
          links: makeLinks(["user-1"]),
          client: makeClient(() => new Response("nope", { status: 500 })),
          apiKey: "sk-test",
        }),
      ),
    );
  });

  it.effect("releases by session id", () => {
    const { db, rows } = makeFakeDb([
      {
        userId: "user-1",
        sessionId: "sess_1",
        environmentId: "env-1",
        expiresAt: "2999-01-01T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    return Effect.gen(function* () {
      const sessions = yield* LiveVoiceSessions.LiveVoiceSessions;
      yield* sessions.release({ environmentId: "env-1", sessionId: "sess_1" });
      expect(rows.size).toBe(0);
    }).pipe(
      Effect.provide(
        makeLayer({
          db,
          links: makeLinks(["user-1"]),
          client: makeClient(successResponse),
          apiKey: "sk-test",
        }),
      ),
    );
  });
});
