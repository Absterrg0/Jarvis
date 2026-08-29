import type {
  AuthSessionId,
  MessageId,
  JarvisVoiceReport,
  JarvisVoiceReportBatch,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface JarvisReportOutboxShape {
  /**
   * Register the durable inbox cursor. The optional origin identity is stable
   * across auth-session recreation; sessionId remains the legacy fallback.
   */
  readonly register: (
    sessionId: AuthSessionId,
    originInteractionId?: string,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly append: (input: {
    readonly sourceSequence: number;
    readonly report: JarvisVoiceReport;
    readonly requestId?: string;
  }) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly stageWorkStartedCandidate: (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly assistantMessageId: MessageId;
    readonly sourceSequence: number;
    readonly report: JarvisVoiceReport;
  }) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly promoteWorkStartedCandidate: (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly sourceSequence: number;
  }) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly dismissWorkStartedCandidate: (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
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
  readonly releaseSpeech: (
    reportId: string,
    deviceId: string,
  ) => Effect.Effect<
    "released" | "already-spoken" | "lease-lost" | "missing",
    ProjectionRepositoryError
  >;
  readonly acknowledge: (
    sessionId: AuthSessionId,
    throughSequence: number,
    originInteractionId?: string,
  ) => Effect.Effect<number, ProjectionRepositoryError>;
  readonly subscribe: (
    sessionId: AuthSessionId,
    originInteractionId?: string,
    protocolVersion?: 1 | 2,
  ) => Stream.Stream<JarvisVoiceReportBatch, ProjectionRepositoryError>;
}

export class JarvisReportOutbox extends Context.Service<
  JarvisReportOutbox,
  JarvisReportOutboxShape
>()("t3/jarvis/Services/JarvisReportOutbox") {}
