import { describe, expect, it } from "@effect/vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import * as RelayDb from "../db.ts";
import * as EnvironmentLinks from "./EnvironmentLinks.ts";

interface LinkRow {
  userId: string;
  environmentId: string;
  enabled: boolean;
  updatedAt: string;
  revokedAt: string | null;
}

const dialect = new PgDialect();
const stringParams = (sql: SQL) =>
  dialect.sqlToQuery(sql).params.filter((value): value is string => typeof value === "string");

function makeFakeDb(seed: ReadonlyArray<LinkRow>) {
  const rows: LinkRow[] = seed.map((row) => ({ ...row }));
  return {
    rows,
    execute: () => Effect.void,
    update: () => ({
      set: (value: { readonly enabled?: boolean; readonly updatedAt?: string }) => ({
        where: (sql: SQL) =>
          Effect.sync(() => {
            const [userId, environmentId] = stringParams(sql);
            const row = rows.find(
              (candidate) =>
                candidate.userId === userId &&
                candidate.environmentId === environmentId &&
                candidate.revokedAt === null,
            );
            if (!row) return;
            if (value.enabled !== undefined) row.enabled = value.enabled;
            if (value.updatedAt !== undefined) row.updatedAt = value.updatedAt;
          }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: (sql: SQL) => {
          const { params } = dialect.sqlToQuery(sql);
          const strings = params.filter((value): value is string => typeof value === "string");
          const userId = strings[0] ?? "";
          const environmentId = strings[1] ?? "";
          if (params.some((value) => typeof value === "boolean")) {
            return {
              orderBy: () =>
                Effect.sync(() =>
                  rows
                    .filter(
                      (row) =>
                        row.userId === userId &&
                        row.revokedAt === null &&
                        row.enabled &&
                        row.environmentId !== environmentId,
                    )
                    .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1))
                    .map((row) => ({ environmentId: row.environmentId })),
                ),
            };
          }
          return {
            limit: (_count: number) =>
              Effect.sync(() =>
                rows
                  .filter(
                    (row) =>
                      row.userId === userId &&
                      row.environmentId === environmentId &&
                      row.revokedAt === null,
                  )
                  .map((row) => ({ environmentId: row.environmentId })),
              ),
          };
        },
      }),
    }),
  } as unknown as RelayDb.RelayDb["Service"] & { rows: LinkRow[] };
}

// The database releases the advisory lock at transaction end; the fake encodes
// the same serialization with a semaphore so concurrent calls cannot interleave.
const layerWith = (db: RelayDb.RelayDb["Service"]) =>
  EnvironmentLinks.layer.pipe(
    Layer.provide(
      Layer.unwrap(
        Effect.gen(function* () {
          const lock = yield* Semaphore.make(1);
          return Layer.mergeAll(
            Layer.succeed(RelayDb.RelayDb, db),
            Layer.succeed(
              RelayDb.RelayTransactions,
              RelayDb.RelayTransactions.of({
                withTransaction: (effect) => lock.withPermits(1)(effect),
              }),
            ),
          );
        }),
      ),
    ),
  );

const row = (environmentId: string, enabled: boolean, updatedAt: string): LinkRow => ({
  userId: "user-1",
  environmentId,
  enabled,
  updatedAt,
  revokedAt: null,
});

describe("EnvironmentLinks enabled policy", () => {
  it.effect("disables a device without touching others", () => {
    const db = makeFakeDb([row("env-1", true, "2026-01-01"), row("env-2", true, "2026-01-02")]);
    return Effect.gen(function* () {
      const links = yield* EnvironmentLinks.EnvironmentLinks;
      const result = yield* links.setEnabled({
        userId: "user-1",
        environmentId: "env-1",
        enabled: false,
      });
      expect(result).toEqual({ autoDisabledEnvironmentId: null });
      expect(
        (db as unknown as { rows: LinkRow[] }).rows.map((entry) => [
          entry.environmentId,
          entry.enabled,
        ]),
      ).toEqual([
        ["env-1", false],
        ["env-2", true],
      ]);
    }).pipe(Effect.provide(layerWith(db)));
  });

  it.effect("enables below the limit without disabling anyone", () => {
    const db = makeFakeDb([row("env-1", false, "2026-01-01"), row("env-2", true, "2026-01-02")]);
    return Effect.gen(function* () {
      const links = yield* EnvironmentLinks.EnvironmentLinks;
      const result = yield* links.setEnabled({
        userId: "user-1",
        environmentId: "env-1",
        enabled: true,
      });
      expect(result).toEqual({ autoDisabledEnvironmentId: null });
      expect((db as unknown as { rows: LinkRow[] }).rows.every((entry) => entry.enabled)).toBe(
        true,
      );
    }).pipe(Effect.provide(layerWith(db)));
  });

  it.effect("enables past the limit by disabling the least-recently-used device", () => {
    const db = makeFakeDb([
      row("env-1", true, "2026-01-01"),
      row("env-2", true, "2026-01-02"),
      row("env-3", true, "2026-01-03"),
      row("env-4", true, "2026-01-04"),
      row("env-5", true, "2026-01-05"),
      row("env-6", false, "2026-01-06"),
    ]);
    return Effect.gen(function* () {
      const links = yield* EnvironmentLinks.EnvironmentLinks;
      const result = yield* links.setEnabled({
        userId: "user-1",
        environmentId: "env-6",
        enabled: true,
      });
      expect(result).toEqual({ autoDisabledEnvironmentId: "env-1" });
      const enabled = (db as unknown as { rows: LinkRow[] }).rows
        .filter((entry) => entry.enabled)
        .map((entry) => entry.environmentId);
      expect(enabled).toHaveLength(5);
      expect(enabled).not.toContain("env-1");
      expect(enabled).toContain("env-6");
    }).pipe(Effect.provide(layerWith(db)));
  });

  it.effect("does not evict another device when the target link does not exist", () => {
    const db = makeFakeDb([
      row("env-1", true, "2026-01-01"),
      row("env-2", true, "2026-01-02"),
      row("env-3", true, "2026-01-03"),
      row("env-4", true, "2026-01-04"),
      row("env-5", true, "2026-01-05"),
    ]);
    return Effect.gen(function* () {
      const links = yield* EnvironmentLinks.EnvironmentLinks;
      const error = yield* Effect.flip(
        links.setEnabled({ userId: "user-1", environmentId: "not-linked", enabled: true }),
      );
      expect(error._tag).toBe("EnvironmentLinkNotFound");
      expect(
        (db as unknown as { rows: LinkRow[] }).rows.filter((entry) => entry.enabled),
      ).toHaveLength(5);
    }).pipe(Effect.provide(layerWith(db)));
  });

  it.effect("keeps the cap when two clients enable different devices at once", () => {
    const db = makeFakeDb([
      row("env-1", true, "2026-01-01"),
      row("env-2", true, "2026-01-02"),
      row("env-3", true, "2026-01-03"),
      row("env-4", true, "2026-01-04"),
      row("env-5", false, "2026-01-05"),
      row("env-6", false, "2026-01-06"),
    ]);
    return Effect.gen(function* () {
      const links = yield* EnvironmentLinks.EnvironmentLinks;
      yield* Effect.all(
        [
          links.setEnabled({ userId: "user-1", environmentId: "env-5", enabled: true }),
          links.setEnabled({ userId: "user-1", environmentId: "env-6", enabled: true }),
        ],
        { concurrency: 2 },
      );
      expect(
        (db as unknown as { rows: LinkRow[] }).rows.filter((entry) => entry.enabled),
      ).toHaveLength(5);
    }).pipe(Effect.provide(layerWith(db)));
  });
});
