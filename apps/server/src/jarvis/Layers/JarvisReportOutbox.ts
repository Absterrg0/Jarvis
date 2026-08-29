import {
  AuthSessionId,
  JarvisVoiceReport,
  MessageId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
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

/** Session cookies are replaceable; this key keeps a Companion inbox cursor. */
const cursorKey = (sessionId: AuthSessionId, originInteractionId?: string): string =>
  originInteractionId === undefined
    ? sessionId
    : `jarvis-origin:${encodeURIComponent(originInteractionId)}`;

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
    const notifications = yield* PubSub.unbounded<"reports" | "speech-state">();
    const retain = Effect.fn("JarvisReportOutbox.retainBoundedState")(function* () {
      yield* sql`DELETE FROM jarvis_voice_reports WHERE sequence NOT IN (SELECT sequence FROM jarvis_voice_reports ORDER BY sequence DESC LIMIT ${MAX_REPORTS})`;
      yield* sql`DELETE FROM jarvis_voice_report_changes WHERE sequence NOT IN (SELECT sequence FROM jarvis_voice_report_changes ORDER BY sequence DESC LIMIT ${MAX_REPORTS})`;
      yield* sql`DELETE FROM jarvis_voice_work_started_candidates WHERE phase = 'dismissed' AND rowid NOT IN (SELECT rowid FROM jarvis_voice_work_started_candidates WHERE phase = 'dismissed' ORDER BY updated_at DESC, rowid DESC LIMIT ${MAX_REPORTS})`;
    });

    const register = Effect.fn("JarvisReportOutbox.register")(function* (
      sessionId: AuthSessionId,
      originInteractionId?: string,
    ) {
      const now = DateTime.formatIso(yield* DateTime.now);
      const key = cursorKey(sessionId, originInteractionId);
      yield* sql`
        INSERT OR IGNORE INTO jarvis_voice_report_cursors(
          session_id, acknowledged_sequence, updated_at
        ) VALUES (
          ${key}, (SELECT COALESCE(MAX(sequence), 0) FROM jarvis_voice_report_changes), ${now}
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
                source_sequence, report_id, thread_id, turn_id, kind, request_id, active,
                report_json, created_at
              ) VALUES (
                ${input.sourceSequence}, ${input.report.reportId}, ${input.report.threadId},
                ${input.report.turnId ?? null}, ${input.report.kind}, ${input.requestId ?? null},
                1, ${reportJson}, ${input.report.createdAt}
              )
              ON CONFLICT DO NOTHING RETURNING 1 AS changed
            `;
            if (result.length > 0) {
              yield* sql`
                INSERT INTO jarvis_voice_report_changes(report_id, change_kind, report_json, created_at)
                VALUES (${input.report.reportId}, 'upsert', ${reportJson}, ${input.report.createdAt})
              `;
            }
            yield* retain();
            return result.length > 0;
          }),
        )
        .pipe(Effect.mapError(toPersistenceError("JarvisReportOutbox.append:persist")));
      if (inserted) yield* PubSub.publish(notifications, "reports");
      return inserted;
    });

    const stageWorkStartedCandidate = Effect.fn("JarvisReportOutbox.stageWorkStartedCandidate")(
      function* (input: {
        readonly threadId: ThreadId;
        readonly turnId: TurnId;
        readonly assistantMessageId: MessageId;
        readonly sourceSequence: number;
        readonly report: JarvisVoiceReport;
      }) {
        const reportJson = yield* encodeReport(input.report).pipe(
          Effect.mapError(
            toPersistenceError("JarvisReportOutbox.stageWorkStartedCandidate:encode"),
          ),
        );
        const now = DateTime.formatIso(yield* DateTime.now);
        const inserted = yield* sql`
          INSERT OR IGNORE INTO jarvis_voice_work_started_candidates(
            thread_id, turn_id, assistant_message_id, source_sequence, report_json, created_at, updated_at
          ) VALUES (
            ${input.threadId}, ${input.turnId}, ${input.assistantMessageId},
            ${input.sourceSequence}, ${reportJson}, ${input.report.createdAt}, ${now}
          )
          RETURNING 1 AS inserted
        `.pipe(Effect.mapError(toPersistenceError("JarvisReportOutbox.stageWorkStartedCandidate")));
        return inserted.length > 0;
      },
    );

    const promoteWorkStartedCandidate = Effect.fn("JarvisReportOutbox.promoteWorkStartedCandidate")(
      function* (input: {
        readonly threadId: ThreadId;
        readonly turnId: TurnId;
        readonly sourceSequence: number;
      }) {
        const promoted = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const candidates = yield* sql<{
                readonly assistantMessageId: string;
                readonly reportJson: string;
              }>`
            SELECT assistant_message_id AS assistantMessageId, report_json AS reportJson
            FROM jarvis_voice_work_started_candidates
            WHERE thread_id = ${input.threadId} AND turn_id = ${input.turnId}
              AND phase = 'staged' AND source_sequence < ${input.sourceSequence}
            LIMIT 1
          `.pipe(
                Effect.mapError(
                  toPersistenceError("JarvisReportOutbox.promoteWorkStartedCandidate:lookup"),
                ),
              );
              const candidate = candidates[0];
              if (candidate === undefined) return false;
              const now = DateTime.formatIso(yield* DateTime.now);
              const report = yield* decodeReport(candidate.reportJson).pipe(
                Effect.mapError(
                  toPersistenceError("JarvisReportOutbox.promoteWorkStartedCandidate:decode"),
                ),
              );
              const inserted = yield* sql`
            INSERT INTO jarvis_voice_reports(
              source_sequence, report_id, thread_id, turn_id, kind, request_id, active,
              report_json, created_at
            ) VALUES (
              ${input.sourceSequence}, ${report.reportId}, ${report.threadId}, ${report.turnId ?? null},
              ${report.kind}, NULL, 1, ${candidate.reportJson}, ${report.createdAt}
            ) ON CONFLICT DO NOTHING RETURNING 1 AS inserted
          `.pipe(
                Effect.mapError(
                  toPersistenceError("JarvisReportOutbox.promoteWorkStartedCandidate:insert"),
                ),
              );
              yield* sql`
            UPDATE jarvis_voice_work_started_candidates SET phase = 'promoted', report_id = ${report.reportId}, updated_at = ${now}
            WHERE thread_id = ${input.threadId} AND turn_id = ${input.turnId} AND phase = 'staged'
          `.pipe(
                Effect.mapError(
                  toPersistenceError("JarvisReportOutbox.promoteWorkStartedCandidate:mark"),
                ),
              );
              if (inserted.length > 0) {
                yield* sql`
              INSERT INTO jarvis_voice_report_changes(report_id, change_kind, report_json, created_at)
              VALUES (${report.reportId}, 'upsert', ${candidate.reportJson}, ${report.createdAt})
            `;
              }
              yield* retain();
              return inserted.length > 0;
            }),
          )
          .pipe(
            Effect.mapError(toPersistenceError("JarvisReportOutbox.promoteWorkStartedCandidate")),
          );
        if (promoted) yield* PubSub.publish(notifications, "reports");
        return promoted;
      },
    );

    const dismissWorkStartedCandidate = Effect.fn("JarvisReportOutbox.dismissWorkStartedCandidate")(
      function* (input: { readonly threadId: ThreadId; readonly turnId: TurnId }) {
        const dismissed = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const now = DateTime.formatIso(yield* DateTime.now);
              const candidateRows = yield* sql<{
                readonly phase: string;
                readonly reportId: string | null;
              }>`
            SELECT phase, report_id AS reportId FROM jarvis_voice_work_started_candidates
            WHERE thread_id = ${input.threadId} AND turn_id = ${input.turnId}
          `;
              const candidate = candidateRows[0];
              if (candidate === undefined) {
                yield* sql`
              INSERT INTO jarvis_voice_work_started_candidates(thread_id, turn_id, phase, updated_at)
              VALUES (${input.threadId}, ${input.turnId}, 'dismissed', ${now})
            `.pipe(
                  Effect.mapError(
                    toPersistenceError("JarvisReportOutbox.dismissWorkStartedCandidate:tombstone"),
                  ),
                );
              }
              yield* sql`
          UPDATE jarvis_voice_work_started_candidates SET phase = 'dismissed', updated_at = ${now}
          WHERE thread_id = ${input.threadId} AND turn_id = ${input.turnId}
            AND phase IN ('staged', 'promoted', 'dismissed')
          `.pipe(
                Effect.mapError(
                  toPersistenceError("JarvisReportOutbox.dismissWorkStartedCandidate:candidate"),
                ),
              );
              const reportRows = yield* sql<{ readonly reportId: string }>`
            UPDATE jarvis_voice_reports
            SET active = 0, speech_lease_device_id = NULL, speech_lease_expires_at = NULL
            WHERE thread_id = ${input.threadId} AND turn_id = ${input.turnId}
              AND kind = 'work-started' AND active = 1
            RETURNING report_id AS reportId
          `;
              const reportId =
                reportRows[0]?.reportId ??
                (candidate?.phase === "promoted" ? candidate.reportId : null);
              if (reportId !== null && reportId !== undefined) {
                yield* sql`
              INSERT INTO jarvis_voice_report_changes(report_id, change_kind, report_json, created_at)
                VALUES (${reportId}, 'remove', NULL, ${DateTime.formatIso(yield* DateTime.now)})
            `.pipe(
                  Effect.mapError(
                    toPersistenceError("JarvisReportOutbox.dismissWorkStartedCandidate:change"),
                  ),
                );
              }
              yield* retain();
              return reportId !== null && reportId !== undefined;
            }),
          )
          .pipe(
            Effect.mapError(toPersistenceError("JarvisReportOutbox.dismissWorkStartedCandidate")),
          );
        if (dismissed) yield* PubSub.publish(notifications, "reports");
      },
    );

    const dismissAttention = Effect.fn("JarvisReportOutbox.dismissAttention")(function* (input: {
      readonly threadId: ThreadId;
      readonly requestId: string;
      readonly kind: "waiting-for-input" | "approval-needed";
    }) {
      const rows = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{ readonly reportId: string }>`
          UPDATE jarvis_voice_reports SET active = 0
          WHERE thread_id = ${input.threadId} AND request_id = ${input.requestId}
            AND kind = ${input.kind} AND active = 1
          RETURNING report_id AS reportId
        `;
            for (const row of rows) {
              yield* sql`
            INSERT INTO jarvis_voice_report_changes(report_id, change_kind, report_json, created_at)
            VALUES (${row.reportId}, 'remove', NULL, ${DateTime.formatIso(yield* DateTime.now)})
          `;
            }
            yield* retain();
            return rows;
          }),
        )
        .pipe(Effect.mapError(toPersistenceError("JarvisReportOutbox.dismissAttention")));
      if (rows.length > 0) yield* PubSub.publish(notifications, "reports");
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
        WHERE report_id = ${reportId} AND active = 1 AND spoken_at IS NULL AND (
          speech_lease_device_id = ${deviceId} OR speech_lease_expires_at IS NULL
          OR speech_lease_expires_at <= ${now}
        )
        RETURNING 1 AS claimed
      `.pipe(Effect.mapError(toPersistenceError("JarvisReportOutbox.claimSpeech")));
      if (claimed.length > 0) return "claimed" as const;
      const existing = yield* sql<{ readonly spokenAt: string | null; readonly active: number }>`
        SELECT spoken_at AS spokenAt, active FROM jarvis_voice_reports WHERE report_id = ${reportId} LIMIT 1
      `.pipe(Effect.mapError(toPersistenceError("JarvisReportOutbox.claimSpeech:lookup")));
      if (existing.length === 0) return "missing" as const;
      if (existing[0]?.active !== 1) return "missing" as const;
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
      if (confirmed.length === 0) {
        const existing = yield* sql<{
          readonly spokenAt: string | null;
        }>`
          SELECT spoken_at AS spokenAt
          FROM jarvis_voice_reports WHERE report_id = ${reportId} LIMIT 1
        `.pipe(Effect.mapError(toPersistenceError("JarvisReportOutbox.confirmSpeech:lookup")));
        if (existing.length === 0) return "missing" as const;
        if (existing[0]?.spokenAt !== null) return "already-spoken" as const;
        return "lease-lost" as const;
      }
      yield* PubSub.publish(notifications, "speech-state");
      return "confirmed" as const;
    });

    const releaseSpeech = Effect.fn("JarvisReportOutbox.releaseSpeech")(function* (
      reportId: string,
      deviceId: string,
    ) {
      const released = yield* sql<{ readonly released: number }>`
        UPDATE jarvis_voice_reports
        SET speech_lease_device_id = NULL, speech_lease_expires_at = NULL
        WHERE report_id = ${reportId} AND spoken_at IS NULL
          AND speech_lease_device_id = ${deviceId}
        RETURNING 1 AS released
      `.pipe(Effect.mapError(toPersistenceError("JarvisReportOutbox.releaseSpeech")));
      if (released.length > 0) {
        yield* PubSub.publish(notifications, "speech-state");
        return "released" as const;
      }
      const existing = yield* sql<{
        readonly spokenAt: string | null;
      }>`
        SELECT spoken_at AS spokenAt
        FROM jarvis_voice_reports WHERE report_id = ${reportId} LIMIT 1
      `.pipe(Effect.mapError(toPersistenceError("JarvisReportOutbox.releaseSpeech:lookup")));
      if (existing.length === 0) return "missing" as const;
      if (existing[0]?.spokenAt !== null) return "already-spoken" as const;
      // A different owner, or an expired/cleared lease, cannot be released by
      // this device. Keep the durable ownership decision authoritative.
      return "lease-lost" as const;
    });

    const acknowledge = Effect.fn("JarvisReportOutbox.acknowledge")(function* (
      sessionId: AuthSessionId,
      throughSequence: number,
      originInteractionId?: string,
    ) {
      const key = cursorKey(sessionId, originInteractionId);
      yield* register(sessionId, originInteractionId);
      const now = DateTime.formatIso(yield* DateTime.now);
      const rows = yield* sql<{ readonly acknowledgedThrough: number }>`
        UPDATE jarvis_voice_report_cursors
        SET acknowledged_sequence = MIN(
          MAX(acknowledged_sequence, ${throughSequence}),
          (SELECT COALESCE(MAX(sequence), 0) FROM jarvis_voice_report_changes)
        ), updated_at = ${now}
        WHERE session_id = ${key}
        RETURNING acknowledged_sequence AS acknowledgedThrough
      `.pipe(Effect.mapError(toPersistenceError("JarvisReportOutbox.acknowledge", sessionId)));
      yield* PubSub.publish(notifications, "reports");
      return rows[0]?.acknowledgedThrough ?? 0;
    });

    const loadBatch = Effect.fn("JarvisReportOutbox.loadBatch")(function* (
      sessionId: AuthSessionId,
      originInteractionId?: string,
      protocolVersion: 1 | 2 = 1,
    ) {
      const key = cursorKey(sessionId, originInteractionId);
      const cursorRows = yield* sql<{ readonly acknowledgedThrough: number }>`
        SELECT acknowledged_sequence AS acknowledgedThrough
        FROM jarvis_voice_report_cursors WHERE session_id = ${key}
      `.pipe(Effect.mapError(toPersistenceError("JarvisReportOutbox.loadBatch:cursor", sessionId)));
      const acknowledgedThrough = cursorRows[0]?.acknowledgedThrough ?? 0;
      const rows = yield* sql<{
        readonly sequence: number;
        readonly changeKind: "upsert" | "remove";
        readonly reportId: string;
        readonly reportJson: string;
        readonly active: number | null;
        readonly kind: string | null;
      }>`
        SELECT c.sequence, c.change_kind AS changeKind, c.report_id AS reportId,
          c.report_json AS reportJson, r.active, r.kind
        FROM jarvis_voice_report_changes c
        LEFT JOIN jarvis_voice_reports r ON r.report_id = c.report_id
        WHERE c.sequence > ${acknowledgedThrough}
        ORDER BY c.sequence ASC LIMIT ${BATCH_SIZE}
      `.pipe(
        Effect.mapError(toPersistenceError("JarvisReportOutbox.loadBatch:changes", sessionId)),
      );
      if (rows.length === 0) return null;
      const deliveries = [];
      const removedReportIds: string[] = [];
      for (const row of rows) {
        if (row.changeKind === "remove") {
          if (protocolVersion === 2) removedReportIds.push(row.reportId);
          continue;
        }
        if (row.active !== 1 || (protocolVersion === 1 && row.kind === "work-started")) continue;
        const report = yield* decodeReport(row.reportJson).pipe(
          Effect.mapError(toPersistenceError("JarvisReportOutbox.loadBatch:decode", sessionId)),
        );
        deliveries.push({ sequence: row.sequence, report });
      }
      const batchThrough = rows.at(-1)?.sequence ?? acknowledgedThrough;
      const remaining = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM jarvis_voice_report_changes WHERE sequence > ${batchThrough}
      `.pipe(
        Effect.mapError(toPersistenceError("JarvisReportOutbox.loadBatch:remaining", sessionId)),
      );
      const floor = yield* sql<{ readonly sequence: number }>`
        SELECT MIN(sequence) AS sequence FROM jarvis_voice_report_changes
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
        ...(protocolVersion === 2 ? { removedReportIds } : {}),
      };
    });

    const subscribe = (
      sessionId: AuthSessionId,
      originInteractionId?: string,
      protocolVersion: 1 | 2 = 1,
    ) =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* register(sessionId, originInteractionId);
          const wakeups = yield* PubSub.subscribe(notifications);
          return Stream.concat(
            Stream.make("reports" as const),
            Stream.fromSubscription(wakeups),
          ).pipe(
            Stream.mapEffect((wake) =>
              loadBatch(sessionId, originInteractionId, protocolVersion).pipe(
                Effect.map((batch) => ({ batch, force: wake === "speech-state" })),
              ),
            ),
            Stream.filter(({ batch }) => batch !== null),
            Stream.map(({ batch, force }) => ({ batch: batch!, force })),
            Stream.changesWith(
              (left, right) =>
                !left.force &&
                left.batch.batchThrough === right.batch.batchThrough &&
                left.batch.deliveries.length === right.batch.deliveries.length &&
                left.batch.deliveries.every(
                  (delivery, index) =>
                    delivery.sequence === right.batch.deliveries[index]?.sequence,
                ) &&
                JSON.stringify(left.batch.removedReportIds) ===
                  JSON.stringify(right.batch.removedReportIds),
            ),
            Stream.map(({ batch }) => batch),
            Stream.mapError(toPersistenceError("JarvisReportOutbox.subscribe", sessionId)),
          );
        }),
      );

    return JarvisReportOutbox.of({
      register,
      append,
      stageWorkStartedCandidate,
      promoteWorkStartedCandidate,
      dismissWorkStartedCandidate,
      dismissAttention,
      advanceSourceSequence,
      latestSourceSequence,
      claimSpeech,
      confirmSpeech,
      releaseSpeech,
      acknowledge,
      subscribe,
    });
  }),
);
