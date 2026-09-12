import { describe, expect, it } from "@effect/vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RelayDb from "../db.ts";
import { relayEnvironmentLinkLimits, relayEnvironmentLinks } from "../persistence/schema.ts";
import * as EnvironmentLinkLimits from "./EnvironmentLinkLimits.ts";

const layerWithDb = (db: RelayDb.RelayDb["Service"]) =>
  EnvironmentLinkLimits.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, db)));

function makeFakeDb(input: {
  readonly overrideRows?: Effect.Effect<ReadonlyArray<{ readonly maxLinks: number }>, Error>;
  readonly countRows?: Effect.Effect<ReadonlyArray<{ readonly activeLinks: number }>, Error>;
  readonly onCountWhere?: (where: SQL) => void;
}) {
  return {
    select: () => ({
      from: (table: unknown) => {
        if (table === relayEnvironmentLinkLimits) {
          return {
            where: () => ({
              limit: () => input.overrideRows ?? Effect.succeed([]),
            }),
          };
        }
        expect(table).toBe(relayEnvironmentLinks);
        return {
          where: (where: SQL) => {
            expect(where).toBeDefined();
            input.onCountWhere?.(where);
            return input.countRows ?? Effect.succeed([{ activeLinks: 0 }]);
          },
        };
      },
    }),
  } as unknown as RelayDb.RelayDb["Service"];
}

describe("EnvironmentLinkLimits", () => {
  it.effect("allows linking below the default limit", () => {
    const fakeDb = makeFakeDb({
      countRows: Effect.succeed([
        { activeLinks: EnvironmentLinkLimits.DEFAULT_ENVIRONMENT_LINK_LIMIT - 1 },
      ]),
    });

    return Effect.gen(function* () {
      const limits = yield* EnvironmentLinkLimits.EnvironmentLinkLimits;
      yield* limits.ensureCapacity({ userId: "user-1", environmentId: "environment-1" });
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("rejects linking at the default limit of 10", () => {
    const fakeDb = makeFakeDb({
      countRows: Effect.succeed([{ activeLinks: 10 }]),
    });

    return Effect.gen(function* () {
      const limits = yield* EnvironmentLinkLimits.EnvironmentLinkLimits;
      const error = yield* Effect.flip(
        limits.ensureCapacity({ userId: "user-1", environmentId: "environment-1" }),
      );

      expect(error).toMatchObject({
        _tag: "EnvironmentLinkLimitExceeded",
        userId: "user-1",
        environmentId: "environment-1",
        maxLinks: 10,
        activeLinks: 10,
      });
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("excludes the environment being linked so re-links stay idempotent", () => {
    const dialect = new PgDialect();
    let where: SQL | null = null;
    const fakeDb = makeFakeDb({
      countRows: Effect.succeed([{ activeLinks: 0 }]),
      onCountWhere: (next) => {
        where = next;
      },
    });

    return Effect.gen(function* () {
      const limits = yield* EnvironmentLinkLimits.EnvironmentLinkLimits;
      yield* limits.ensureCapacity({ userId: "user-1", environmentId: "environment-1" });

      expect(where).not.toBeNull();
      expect(dialect.sqlToQuery(where!)).toEqual({
        sql: '(("relay_environment_links"."user_id" = $1) and ("relay_environment_links"."environment_id" <> $2) and (("relay_environment_links"."revoked_at" is null)))',
        params: ["user-1", "environment-1"],
      });
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("honors a per-user override above the default", () => {
    const fakeDb = makeFakeDb({
      overrideRows: Effect.succeed([{ maxLinks: 25 }]),
      countRows: Effect.succeed([{ activeLinks: 10 }]),
    });

    return Effect.gen(function* () {
      const limits = yield* EnvironmentLinkLimits.EnvironmentLinkLimits;
      yield* limits.ensureCapacity({ userId: "user-1", environmentId: "environment-1" });
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("honors a per-user override below the default", () => {
    const fakeDb = makeFakeDb({
      overrideRows: Effect.succeed([{ maxLinks: 1 }]),
      countRows: Effect.succeed([{ activeLinks: 1 }]),
    });

    return Effect.gen(function* () {
      const limits = yield* EnvironmentLinkLimits.EnvironmentLinkLimits;
      const error = yield* Effect.flip(
        limits.ensureCapacity({ userId: "user-1", environmentId: "environment-1" }),
      );

      expect(error).toMatchObject({
        _tag: "EnvironmentLinkLimitExceeded",
        maxLinks: 1,
        activeLinks: 1,
      });
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("retains database failures with operation and user identity", () => {
    const cause = new Error("database unavailable");
    const fakeDb = makeFakeDb({
      overrideRows: Effect.fail(cause),
    });

    return Effect.gen(function* () {
      const limits = yield* EnvironmentLinkLimits.EnvironmentLinkLimits;
      const error = yield* Effect.flip(
        limits.ensureCapacity({ userId: "user-1", environmentId: "environment-1" }),
      );

      expect(error).toMatchObject({
        _tag: "EnvironmentLinkLimitPersistenceError",
        operation: "load-limit",
        userId: "user-1",
      });
      expect(error).toHaveProperty("cause", cause);
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("retains count failures with operation and user identity", () => {
    const cause = new Error("database unavailable");
    const fakeDb = makeFakeDb({
      countRows: Effect.fail(cause),
    });

    return Effect.gen(function* () {
      const limits = yield* EnvironmentLinkLimits.EnvironmentLinkLimits;
      const error = yield* Effect.flip(
        limits.ensureCapacity({ userId: "user-1", environmentId: "environment-1" }),
      );

      expect(error).toMatchObject({
        _tag: "EnvironmentLinkLimitPersistenceError",
        operation: "count-links",
        userId: "user-1",
      });
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });
});
