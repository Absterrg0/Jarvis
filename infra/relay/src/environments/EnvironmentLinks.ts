import type {
  RelayClientEnvironmentRecord,
  RelayEnvironmentLinkProofPayload,
  RelayEnvironmentLinkRequest,
  RelayManagedEndpoint,
} from "@t3tools/contracts/relay";
import { RELAY_DEFAULT_ENABLED_DEVICE_LIMIT } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { and, count, eq, isNull, ne, or, sql } from "drizzle-orm";

import * as RelayDb from "../db.ts";
import { relayEnvironmentLinks } from "../persistence/schema.ts";

/** Enabled devices an account may use at once unless this changes. */
export const DEFAULT_ENABLED_DEVICE_LIMIT = RELAY_DEFAULT_ENABLED_DEVICE_LIMIT;

export interface RelayLinkedEnvironmentRecord extends RelayClientEnvironmentRecord {
  readonly environmentPublicKey: string;
}

export interface AgentAwarenessDeliveryUserRecord {
  readonly userId: string;
  readonly notificationsEnabled: boolean;
  readonly liveActivitiesEnabled: boolean;
}

export class EnvironmentLinkUpsertPersistenceError extends Schema.TaggedError<EnvironmentLinkUpsertPersistenceError>()(
  "EnvironmentLinkUpsertPersistenceError",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    deviceId: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to persist environment link for user '${this.userId}', environment '${this.environmentId}'`;
  }
}

export class EnvironmentLinkUserListPersistenceError extends Schema.TaggedError<EnvironmentLinkUserListPersistenceError>()(
  "EnvironmentLinkUserListPersistenceError",
  {
    operation: Schema.Literals(["list-users", "list-delivery-users"]),
    environmentId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Environment link user query '${this.operation}' failed for environment '${this.environmentId}'`;
  }
}

export class EnvironmentPublicKeyListPersistenceError extends Schema.TaggedError<EnvironmentPublicKeyListPersistenceError>()(
  "EnvironmentPublicKeyListPersistenceError",
  {
    environmentId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to list public keys for environment '${this.environmentId}'`;
  }
}

export class EnvironmentLinkListPersistenceError extends Schema.TaggedError<EnvironmentLinkListPersistenceError>()(
  "EnvironmentLinkListPersistenceError",
  {
    userId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to list environment links for user '${this.userId}'`;
  }
}

export class EnvironmentLinkLookupPersistenceError extends Schema.TaggedError<EnvironmentLinkLookupPersistenceError>()(
  "EnvironmentLinkLookupPersistenceError",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to look up environment link for user '${this.userId}', environment '${this.environmentId}'`;
  }
}

export class EnvironmentLinkRevokePersistenceError extends Schema.TaggedError<EnvironmentLinkRevokePersistenceError>()(
  "EnvironmentLinkRevokePersistenceError",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to revoke environment link for user '${this.userId}', environment '${this.environmentId}'`;
  }
}

export class EnvironmentLinkSetEnabledPersistenceError extends Schema.TaggedError<EnvironmentLinkSetEnabledPersistenceError>()(
  "EnvironmentLinkSetEnabledPersistenceError",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to set enabled state for user '${this.userId}', environment '${this.environmentId}'`;
  }
}

export class EnvironmentLinkNotFound extends Schema.TaggedError<EnvironmentLinkNotFound>()(
  "EnvironmentLinkNotFound",
  {
    userId: Schema.String,
    environmentId: Schema.String,
  },
) {
  override get message(): string {
    return `No active environment link for user '${this.userId}', environment '${this.environmentId}'`;
  }
}

export class EnvironmentLinks extends Context.Service<
  EnvironmentLinks,
  {
    readonly upsert: (input: {
      readonly userId: string;
      readonly request: RelayEnvironmentLinkRequest;
      readonly proof: RelayEnvironmentLinkProofPayload;
      readonly endpoint: RelayManagedEndpoint;
    }) => Effect.Effect<void, EnvironmentLinkUpsertPersistenceError>;
    readonly listUsersForEnvironment: (input: {
      readonly environmentId: string;
    }) => Effect.Effect<ReadonlyArray<string>, EnvironmentLinkUserListPersistenceError>;
    /**
     * Every account with a non-revoked link to this environment, with that
     * link's enablement, independent of notification preferences. Account
     * ownership for billing, policy, and spending must not depend on delivery
     * audience settings.
     */
    readonly listOwnersForEnvironment: (input: {
      readonly environmentId: string;
    }) => Effect.Effect<
      ReadonlyArray<{ readonly userId: string; readonly enabled: boolean }>,
      EnvironmentLinkUserListPersistenceError
    >;
    readonly listDeliveryUsersForEnvironment: (input: {
      readonly environmentId: string;
      readonly environmentPublicKey: string;
    }) => Effect.Effect<
      ReadonlyArray<AgentAwarenessDeliveryUserRecord>,
      EnvironmentLinkUserListPersistenceError
    >;
    readonly listPublicKeysForEnvironment: (input: {
      readonly environmentId: string;
    }) => Effect.Effect<ReadonlyArray<string>, EnvironmentPublicKeyListPersistenceError>;
    readonly listForUser: (input: {
      readonly userId: string;
    }) => Effect.Effect<
      ReadonlyArray<RelayClientEnvironmentRecord>,
      EnvironmentLinkListPersistenceError
    >;
    readonly getForUser: (input: {
      readonly userId: string;
      readonly environmentId: string;
    }) => Effect.Effect<RelayLinkedEnvironmentRecord | null, EnvironmentLinkLookupPersistenceError>;
    readonly revokeForUser: (input: {
      readonly userId: string;
      readonly environmentId: string;
    }) => Effect.Effect<boolean, EnvironmentLinkRevokePersistenceError>;
    /**
     * Enables or disables one linked device. Enabling past the enabled-device
     * limit disables the least-recently-updated other enabled device so the
     * account always stays within the cap, and reports which one it turned off.
     */
    readonly setEnabled: (input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly enabled: boolean;
    }) => Effect.Effect<
      { readonly autoDisabledEnvironmentId: string | null },
      EnvironmentLinkSetEnabledPersistenceError | EnvironmentLinkNotFound
    >;
    /** Records a successful managed connection so eviction can use real use. */
    readonly recordUse: (input: {
      readonly userId: string;
      readonly environmentId: string;
    }) => Effect.Effect<void, EnvironmentLinkSetEnabledPersistenceError>;
  }
>()("@t3tools/jarvis-relay/environments/EnvironmentLinks") {}

function agentAwarenessDeliveryUserCondition(environmentId: string) {
  return and(
    eq(relayEnvironmentLinks.environmentId, environmentId),
    isNull(relayEnvironmentLinks.revokedAt),
    or(
      eq(relayEnvironmentLinks.notificationsEnabled, true),
      eq(relayEnvironmentLinks.liveActivitiesEnabled, true),
    ),
  );
}

function agentAwarenessDeliveryUserKeyCondition(input: {
  readonly environmentId: string;
  readonly environmentPublicKey: string;
}) {
  return and(
    agentAwarenessDeliveryUserCondition(input.environmentId),
    eq(relayEnvironmentLinks.environmentPublicKey, input.environmentPublicKey),
  );
}

const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;

  // Serializes enable/disable policy per account so concurrent requests in one
  // isolate cannot both read the same enabled set and each enable a device.
  const accountLocks = new Map<string, Semaphore.Semaphore>();
  const withAccountLock = <A, E, R>(
    userId: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      let lock = accountLocks.get(userId);
      if (lock === undefined) {
        lock = yield* Semaphore.make(1);
        accountLocks.set(userId, lock);
      }
      return yield* lock.withPermits(1)(effect);
    });

  return EnvironmentLinks.of({
    upsert: Effect.fn("relay.environment_links.upsert")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.environment_id": input.proof.environmentId,
      });
      const now = DateTime.formatIso(yield* DateTime.now);
      const { request, proof } = input;
      const environmentId = proof.environmentId;
      const { endpoint } = input;
      const enabledRows = yield* db
        .select({ enabledCount: count() })
        .from(relayEnvironmentLinks)
        .where(
          and(
            eq(relayEnvironmentLinks.userId, input.userId),
            isNull(relayEnvironmentLinks.revokedAt),
            eq(relayEnvironmentLinks.enabled, true),
            ne(relayEnvironmentLinks.environmentId, environmentId),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new EnvironmentLinkUpsertPersistenceError({
                userId: input.userId,
                environmentId,
                ...(request.deviceId === undefined ? {} : { deviceId: request.deviceId }),
                cause,
              }),
          ),
        );
      // A new device past the enabled cap links in a disabled state; the user
      // enables it deliberately from another device.
      const enabledOnLink = (enabledRows[0]?.enabledCount ?? 0) < DEFAULT_ENABLED_DEVICE_LIMIT;
      yield* db
        .insert(relayEnvironmentLinks)
        .values({
          userId: input.userId,
          environmentId,
          environmentLabel: proof.descriptor.label,
          environmentPublicKey: proof.environmentPublicKey,
          endpointHttpBaseUrl: endpoint.httpBaseUrl,
          endpointWsBaseUrl: endpoint.wsBaseUrl,
          endpointProviderKind: endpoint.providerKind,
          notificationsEnabled: request.notificationsEnabled,
          liveActivitiesEnabled: request.liveActivitiesEnabled,
          managedTunnelsEnabled: request.managedTunnelsEnabled,
          enabled: enabledOnLink,
          createdByDeviceId: request.deviceId ?? null,
          revokedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [relayEnvironmentLinks.userId, relayEnvironmentLinks.environmentId],
          set: {
            environmentPublicKey: proof.environmentPublicKey,
            environmentLabel: proof.descriptor.label,
            endpointHttpBaseUrl: endpoint.httpBaseUrl,
            endpointWsBaseUrl: endpoint.wsBaseUrl,
            endpointProviderKind: endpoint.providerKind,
            notificationsEnabled: request.notificationsEnabled,
            liveActivitiesEnabled: request.liveActivitiesEnabled,
            managedTunnelsEnabled: request.managedTunnelsEnabled,
            enabled: enabledOnLink,
            createdByDeviceId: request.deviceId ?? null,
            revokedAt: null,
            updatedAt: now,
          },
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new EnvironmentLinkUpsertPersistenceError({
                userId: input.userId,
                environmentId,
                ...(request.deviceId === undefined ? {} : { deviceId: request.deviceId }),
                cause,
              }),
          ),
        );
    }),

    listUsersForEnvironment: Effect.fn("relay.environment_links.list_users_for_environment")(
      function* (input) {
        yield* Effect.annotateCurrentSpan({ "relay.environment_id": input.environmentId });
        return yield* db
          .select({ userId: relayEnvironmentLinks.userId })
          .from(relayEnvironmentLinks)
          .where(agentAwarenessDeliveryUserCondition(input.environmentId))
          .pipe(
            Effect.map((rows) => rows.map((row) => row.userId)),
            Effect.mapError(
              (cause) =>
                new EnvironmentLinkUserListPersistenceError({
                  operation: "list-users",
                  environmentId: input.environmentId,
                  cause,
                }),
            ),
          );
      },
    ),

    listOwnersForEnvironment: Effect.fn("relay.environment_links.list_owners_for_environment")(
      function* (input) {
        yield* Effect.annotateCurrentSpan({ "relay.environment_id": input.environmentId });
        return yield* db
          .select({
            userId: relayEnvironmentLinks.userId,
            enabled: relayEnvironmentLinks.enabled,
          })
          .from(relayEnvironmentLinks)
          .where(
            and(
              eq(relayEnvironmentLinks.environmentId, input.environmentId),
              isNull(relayEnvironmentLinks.revokedAt),
            ),
          )
          .pipe(
            Effect.map((rows) => rows.map((row) => ({ userId: row.userId, enabled: row.enabled }))),
            Effect.mapError(
              (cause) =>
                new EnvironmentLinkUserListPersistenceError({
                  operation: "list-users",
                  environmentId: input.environmentId,
                  cause,
                }),
            ),
          );
      },
    ),

    listDeliveryUsersForEnvironment: Effect.fn(
      "relay.environment_links.list_delivery_users_for_environment",
    )(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.environment_id": input.environmentId });
      return yield* db
        .select({
          userId: relayEnvironmentLinks.userId,
          notificationsEnabled: relayEnvironmentLinks.notificationsEnabled,
          liveActivitiesEnabled: relayEnvironmentLinks.liveActivitiesEnabled,
        })
        .from(relayEnvironmentLinks)
        .where(agentAwarenessDeliveryUserKeyCondition(input))
        .pipe(
          Effect.map((rows) =>
            rows.map((row) => ({
              userId: row.userId,
              notificationsEnabled: row.notificationsEnabled,
              liveActivitiesEnabled: row.liveActivitiesEnabled,
            })),
          ),
          Effect.mapError(
            (cause) =>
              new EnvironmentLinkUserListPersistenceError({
                operation: "list-delivery-users",
                environmentId: input.environmentId,
                cause,
              }),
          ),
        );
    }),

    listPublicKeysForEnvironment: Effect.fn(
      "relay.environment_links.list_public_keys_for_environment",
    )(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.environment_id": input.environmentId });
      return yield* db
        .select({ environmentPublicKey: relayEnvironmentLinks.environmentPublicKey })
        .from(relayEnvironmentLinks)
        .where(
          and(
            eq(relayEnvironmentLinks.environmentId, input.environmentId),
            isNull(relayEnvironmentLinks.revokedAt),
          ),
        )
        .pipe(
          Effect.map((rows) => [
            ...new Set(rows.map((row) => row.environmentPublicKey).filter((key) => key.length > 0)),
          ]),
          Effect.mapError(
            (cause) =>
              new EnvironmentPublicKeyListPersistenceError({
                environmentId: input.environmentId,
                cause,
              }),
          ),
        );
    }),

    listForUser: Effect.fn("relay.environment_links.list_for_user")(function* (input) {
      return yield* db
        .select({
          environmentId: relayEnvironmentLinks.environmentId,
          environmentLabel: relayEnvironmentLinks.environmentLabel,
          endpointHttpBaseUrl: relayEnvironmentLinks.endpointHttpBaseUrl,
          endpointWsBaseUrl: relayEnvironmentLinks.endpointWsBaseUrl,
          endpointProviderKind: relayEnvironmentLinks.endpointProviderKind,
          createdAt: relayEnvironmentLinks.createdAt,
          enabled: relayEnvironmentLinks.enabled,
        })
        .from(relayEnvironmentLinks)
        .where(
          and(
            eq(relayEnvironmentLinks.userId, input.userId),
            isNull(relayEnvironmentLinks.revokedAt),
          ),
        )
        .pipe(
          Effect.map((rows) =>
            rows.map((row) => ({
              environmentId: row.environmentId as RelayClientEnvironmentRecord["environmentId"],
              label:
                row.environmentLabel.trim().length > 0 ? row.environmentLabel : row.environmentId,
              endpoint: {
                httpBaseUrl: row.endpointHttpBaseUrl,
                wsBaseUrl: row.endpointWsBaseUrl,
                providerKind:
                  row.endpointProviderKind as RelayClientEnvironmentRecord["endpoint"]["providerKind"],
              },
              linkedAt: row.createdAt,
              enabled: row.enabled,
            })),
          ),
          Effect.mapError(
            (cause) =>
              new EnvironmentLinkListPersistenceError({
                userId: input.userId,
                cause,
              }),
          ),
        );
    }),

    getForUser: Effect.fn("relay.environment_links.get_for_user")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.environment_id": input.environmentId,
      });
      return yield* db
        .select({
          environmentId: relayEnvironmentLinks.environmentId,
          environmentLabel: relayEnvironmentLinks.environmentLabel,
          environmentPublicKey: relayEnvironmentLinks.environmentPublicKey,
          endpointHttpBaseUrl: relayEnvironmentLinks.endpointHttpBaseUrl,
          endpointWsBaseUrl: relayEnvironmentLinks.endpointWsBaseUrl,
          endpointProviderKind: relayEnvironmentLinks.endpointProviderKind,
          createdAt: relayEnvironmentLinks.createdAt,
          enabled: relayEnvironmentLinks.enabled,
        })
        .from(relayEnvironmentLinks)
        .where(
          and(
            eq(relayEnvironmentLinks.userId, input.userId),
            eq(relayEnvironmentLinks.environmentId, input.environmentId),
            isNull(relayEnvironmentLinks.revokedAt),
          ),
        )
        .limit(1)
        .pipe(
          Effect.map((rows) => {
            const row = rows[0];
            return row
              ? {
                  environmentId: row.environmentId as RelayClientEnvironmentRecord["environmentId"],
                  label:
                    row.environmentLabel.trim().length > 0
                      ? row.environmentLabel
                      : row.environmentId,
                  endpoint: {
                    httpBaseUrl: row.endpointHttpBaseUrl,
                    wsBaseUrl: row.endpointWsBaseUrl,
                    providerKind:
                      row.endpointProviderKind as RelayClientEnvironmentRecord["endpoint"]["providerKind"],
                  },
                  environmentPublicKey: row.environmentPublicKey,
                  linkedAt: row.createdAt,
                  enabled: row.enabled,
                }
              : null;
          }),
          Effect.mapError(
            (cause) =>
              new EnvironmentLinkLookupPersistenceError({
                userId: input.userId,
                environmentId: input.environmentId,
                cause,
              }),
          ),
        );
    }),

    revokeForUser: Effect.fn("relay.environment_links.revoke_for_user")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.environment_id": input.environmentId,
      });
      const revokedAt = DateTime.formatIso(yield* DateTime.now);
      const rows = yield* db
        .update(relayEnvironmentLinks)
        .set({
          revokedAt,
          updatedAt: revokedAt,
        })
        .where(
          and(
            eq(relayEnvironmentLinks.userId, input.userId),
            eq(relayEnvironmentLinks.environmentId, input.environmentId),
            isNull(relayEnvironmentLinks.revokedAt),
          ),
        )
        .returning({ environmentId: relayEnvironmentLinks.environmentId })
        .pipe(
          Effect.mapError(
            (cause) =>
              new EnvironmentLinkRevokePersistenceError({
                userId: input.userId,
                environmentId: input.environmentId,
                cause,
              }),
          ),
        );
      return rows.length > 0;
    }),

    setEnabled: Effect.fn("relay.environment_links.set_enabled")(function* (input) {
      const now = DateTime.formatIso(yield* DateTime.now);
      const ownedCondition = and(
        eq(relayEnvironmentLinks.userId, input.userId),
        isNull(relayEnvironmentLinks.revokedAt),
      );
      const persistence = (cause: unknown) =>
        new EnvironmentLinkSetEnabledPersistenceError({
          userId: input.userId,
          environmentId: input.environmentId,
          cause,
        });

      return yield* withAccountLock(
        input.userId,
        Effect.gen(function* () {
          // Validate the target before any eviction: a stale or foreign
          // environment id must not turn another machine off.
          const target = yield* db
            .select({ environmentId: relayEnvironmentLinks.environmentId })
            .from(relayEnvironmentLinks)
            .where(
              and(ownedCondition, eq(relayEnvironmentLinks.environmentId, input.environmentId)),
            )
            .limit(1)
            .pipe(Effect.mapError(persistence));
          if (target.length === 0) {
            return yield* new EnvironmentLinkNotFound({
              userId: input.userId,
              environmentId: input.environmentId,
            });
          }

          if (!input.enabled) {
            yield* db
              .update(relayEnvironmentLinks)
              .set({ enabled: false, updatedAt: now })
              .where(
                and(ownedCondition, eq(relayEnvironmentLinks.environmentId, input.environmentId)),
              )
              .pipe(Effect.mapError(persistence));
            return { autoDisabledEnvironmentId: null };
          }

          // Enabling past the cap turns off the least-recently-used other device
          // so the account never exceeds the limit. Never-used links sort by
          // their link time, so a freshly linked idle device is evicted first.
          const others = yield* db
            .select({ environmentId: relayEnvironmentLinks.environmentId })
            .from(relayEnvironmentLinks)
            .where(
              and(
                ownedCondition,
                eq(relayEnvironmentLinks.enabled, true),
                ne(relayEnvironmentLinks.environmentId, input.environmentId),
              ),
            )
            .orderBy(
              sql`coalesce(${relayEnvironmentLinks.lastUsedAt}, ${relayEnvironmentLinks.createdAt}) asc`,
            )
            .pipe(Effect.mapError(persistence));

          let autoDisabledEnvironmentId: string | null = null;
          if (others.length >= DEFAULT_ENABLED_DEVICE_LIMIT) {
            const oldest = others[0];
            if (oldest) {
              yield* db
                .update(relayEnvironmentLinks)
                .set({ enabled: false, updatedAt: now })
                .where(
                  and(
                    ownedCondition,
                    eq(relayEnvironmentLinks.environmentId, oldest.environmentId),
                  ),
                )
                .pipe(Effect.mapError(persistence));
              autoDisabledEnvironmentId = oldest.environmentId;
            }
          }

          yield* db
            .update(relayEnvironmentLinks)
            .set({ enabled: true, updatedAt: now })
            .where(
              and(ownedCondition, eq(relayEnvironmentLinks.environmentId, input.environmentId)),
            )
            .pipe(Effect.mapError(persistence));
          return { autoDisabledEnvironmentId };
        }),
      );
    }),

    recordUse: Effect.fn("relay.environment_links.record_use")(function* (input) {
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* db
        .update(relayEnvironmentLinks)
        .set({ lastUsedAt: now })
        .where(
          and(
            eq(relayEnvironmentLinks.userId, input.userId),
            eq(relayEnvironmentLinks.environmentId, input.environmentId),
            isNull(relayEnvironmentLinks.revokedAt),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new EnvironmentLinkSetEnabledPersistenceError({
                userId: input.userId,
                environmentId: input.environmentId,
                cause,
              }),
          ),
        );
    }),
  });
});

export const layer = Layer.effect(EnvironmentLinks, make);
