import {
  AuthSessionId,
  type CircePendingInteraction,
  type CirceFocusTaskInput,
  type CirceTaskDeskState,
  type CirceTaskDeskTask,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

/** Direct current-state storage for one authenticated client session. */
export interface CirceTaskDeskShape {
  readonly get: (
    sessionId: AuthSessionId,
  ) => Effect.Effect<CirceTaskDeskState, ProjectionRepositoryError>;
  readonly focus: (input: {
    readonly sessionId: AuthSessionId;
    readonly task: CirceTaskDeskTask | CirceFocusTaskInput;
    readonly preservePendingInteraction?: boolean;
  }) => Effect.Effect<CirceTaskDeskState, ProjectionRepositoryError>;
  readonly setPendingInteraction: (input: {
    readonly sessionId: AuthSessionId;
    readonly interaction: CircePendingInteraction;
  }) => Effect.Effect<CirceTaskDeskState, ProjectionRepositoryError>;
  /**
   * Atomically returns and clears the pending interaction only when it is
   * still the exact frame the answer was read from. A replaced or already
   * consumed frame yields null without touching the current frame.
   */
  readonly consumePendingInteraction: (input: {
    readonly sessionId: AuthSessionId;
    readonly expectedFrameId?: string;
    /** Focus the validated task in the same transaction as consuming its answer. */
    readonly focusTask?: CirceTaskDeskTask;
  }) => Effect.Effect<CircePendingInteraction | null, ProjectionRepositoryError>;
  readonly clearPendingInteraction: (input: {
    readonly sessionId: AuthSessionId;
    readonly expectedFrameId?: string;
  }) => Effect.Effect<CirceTaskDeskState, ProjectionRepositoryError>;
}

export class CirceTaskDesk extends Context.Service<CirceTaskDesk, CirceTaskDeskShape>()(
  "t3/circe/Services/CirceTaskDesk",
) {}
