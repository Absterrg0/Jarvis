import { EnvironmentId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

type PersistenceError = PersistenceSqlError | PersistenceDecodeError;

/**
 * One durable lease for a local-key live voice session. Only local-key
 * sessions are stored: cloud sessions are owned by the relay reservation,
 * which is already durable and swept server-side.
 */
export const CirceLiveVoiceSessionLease = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  /** Epoch milliseconds. */
  createdAt: Schema.Int,
  /** Absolute server-side ceiling, epoch milliseconds. */
  deadlineAt: Schema.Int,
});
export type CirceLiveVoiceSessionLease = typeof CirceLiveVoiceSessionLease.Type;

export class CirceLiveVoiceSessionRepository extends Context.Service<
  CirceLiveVoiceSessionRepository,
  {
    readonly list: () => Effect.Effect<ReadonlyArray<CirceLiveVoiceSessionLease>, PersistenceError>;
    readonly put: (lease: CirceLiveVoiceSessionLease) => Effect.Effect<void, PersistenceError>;
    /**
     * Removes the durable lease only after confirmed upstream closure. Callers
     * keep the row on a failed close so a later sweep can retry it.
     */
    readonly remove: (input: {
      readonly sessionId: string;
    }) => Effect.Effect<boolean, PersistenceError>;
  }
>()(
  "@absterrg0/circe/persistence/Services/CirceLiveVoiceSessions/CirceLiveVoiceSessionRepository",
) {}
