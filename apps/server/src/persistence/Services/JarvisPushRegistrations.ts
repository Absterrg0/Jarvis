import {
  EnvironmentId,
  JarvisPushDeviceId,
  JarvisPushToken,
  AuthSessionId,
  IsoDateTime,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

type PersistenceError = PersistenceSqlError | PersistenceDecodeError;

export const JarvisPushRegistration = Schema.Struct({
  token: JarvisPushToken,
  deviceId: JarvisPushDeviceId,
  sessionId: AuthSessionId,
  nodeId: EnvironmentId,
  updatedAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
export type JarvisPushRegistration = typeof JarvisPushRegistration.Type;

export class JarvisPushRegistrationRepository extends Context.Service<
  JarvisPushRegistrationRepository,
  {
    readonly register: (
      registration: JarvisPushRegistration,
    ) => Effect.Effect<void, PersistenceError>;
    readonly unregister: (input: {
      readonly token: JarvisPushToken;
      readonly deviceId: JarvisPushDeviceId;
      readonly sessionId: AuthSessionId;
    }) => Effect.Effect<boolean, PersistenceError>;
    readonly listByNode: (input: {
      readonly nodeId: EnvironmentId;
    }) => Effect.Effect<ReadonlyArray<JarvisPushRegistration>, PersistenceError>;
  }
>()("t3/persistence/Services/JarvisPushRegistrations/JarvisPushRegistrationRepository") {}
