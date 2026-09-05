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
    readonly preservePendingInteraction?: boolean;
  }) => Effect.Effect<JarvisTaskDeskState, ProjectionRepositoryError>;
  readonly setPendingInteraction: (input: {
    readonly sessionId: AuthSessionId;
    readonly interaction: JarvisPendingInteraction;
  }) => Effect.Effect<JarvisTaskDeskState, ProjectionRepositoryError>;
  /**
   * Atomically returns and clears the pending interaction only when it is
   * still the exact frame the answer was read from. A replaced or already
   * consumed frame yields null without touching the current frame.
   */
  readonly consumePendingInteraction: (input: {
    readonly sessionId: AuthSessionId;
    readonly expectedFrameId?: string;
    /** Focus the validated task in the same transaction as consuming its answer. */
    readonly focusTask?: JarvisTaskDeskTask;
  }) => Effect.Effect<JarvisPendingInteraction | null, ProjectionRepositoryError>;
  readonly clearPendingInteraction: (input: {
    readonly sessionId: AuthSessionId;
    readonly expectedFrameId?: string;
  }) => Effect.Effect<JarvisTaskDeskState, ProjectionRepositoryError>;
}

export class JarvisTaskDesk extends Context.Service<JarvisTaskDesk, JarvisTaskDeskShape>()(
  "t3/jarvis/Services/JarvisTaskDesk",
) {}
