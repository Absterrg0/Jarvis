import {
  AuthSessionId,
  type JarvisTaskDeskState,
  type JarvisTaskDeskTask,
  type JarvisTaskDeskNavigation,
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
  readonly navigate: (input: {
    readonly sessionId: AuthSessionId;
    readonly navigation: JarvisTaskDeskNavigation;
  }) => Effect.Effect<JarvisTaskDeskState, ProjectionRepositoryError>;
  readonly consumeNewConversation: (
    sessionId: AuthSessionId,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly observeLifecycle: (input: {
    readonly task: JarvisTaskDeskTask;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listTrackedThreadIds: () => Effect.Effect<
    ReadonlyArray<import("@t3tools/contracts").ThreadId>,
    ProjectionRepositoryError
  >;
}

export class JarvisTaskDesk extends Context.Service<JarvisTaskDesk, JarvisTaskDeskShape>()(
  "t3/jarvis/Services/JarvisTaskDesk",
) {}
