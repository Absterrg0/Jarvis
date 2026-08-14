import type {
  AuthSessionId,
  JarvisVoiceReport,
  JarvisVoiceReportBatch,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface JarvisReportOutboxShape {
  readonly register: (sessionId: AuthSessionId) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly append: (input: {
    readonly sourceSequence: number;
    readonly report: JarvisVoiceReport;
    readonly requestId?: string;
  }) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly dismissAttention: (input: {
    readonly threadId: ThreadId;
    readonly requestId: string;
    readonly kind: "waiting-for-input" | "approval-needed";
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly advanceSourceSequence: (
    sourceSequence: number,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly latestSourceSequence: Effect.Effect<number, ProjectionRepositoryError>;
  readonly claimSpeech: (
    reportId: string,
    deviceId: string,
  ) => Effect.Effect<
    "claimed" | "leased" | "already-spoken" | "missing",
    ProjectionRepositoryError
  >;
  readonly confirmSpeech: (
    reportId: string,
    deviceId: string,
  ) => Effect.Effect<
    "confirmed" | "already-spoken" | "lease-lost" | "missing",
    ProjectionRepositoryError
  >;
  readonly acknowledge: (
    sessionId: AuthSessionId,
    throughSequence: number,
  ) => Effect.Effect<number, ProjectionRepositoryError>;
  readonly subscribe: (
    sessionId: AuthSessionId,
  ) => Stream.Stream<JarvisVoiceReportBatch, ProjectionRepositoryError>;
}

export class JarvisReportOutbox extends Context.Service<
  JarvisReportOutbox,
  JarvisReportOutboxShape
>()("t3/jarvis/Services/JarvisReportOutbox") {}
