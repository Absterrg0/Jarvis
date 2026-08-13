import {
  AuthSessionId,
  type JarvisTaskDeskState,
  type JarvisTaskDeskTask,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface JarvisTaskDeskShape {
  readonly get: (
    sessionId: AuthSessionId,
  ) => Effect.Effect<JarvisTaskDeskState, ProjectionRepositoryError>;
  readonly focus: (input: {
    readonly sessionId: AuthSessionId;
    readonly task: JarvisTaskDeskTask;
  }) => Effect.Effect<JarvisTaskDeskState, ProjectionRepositoryError>;
}

export class JarvisTaskDesk extends Context.Service<JarvisTaskDesk, JarvisTaskDeskShape>()(
  "t3/jarvis/Services/JarvisTaskDesk",
) {}
