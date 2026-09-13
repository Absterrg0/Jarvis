import type { CirceRequestMetadata, MessageId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface CirceFollowUpQueueItem {
  readonly queueId: string;
  readonly threadId: ThreadId;
  readonly instruction: string;
  readonly requestMetadata?: CirceRequestMetadata;
  readonly position: number;
  readonly enqueuedAt: string;
}

export type CirceFollowUpQueueStatus = "pending" | "running" | "dispatched" | "cancelled";

export interface CirceFollowUpQueueShape {
  readonly enqueue: (input: {
    readonly queueId: string;
    readonly threadId: ThreadId;
    readonly instruction: string;
    readonly requestMetadata?: CirceRequestMetadata;
    readonly enqueuedAt: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly claimNext: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<CirceFollowUpQueueItem>, ProjectionRepositoryError>;
  readonly reconcileAccepted: (
    threadId: ThreadId,
    messageIds: ReadonlyArray<MessageId>,
    updatedAt: string,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
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
   * Inspect a claimed row before dispatch. Dispatch and stop ordering is owned
   * by CirceFollowUpDispatcher; a status read alone does not confer ownership.
   */
  readonly statusOf: (
    queueId: string,
  ) => Effect.Effect<Option.Option<CirceFollowUpQueueStatus>, ProjectionRepositoryError>;
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

export class CirceFollowUpQueue extends Context.Service<
  CirceFollowUpQueue,
  CirceFollowUpQueueShape
>()("@absterrg0/circe/circe/Services/CirceFollowUpQueue") {}
