import { and, count, eq, isNull, ne } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import { relayEnvironmentLinkLimits, relayEnvironmentLinks } from "../persistence/schema.ts";

/**
 * Environment links a user may hold at once unless a row in
 * `relay_environment_link_limits` overrides it for that user.
 */
export const DEFAULT_ENVIRONMENT_LINK_LIMIT = 10;

export class EnvironmentLinkLimitPersistenceError extends Schema.TaggedError<EnvironmentLinkLimitPersistenceError>()(
  "EnvironmentLinkLimitPersistenceError",
  {
    operation: Schema.Literals(["load-limit", "count-links"]),
    userId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Environment link limit '${this.operation}' failed for user '${this.userId}'`;
  }
}

export class EnvironmentLinkLimitExceeded extends Schema.TaggedError<EnvironmentLinkLimitExceeded>()(
  "EnvironmentLinkLimitExceeded",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    maxLinks: Schema.Number,
    activeLinks: Schema.Number,
  },
) {
  override get message(): string {
    return `Environment link limit reached for user '${this.userId}': ${this.activeLinks} of ${this.maxLinks} links in use`;
  }
}

export class EnvironmentLinkLimits extends Context.Service<
  EnvironmentLinkLimits,
  {
    readonly ensureCapacity: (input: {
      readonly userId: string;
      readonly environmentId: string;
    }) => Effect.Effect<void, EnvironmentLinkLimitExceeded | EnvironmentLinkLimitPersistenceError>;
  }
>()("@t3tools/jarvis-relay/environments/EnvironmentLinkLimits") {}

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;

  return EnvironmentLinkLimits.of({
    ensureCapacity: Effect.fn("relay.environment_link_limits.ensure_capacity")(function* (input) {
      const overrides = yield* db
        .select({ maxLinks: relayEnvironmentLinkLimits.maxLinks })
        .from(relayEnvironmentLinkLimits)
        .where(eq(relayEnvironmentLinkLimits.userId, input.userId))
        .limit(1)
        .pipe(
          Effect.mapError(
            (cause) =>
              new EnvironmentLinkLimitPersistenceError({
                operation: "load-limit",
                userId: input.userId,
                cause,
              }),
          ),
        );
      const maxLinks = overrides[0]?.maxLinks ?? DEFAULT_ENVIRONMENT_LINK_LIMIT;

      // Links already held for this environment are excluded so that
      // re-linking an environment the user already linked stays idempotent
      // even when the account is at its limit.
      const counted = yield* db
        .select({ activeLinks: count() })
        .from(relayEnvironmentLinks)
        .where(
          and(
            eq(relayEnvironmentLinks.userId, input.userId),
            ne(relayEnvironmentLinks.environmentId, input.environmentId),
            isNull(relayEnvironmentLinks.revokedAt),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new EnvironmentLinkLimitPersistenceError({
                operation: "count-links",
                userId: input.userId,
                cause,
              }),
          ),
        );
      const activeLinks = counted[0]?.activeLinks ?? 0;

      if (activeLinks >= maxLinks) {
        return yield* new EnvironmentLinkLimitExceeded({
          userId: input.userId,
          environmentId: input.environmentId,
          maxLinks,
          activeLinks,
        });
      }
    }),
  });
});

export const layer = Layer.effect(EnvironmentLinkLimits, make);
