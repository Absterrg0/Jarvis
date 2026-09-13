import { and, count, eq, ne } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import { relayDeviceLimits, relayMobileDevices } from "../persistence/schema.ts";

/**
 * Mobile devices a user may hold at once unless a row in
 * `relay_device_limits` overrides it for that user.
 */
export const DEFAULT_DEVICE_LIMIT = 20;

export class DeviceLimitPersistenceError extends Schema.TaggedError<DeviceLimitPersistenceError>()(
  "DeviceLimitPersistenceError",
  {
    operation: Schema.Literals(["load-limit", "count-devices"]),
    userId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Device limit '${this.operation}' failed for user '${this.userId}'`;
  }
}

export class DeviceLimitExceeded extends Schema.TaggedError<DeviceLimitExceeded>()(
  "DeviceLimitExceeded",
  {
    userId: Schema.String,
    deviceId: Schema.String,
    maxDevices: Schema.Number,
    activeDevices: Schema.Number,
  },
) {
  override get message(): string {
    return `Device limit reached for user '${this.userId}': ${this.activeDevices} of ${this.maxDevices} devices in use`;
  }
}

export class DeviceLimits extends Context.Service<
  DeviceLimits,
  {
    readonly ensureCapacity: (input: {
      readonly userId: string;
      readonly deviceId: string;
    }) => Effect.Effect<void, DeviceLimitExceeded | DeviceLimitPersistenceError>;
  }
>()("@circe/relay/agentActivity/DeviceLimits") {}

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;

  return DeviceLimits.of({
    ensureCapacity: Effect.fn("relay.device_limits.ensure_capacity")(function* (input) {
      const overrides = yield* db
        .select({ maxDevices: relayDeviceLimits.maxDevices })
        .from(relayDeviceLimits)
        .where(eq(relayDeviceLimits.userId, input.userId))
        .limit(1)
        .pipe(
          Effect.mapError(
            (cause) =>
              new DeviceLimitPersistenceError({
                operation: "load-limit",
                userId: input.userId,
                cause,
              }),
          ),
        );
      const maxDevices = overrides[0]?.maxDevices ?? DEFAULT_DEVICE_LIMIT;

      // The device being registered is excluded so that re-registering the
      // same device stays idempotent even when the account is at its limit.
      const counted = yield* db
        .select({ activeDevices: count() })
        .from(relayMobileDevices)
        .where(
          and(
            eq(relayMobileDevices.userId, input.userId),
            ne(relayMobileDevices.deviceId, input.deviceId),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new DeviceLimitPersistenceError({
                operation: "count-devices",
                userId: input.userId,
                cause,
              }),
          ),
        );
      const activeDevices = counted[0]?.activeDevices ?? 0;

      if (activeDevices >= maxDevices) {
        return yield* new DeviceLimitExceeded({
          userId: input.userId,
          deviceId: input.deviceId,
          maxDevices,
          activeDevices,
        });
      }
    }),
  });
});

export const layer = Layer.effect(DeviceLimits, make);
