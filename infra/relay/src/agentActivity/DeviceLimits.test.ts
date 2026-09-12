import { describe, expect, it } from "@effect/vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RelayDb from "../db.ts";
import { relayDeviceLimits, relayMobileDevices } from "../persistence/schema.ts";
import * as DeviceLimits from "./DeviceLimits.ts";

const layerWithDb = (db: RelayDb.RelayDb["Service"]) =>
  DeviceLimits.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, db)));

function makeFakeDb(input: {
  readonly overrideRows?: Effect.Effect<ReadonlyArray<{ readonly maxDevices: number }>, Error>;
  readonly countRows?: Effect.Effect<ReadonlyArray<{ readonly activeDevices: number }>, Error>;
  readonly onCountWhere?: (where: SQL) => void;
}) {
  return {
    select: () => ({
      from: (table: unknown) => {
        if (table === relayDeviceLimits) {
          return {
            where: () => ({
              limit: () => input.overrideRows ?? Effect.succeed([]),
            }),
          };
        }
        expect(table).toBe(relayMobileDevices);
        return {
          where: (where: SQL) => {
            expect(where).toBeDefined();
            input.onCountWhere?.(where);
            return input.countRows ?? Effect.succeed([{ activeDevices: 0 }]);
          },
        };
      },
    }),
  } as unknown as RelayDb.RelayDb["Service"];
}

describe("DeviceLimits", () => {
  it.effect("allows registration below the default limit", () => {
    const fakeDb = makeFakeDb({
      countRows: Effect.succeed([{ activeDevices: DeviceLimits.DEFAULT_DEVICE_LIMIT - 1 }]),
    });

    return Effect.gen(function* () {
      const limits = yield* DeviceLimits.DeviceLimits;
      yield* limits.ensureCapacity({ userId: "user-1", deviceId: "device-1" });
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("rejects registration at the default limit of 20", () => {
    const fakeDb = makeFakeDb({
      countRows: Effect.succeed([{ activeDevices: 20 }]),
    });

    return Effect.gen(function* () {
      const limits = yield* DeviceLimits.DeviceLimits;
      const error = yield* Effect.flip(
        limits.ensureCapacity({ userId: "user-1", deviceId: "device-1" }),
      );

      expect(error).toMatchObject({
        _tag: "DeviceLimitExceeded",
        userId: "user-1",
        deviceId: "device-1",
        maxDevices: 20,
        activeDevices: 20,
      });
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("excludes the device being registered so re-registration stays idempotent", () => {
    const dialect = new PgDialect();
    let where: SQL | null = null;
    const fakeDb = makeFakeDb({
      countRows: Effect.succeed([{ activeDevices: 0 }]),
      onCountWhere: (next) => {
        where = next;
      },
    });

    return Effect.gen(function* () {
      const limits = yield* DeviceLimits.DeviceLimits;
      yield* limits.ensureCapacity({ userId: "user-1", deviceId: "device-1" });

      expect(where).not.toBeNull();
      expect(dialect.sqlToQuery(where!)).toEqual({
        sql: '(("relay_mobile_devices"."user_id" = $1) and ("relay_mobile_devices"."device_id" <> $2))',
        params: ["user-1", "device-1"],
      });
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("honors a per-user override above the default", () => {
    const fakeDb = makeFakeDb({
      overrideRows: Effect.succeed([{ maxDevices: 50 }]),
      countRows: Effect.succeed([{ activeDevices: 20 }]),
    });

    return Effect.gen(function* () {
      const limits = yield* DeviceLimits.DeviceLimits;
      yield* limits.ensureCapacity({ userId: "user-1", deviceId: "device-1" });
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("honors a per-user override below the default", () => {
    const fakeDb = makeFakeDb({
      overrideRows: Effect.succeed([{ maxDevices: 1 }]),
      countRows: Effect.succeed([{ activeDevices: 1 }]),
    });

    return Effect.gen(function* () {
      const limits = yield* DeviceLimits.DeviceLimits;
      const error = yield* Effect.flip(
        limits.ensureCapacity({ userId: "user-1", deviceId: "device-1" }),
      );

      expect(error).toMatchObject({
        _tag: "DeviceLimitExceeded",
        maxDevices: 1,
        activeDevices: 1,
      });
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("retains database failures with operation and user identity", () => {
    const cause = new Error("database unavailable");
    const fakeDb = makeFakeDb({
      overrideRows: Effect.fail(cause),
    });

    return Effect.gen(function* () {
      const limits = yield* DeviceLimits.DeviceLimits;
      const error = yield* Effect.flip(
        limits.ensureCapacity({ userId: "user-1", deviceId: "device-1" }),
      );

      expect(error).toMatchObject({
        _tag: "DeviceLimitPersistenceError",
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
      const limits = yield* DeviceLimits.DeviceLimits;
      const error = yield* Effect.flip(
        limits.ensureCapacity({ userId: "user-1", deviceId: "device-1" }),
      );

      expect(error).toMatchObject({
        _tag: "DeviceLimitPersistenceError",
        operation: "count-devices",
        userId: "user-1",
      });
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });
});
