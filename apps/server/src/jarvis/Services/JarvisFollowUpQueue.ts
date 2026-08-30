import type { EnvironmentId, ModelSelection, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface JarvisFollowUpQueueItem {
  readonly queueId: string;
  readonly dispatchIdentity: string;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly executionNodeId?: EnvironmentId | undefined;
  readonly providerId?: string | undefined;
  readonly instruction: string;
  readonly position: number;
}

export interface JarvisFollowUpQueueShape {
  readonly enqueue: (input: {
    readonly queueId: string;
    readonly dispatchIdentity: string;
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly executionNodeId?: EnvironmentId | undefined;
    readonly modelSelection?: ModelSelection | undefined;
    readonly instruction: string;
    readonly enqueuedAt: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly claimNext: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<JarvisFollowUpQueueItem>, ProjectionRepositoryError>;
  readonly markDispatched: (
    queueId: string,
    dispatchedAt: string,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly release: (
    queueId: string,
    updatedAt: string,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly resetRunning: (updatedAt: string) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listReadyThreadIds: () => Effect.Effect<
    ReadonlyArray<ThreadId>,
    ProjectionRepositoryError
  >;
  readonly pendingCount: (threadId: ThreadId) => Effect.Effect<number, ProjectionRepositoryError>;
}

export class JarvisFollowUpQueue extends Context.Service<
  JarvisFollowUpQueue,
  JarvisFollowUpQueueShape
>()("t3/jarvis/Services/JarvisFollowUpQueue") {}
