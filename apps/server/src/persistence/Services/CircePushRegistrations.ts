import {
  EnvironmentId,
  CircePushDeviceId,
  CircePushToken,
  AuthSessionId,
  IsoDateTime,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

type PersistenceError = PersistenceSqlError | PersistenceDecodeError;

export const CircePushRegistration = Schema.Struct({
  token: CircePushToken,
  deviceId: CircePushDeviceId,
  sessionId: AuthSessionId,
  nodeId: EnvironmentId,
  updatedAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
export type CircePushRegistration = typeof CircePushRegistration.Type;

export class CircePushRegistrationRepository extends Context.Service<
  CircePushRegistrationRepository,
  {
    readonly register: (
      registration: CircePushRegistration,
    ) => Effect.Effect<void, PersistenceError>;
    readonly unregister: (input: {
      readonly token: CircePushToken;
      readonly deviceId: CircePushDeviceId;
      readonly sessionId: AuthSessionId;
    }) => Effect.Effect<boolean, PersistenceError>;
    /**
     * Delete only the exact registration version seen before a send.
     * A same-token renewal (same triple, newer updatedAt/expiresAt)
     * must survive a stale DeviceNotRegistered invalidation.
     */
    readonly unregisterIfUnchanged: (input: {
      readonly token: CircePushToken;
      readonly deviceId: CircePushDeviceId;
      readonly sessionId: AuthSessionId;
      readonly updatedAt: IsoDateTime;
      readonly expiresAt: IsoDateTime;
    }) => Effect.Effect<boolean, PersistenceError>;
    readonly listByNode: (input: {
      readonly nodeId: EnvironmentId;
    }) => Effect.Effect<ReadonlyArray<CircePushRegistration>, PersistenceError>;
  }
>()(
  "@absterrg0/circe/persistence/Services/CircePushRegistrations/CircePushRegistrationRepository",
) {}
