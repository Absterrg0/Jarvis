import type { JarvisRequestMetadata, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface JarvisFollowUpQueueItem {
  readonly queueId: string;
  readonly threadId: ThreadId;
  readonly instruction: string;
  readonly requestMetadata?: JarvisRequestMetadata;
  readonly position: number;
}

export type JarvisFollowUpQueueStatus = "pending" | "running" | "dispatched" | "cancelled";

export interface JarvisFollowUpQueueShape {
  readonly enqueue: (input: {
    readonly queueId: string;
    readonly threadId: ThreadId;
    readonly instruction: string;
    readonly requestMetadata?: JarvisRequestMetadata;
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
  /**
   * Read one row's status so the dispatcher can re-check ownership after
   * claiming: a stop between claim and dispatch must win over the dispatch.
   */
  readonly statusOf: (
    queueId: string,
  ) => Effect.Effect<Option.Option<JarvisFollowUpQueueStatus>, ProjectionRepositoryError>;
  readonly cancelPending: (
    threadId: ThreadId,
    cancelledAt: string,
  ) => Effect.Effect<number, ProjectionRepositoryError>;
  /**
   * Threads with pending rows in FIFO order. Readiness is decided per thread
   * by the dispatcher through the derived task state, so recovery never drops
   * a thread whose session row alone looks unready.
   */
  readonly listPendingThreadIds: () => Effect.Effect<
    ReadonlyArray<ThreadId>,
    ProjectionRepositoryError
  >;
  readonly pendingCount: (threadId: ThreadId) => Effect.Effect<number, ProjectionRepositoryError>;
}

export class JarvisFollowUpQueue extends Context.Service<
  JarvisFollowUpQueue,
  JarvisFollowUpQueueShape
>()("t3/jarvis/Services/JarvisFollowUpQueue") {}
