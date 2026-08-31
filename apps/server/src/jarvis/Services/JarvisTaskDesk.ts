import {
  AuthSessionId,
  type JarvisPendingInteraction,
  type JarvisFocusTaskInput,
  type JarvisTaskDeskState,
  type JarvisTaskDeskTask,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

/** Direct current-state storage for one authenticated client session. */
export interface JarvisTaskDeskShape {
  readonly get: (
    sessionId: AuthSessionId,
  ) => Effect.Effect<JarvisTaskDeskState, ProjectionRepositoryError>;
  readonly focus: (input: {
    readonly sessionId: AuthSessionId;
    readonly task: JarvisTaskDeskTask | JarvisFocusTaskInput;
  }) => Effect.Effect<JarvisTaskDeskState, ProjectionRepositoryError>;
  readonly setPendingInteraction: (input: {
    readonly sessionId: AuthSessionId;
    readonly interaction: JarvisPendingInteraction;
  }) => Effect.Effect<JarvisTaskDeskState, ProjectionRepositoryError>;
  /** Atomically returns and clears the pending interaction. */
  readonly consumePendingInteraction: (
    sessionId: AuthSessionId,
  ) => Effect.Effect<JarvisPendingInteraction | null, ProjectionRepositoryError>;
  readonly clearPendingInteraction: (
    sessionId: AuthSessionId,
  ) => Effect.Effect<JarvisTaskDeskState, ProjectionRepositoryError>;
}

export class JarvisTaskDesk extends Context.Service<JarvisTaskDesk, JarvisTaskDeskShape>()(
  "t3/jarvis/Services/JarvisTaskDesk",
) {}
