import { AuthSessionId, JarvisVoiceReport, type ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  isPersistenceError,
  PersistenceDecodeError,
  PersistenceSqlError,
} from "../../persistence/Errors.ts";
import { JarvisReportOutbox } from "../Services/JarvisReportOutbox.ts";

const MAX_REPORTS = 512;
const BATCH_SIZE = 32;
const encodeReport = Schema.encodeEffect(Schema.fromJsonString(JarvisVoiceReport));
const decodeReport = Schema.decodeUnknownEffect(Schema.fromJsonString(JarvisVoiceReport));

const toPersistenceError = (operation: string, sessionId?: AuthSessionId) => (cause: unknown) =>
  isPersistenceError(cause)
    ? cause
    : Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(
          operation,
          cause,
          sessionId === undefined ? undefined : { sessionId },
        )
      : new PersistenceSqlError({
          operation,
          ...(sessionId === undefined ? {} : { correlation: { sessionId } }),
          cause,
        });

export const JarvisReportOutboxLive = Layer.effect(
  JarvisReportOutbox,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const notifications = yield* PubSub.unbounded<void>();

    const register = Effect.fn("JarvisReportOutbox.register")(function* (sessionId: AuthSessionId) {
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT OR IGNORE INTO jarvis_voice_report_cursors(
          session_id, acknowledged_sequence, updated_at
        ) VALUES (
          ${sessionId}, (SELECT COALESCE(MAX(sequence), 0) FROM jarvis_voice_reports), ${now}
        )
      `.pipe(Effect.mapError(toPersistenceError("JarvisReportOutbox.register", sessionId)));
    });

    const append = Effect.fn("JarvisReportOutbox.append")(function* (input: {
      readonly sourceSequence: number;
      readonly report: JarvisVoiceReport;
      readonly requestId?: string;
    }) {
      const reportJson = yield* encodeReport(input.report).pipe(
        Effect.mapError(toPersistenceError("JarvisReportOutbox.append:encode")),
      );
      const inserted = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const result = yield* sql<{ readonly changed: number }>`
              INSERT INTO jarvis_voice_reports(
                source_sequence, report_id, thread_id, kind, request_id, active, report_json,
                created_at
              ) VALUES (
                ${input.sourceSequence}, ${input.report.reportId}, ${input.report.threadId},
                ${input.report.kind}, ${input.requestId ?? null}, 1, ${reportJson},
                ${input.report.createdAt}
              )
              ON CONFLICT DO NOTHING RETURNING 1 AS changed
            `;
            yield* sql`
              DELETE FROM jarvis_voice_reports
              WHERE sequence NOT IN (
                SELECT sequence FROM jarvis_voice_reports
                ORDER BY sequence DESC LIMIT ${MAX_REPORTS}
              )
            `;
            return result.length > 0;
          }),
        )
        .pipe(Effect.mapError(toPersistenceError("JarvisReportOutbox.append:persist")));
      if (inserted) yield* PubSub.publish(notifications, undefined);
      return inserted;
    });

    const dismissAttention = Effect.fn("JarvisReportOutbox.dismissAttention")(function* (input: {
      readonly threadId: ThreadId;
      readonly requestId: string;
      readonly kind: "waiting-for-input" | "approval-needed";
    }) {
      yield* sql`
        UPDATE jarvis_voice_reports SET active = 0
        WHERE thread_id = ${input.threadId} AND request_id = ${input.requestId}
          AND kind = ${input.kind} AND active = 1
      `.pipe(Effect.mapError(toPersistenceError("JarvisReportOutbox.dismissAttention")));
      yield* PubSub.publish(notifications, undefined);
    });

    const advanceSourceSequence = Effect.fn("JarvisReportOutbox.advanceSourceSequence")(function* (
      sourceSequence: number,
    ) {
      yield* sql`
          UPDATE jarvis_voice_report_projection
          SET source_sequence = MAX(source_sequence, ${sourceSequence})
          WHERE singleton = 1
        `.pipe(Effect.mapError(toPersistenceError("JarvisReportOutbox.advanceSourceSequence")));
    });

    const latestSourceSequence = sql<{ readonly sourceSequence: number }>`
      SELECT source_sequence AS sourceSequence
      FROM jarvis_voice_report_projection WHERE singleton = 1
    `.pipe(
      Effect.map((rows) => rows[0]?.sourceSequence ?? 0),
      Effect.mapError(toPersistenceError("JarvisReportOutbox.latestSourceSequence")),
    );

    const claimSpeech = Effect.fn("JarvisReportOutbox.claimSpeech")(function* (
      reportId: string,
      deviceId: string,
    ) {
      const now = DateTime.formatIso(yield* DateTime.now);
      const expiresAt = DateTime.formatIso(
        DateTime.add(yield* DateTime.now, {
          milliseconds: Duration.toMillis(Duration.minutes(10)),
        }),
      );
      const claimed = yield* sql<{ readonly claimed: number }>`
        UPDATE jarvis_voice_reports
        SET speech_lease_device_id = ${deviceId}, speech_lease_expires_at = ${expiresAt}
        WHERE report_id = ${reportId} AND spoken_at IS NULL AND (
          speech_lease_device_id = ${deviceId} OR speech_lease_expires_at IS NULL
          OR speech_lease_expires_at <= ${now}
        )
        RETURNING 1 AS claimed
      `.pipe(Effect.mapError(toPersistenceError("JarvisReportOutbox.claimSpeech")));
      if (claimed.length > 0) return "claimed" as const;
      const existing = yield* sql<{ readonly spokenAt: string | null }>`
        SELECT spoken_at AS spokenAt FROM jarvis_voice_reports WHERE report_id = ${reportId} LIMIT 1
      `.pipe(Effect.mapError(toPersistenceError("JarvisReportOutbox.claimSpeech:lookup")));
      if (existing.length === 0) return "missing" as const;
      return existing[0]?.spokenAt === null ? ("leased" as const) : ("already-spoken" as const);
    });

    const confirmSpeech = Effect.fn("JarvisReportOutbox.confirmSpeech")(function* (
      reportId: string,
      deviceId: string,
    ) {
      const now = DateTime.formatIso(yield* DateTime.now);
      const confirmed = yield* sql<{ readonly confirmed: number }>`
        UPDATE jarvis_voice_reports SET spoken_at = ${now}
        WHERE report_id = ${reportId} AND spoken_at IS NULL
          AND speech_lease_device_id = ${deviceId}
        RETURNING 1 AS confirmed
      `.pipe(Effect.mapError(toPersistenceError("JarvisReportOutbox.confirmSpeech")));
      if (confirmed.length > 0) return "confirmed" as const;
      const existing = yield* sql<{
        readonly leaseDeviceId: string | null;
        readonly spokenAt: string | null;
      }>`
        SELECT speech_lease_device_id AS leaseDeviceId, spoken_at AS spokenAt
        FROM jarvis_voice_reports WHERE report_id = ${reportId} LIMIT 1
      `.pipe(Effect.mapError(toPersistenceError("JarvisReportOutbox.confirmSpeech:lookup")));
      if (existing.length === 0) return "missing" as const;
      if (existing[0]?.spokenAt !== null) return "already-spoken" as const;
      return "lease-lost" as const;
    });

    const acknowledge = Effect.fn("JarvisReportOutbox.acknowledge")(function* (
      sessionId: AuthSessionId,
      throughSequence: number,
    ) {
      yield* register(sessionId);
      const now = DateTime.formatIso(yield* DateTime.now);
      const rows = yield* sql<{ readonly acknowledgedThrough: number }>`
        UPDATE jarvis_voice_report_cursors
        SET acknowledged_sequence = MIN(
          MAX(acknowledged_sequence, ${throughSequence}),
          (SELECT COALESCE(MAX(sequence), 0) FROM jarvis_voice_reports)
        ), updated_at = ${now}
        WHERE session_id = ${sessionId}
        RETURNING acknowledged_sequence AS acknowledgedThrough
      `.pipe(Effect.mapError(toPersistenceError("JarvisReportOutbox.acknowledge", sessionId)));
      yield* PubSub.publish(notifications, undefined);
      return rows[0]?.acknowledgedThrough ?? 0;
    });

    const loadBatch = Effect.fn("JarvisReportOutbox.loadBatch")(function* (
      sessionId: AuthSessionId,
    ) {
      const cursorRows = yield* sql<{ readonly acknowledgedThrough: number }>`
        SELECT acknowledged_sequence AS acknowledgedThrough
        FROM jarvis_voice_report_cursors WHERE session_id = ${sessionId}
      `.pipe(Effect.mapError(toPersistenceError("JarvisReportOutbox.loadBatch:cursor", sessionId)));
      const acknowledgedThrough = cursorRows[0]?.acknowledgedThrough ?? 0;
      const rows = yield* sql<{
        readonly sequence: number;
        readonly active: number;
        readonly reportJson: string;
      }>`
        SELECT sequence, active, report_json AS reportJson FROM jarvis_voice_reports
        WHERE sequence > ${acknowledgedThrough}
        ORDER BY sequence ASC LIMIT ${BATCH_SIZE}
      `.pipe(
        Effect.mapError(toPersistenceError("JarvisReportOutbox.loadBatch:reports", sessionId)),
      );
      if (rows.length === 0) return null;
      const deliveries = [];
      for (const row of rows) {
        if (row.active !== 1) continue;
        const report = yield* decodeReport(row.reportJson).pipe(
          Effect.mapError(toPersistenceError("JarvisReportOutbox.loadBatch:decode", sessionId)),
        );
        deliveries.push({ sequence: row.sequence, report });
      }
      const batchThrough = rows.at(-1)?.sequence ?? acknowledgedThrough;
      const remaining = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM jarvis_voice_reports WHERE sequence > ${batchThrough}
      `.pipe(
        Effect.mapError(toPersistenceError("JarvisReportOutbox.loadBatch:remaining", sessionId)),
      );
      const floor = yield* sql<{ readonly sequence: number }>`
        SELECT MIN(sequence) AS sequence FROM jarvis_voice_reports
      `.pipe(Effect.mapError(toPersistenceError("JarvisReportOutbox.loadBatch:floor", sessionId)));
      const firstRetained = floor[0]?.sequence;
      return {
        acknowledgedThrough,
        batchThrough,
        deliveries,
        hasMore: (remaining[0]?.count ?? 0) > 0,
        ...(firstRetained !== undefined && acknowledgedThrough + 1 < firstRetained
          ? { truncatedBefore: firstRetained }
          : {}),
      };
    });

    const subscribe = (sessionId: AuthSessionId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* register(sessionId);
          const wakeups = yield* PubSub.subscribe(notifications);
          return Stream.concat(Stream.make(undefined), Stream.fromSubscription(wakeups)).pipe(
            Stream.mapEffect(() => loadBatch(sessionId)),
            Stream.filter((batch) => batch !== null),
            Stream.changesWith(
              (left, right) =>
                left.batchThrough === right.batchThrough &&
                left.deliveries.length === right.deliveries.length &&
                left.deliveries.every(
                  (delivery, index) => delivery.sequence === right.deliveries[index]?.sequence,
                ),
            ),
          );
        }),
      );

    return JarvisReportOutbox.of({
      register,
      append,
      dismissAttention,
      advanceSourceSequence,
      latestSourceSequence,
      claimSpeech,
      confirmSpeech,
      acknowledge,
      subscribe,
    });
  }),
);
