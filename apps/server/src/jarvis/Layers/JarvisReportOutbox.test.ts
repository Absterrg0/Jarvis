// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  ProjectId,
  MessageId,
  TurnId,
  ThreadId,
  type JarvisVoiceReport,
  type JarvisVoiceReportBatch,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import { JarvisReportOutbox } from "../Services/JarvisReportOutbox.ts";
import { JarvisReportOutboxLive } from "./JarvisReportOutbox.ts";

const report = (reportId: string, createdAt: string): JarvisVoiceReport => ({
  reportId,
  projectId: ProjectId.make("project-rivvl"),
  threadId: ThreadId.make("thread-auth-review"),
  kind: "completed",
  threadTitle: "Authentication review",
  providerName: "codex",
  text: `Result ${reportId}`,
  createdAt,
});

const workStartedReport = (turnId: TurnId, text: string): JarvisVoiceReport => ({
  ...report(`jarvis-work-started:thread-auth-review:${turnId}`, "2026-01-01T00:00:00.000Z"),
  kind: "work-started",
  turnId,
  text,
});

const createSession = Effect.fn("test.createSession")(function* (sessionId: AuthSessionId) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO auth_sessions(
      session_id, subject, scopes, method, client_device_type, issued_at, expires_at
    ) VALUES (
      ${sessionId}, 'test', '["orchestration:read"]', 'pairing', 'desktop',
      '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'
    )
  `;
});

const nextBatch = Effect.fn("test.nextBatch")(function* (
  outbox: JarvisReportOutbox["Service"],
  sessionId: AuthSessionId,
  originInteractionId?: string,
) {
  const value = yield* Stream.runHead(outbox.subscribe(sessionId, originInteractionId));
  return Option.getOrThrow(value);
});

it.effect("replays one unacknowledged report across restart with independent device cursors", () =>
  Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-jarvis-reports-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
    );
    const database = makeSqlitePersistenceLive(NodePath.join(tempDir, "state.sqlite"));
    const layer = JarvisReportOutboxLive.pipe(
      Layer.provideMerge(database),
      Layer.provideMerge(NodeServices.layer),
    );
    const desktop = AuthSessionId.make("session-desktop");
    const companion = AuthSessionId.make("session-companion");

    yield* Effect.gen(function* () {
      const outbox = yield* JarvisReportOutbox;
      yield* createSession(desktop);
      yield* createSession(companion);
      yield* outbox.register(desktop);
      yield* outbox.register(companion);
      yield* outbox.append({
        sourceSequence: 1,
        report: report("report-one", "2026-01-01T01:00:00.000Z"),
      });
      yield* outbox.append({
        sourceSequence: 2,
        report: report("report-two", "2026-01-01T02:00:00.000Z"),
      });

      const desktopBatch = yield* nextBatch(outbox, desktop);
      const companionBatch = yield* nextBatch(outbox, companion);
      assert.deepEqual(
        desktopBatch.deliveries.map((delivery) => delivery.report.reportId),
        ["report-one", "report-two"],
      );
      assert.deepEqual(
        companionBatch.deliveries.map((delivery) => delivery.report.reportId),
        ["report-one", "report-two"],
      );
      assert.equal(yield* outbox.acknowledge(desktop, 1), 1);
    }).pipe(Effect.provide(layer));

    yield* Effect.gen(function* () {
      const outbox = yield* JarvisReportOutbox;
      assert.deepEqual(
        (yield* nextBatch(outbox, desktop)).deliveries.map((delivery) => delivery.report.reportId),
        ["report-two"],
      );
      assert.deepEqual(
        (yield* nextBatch(outbox, companion)).deliveries.map(
          (delivery) => delivery.report.reportId,
        ),
        ["report-one", "report-two"],
      );
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("starts a first-time subscriber after existing report history", () =>
  Effect.gen(function* () {
    const outbox = yield* JarvisReportOutbox;
    const sessionId = AuthSessionId.make("session-first-subscription");
    yield* createSession(sessionId);
    yield* outbox.append({
      sourceSequence: 1,
      report: report("historical", "2026-01-01T01:00:00.000Z"),
    });
    yield* outbox.register(sessionId);
    yield* outbox.append({
      sourceSequence: 2,
      report: report("new-report", "2026-01-01T02:00:00.000Z"),
    });
    assert.equal(
      (yield* nextBatch(outbox, sessionId)).deliveries[0]?.report.reportId,
      "new-report",
    );
  }).pipe(
    Effect.provide(
      JarvisReportOutboxLive.pipe(
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("resumes an origin inbox cursor after auth-session recreation", () =>
  Effect.gen(function* () {
    const outbox = yield* JarvisReportOutbox;
    const firstSession = AuthSessionId.make("session-origin-first");
    const recreatedSession = AuthSessionId.make("session-origin-recreated");
    const originInteractionId = "companion-installation-1";
    yield* createSession(firstSession);
    yield* createSession(recreatedSession);

    yield* outbox.append({
      sourceSequence: 1,
      report: report("before-registration", "2026-01-01T01:00:00.000Z"),
    });
    yield* outbox.register(firstSession, originInteractionId);
    yield* outbox.append({
      sourceSequence: 2,
      report: report("while-connected", "2026-01-01T02:00:00.000Z"),
    });
    const firstBatch = yield* nextBatch(outbox, firstSession, originInteractionId);
    assert.deepEqual(
      firstBatch.deliveries.map((delivery) => delivery.report.reportId),
      ["while-connected"],
    );
    assert.equal(
      yield* outbox.acknowledge(firstSession, firstBatch.batchThrough, originInteractionId),
      2,
    );

    yield* outbox.append({
      sourceSequence: 3,
      report: report("while-disconnected", "2026-01-01T03:00:00.000Z"),
    });
    const reconnectedBatch = yield* nextBatch(outbox, recreatedSession, originInteractionId);
    assert.deepEqual(
      reconnectedBatch.deliveries.map((delivery) => delivery.report.reportId),
      ["while-disconnected"],
    );
  }).pipe(
    Effect.provide(
      JarvisReportOutboxLive.pipe(
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("skips only the resolved request while advancing the delivery cursor", () =>
  Effect.gen(function* () {
    const outbox = yield* JarvisReportOutbox;
    const sessionId = AuthSessionId.make("session-resolved-attention");
    yield* createSession(sessionId);
    yield* outbox.register(sessionId);
    yield* outbox.append({
      sourceSequence: 1,
      requestId: "request-one",
      report: {
        ...report("question-one", "2026-01-01T01:00:00.000Z"),
        kind: "waiting-for-input",
      },
    });
    yield* outbox.append({
      sourceSequence: 2,
      requestId: "request-two",
      report: {
        ...report("question-two", "2026-01-01T02:00:00.000Z"),
        kind: "waiting-for-input",
      },
    });
    yield* outbox.dismissAttention({
      threadId: ThreadId.make("thread-auth-review"),
      requestId: "request-one",
      kind: "waiting-for-input",
    });

    const batch = yield* Stream.runHead(outbox.subscribe(sessionId, undefined, 2)).pipe(
      Effect.map(Option.getOrThrow),
    );
    assert.equal(batch.batchThrough, 3);
    assert.deepEqual(
      batch.deliveries.map((delivery) => delivery.report.reportId),
      ["question-two"],
    );
    assert.deepEqual(batch.removedReportIds, ["question-one"]);
  }).pipe(
    Effect.provide(
      JarvisReportOutboxLive.pipe(
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("acknowledges monotonically and clamps the cursor to the outbox head", () =>
  Effect.gen(function* () {
    const outbox = yield* JarvisReportOutbox;
    const sessionId = AuthSessionId.make("session-monotonic-ack");
    yield* createSession(sessionId);
    yield* outbox.register(sessionId);
    yield* outbox.append({
      sourceSequence: 1,
      report: report("report-one", "2026-01-01T01:00:00.000Z"),
    });
    yield* outbox.append({
      sourceSequence: 2,
      report: report("report-two", "2026-01-01T02:00:00.000Z"),
    });

    assert.equal(yield* outbox.acknowledge(sessionId, 2), 2);
    assert.equal(yield* outbox.acknowledge(sessionId, 1), 2);
    assert.equal(yield* outbox.acknowledge(sessionId, 999), 2);
  }).pipe(
    Effect.provide(
      JarvisReportOutboxLive.pipe(
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("pages report delivery in bounded batches", () =>
  Effect.gen(function* () {
    const outbox = yield* JarvisReportOutbox;
    const sessionId = AuthSessionId.make("session-bounded-batches");
    yield* createSession(sessionId);
    yield* outbox.register(sessionId);
    yield* Effect.forEach(
      Array.from({ length: 33 }, (_, index) => index + 1),
      (sequence) =>
        outbox.append({
          sourceSequence: sequence,
          report: report(
            `report-${sequence}`,
            `2026-01-01T00:${String(sequence).padStart(2, "0")}:00.000Z`,
          ),
        }),
    );

    const first = yield* nextBatch(outbox, sessionId);
    assert.equal(first.deliveries.length, 32);
    assert.isTrue(first.hasMore);
    yield* outbox.acknowledge(sessionId, first.batchThrough);
    const second = yield* nextBatch(outbox, sessionId);
    assert.equal(second.deliveries.length, 1);
    assert.isFalse(second.hasMore);
    assert.equal(second.deliveries[0]?.report.reportId, "report-33");
  }).pipe(
    Effect.provide(
      JarvisReportOutboxLive.pipe(
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("does not replay an inactive v2 upsert when its removal is in a later page", () =>
  Effect.gen(function* () {
    const outbox = yield* JarvisReportOutbox;
    const sessionId = AuthSessionId.make("session-v2-split-removal");
    yield* createSession(sessionId);
    yield* outbox.register(sessionId);
    const obsolete = {
      ...report("obsolete-v2-report", "2026-01-01T00:00:00.000Z"),
      kind: "waiting-for-input" as const,
    };
    yield* outbox.append({
      sourceSequence: 1,
      requestId: "obsolete-v2-request",
      report: obsolete,
    });
    yield* Effect.forEach(
      Array.from({ length: 31 }, (_, index) => index + 2),
      (sequence) =>
        outbox.append({
          sourceSequence: sequence,
          report: report(`v2-filler-${sequence}`, "2026-01-01T00:00:00.000Z"),
        }),
    );
    yield* outbox.dismissAttention({
      threadId: obsolete.threadId,
      requestId: "obsolete-v2-request",
      kind: "waiting-for-input",
    });

    const first = yield* Stream.runHead(outbox.subscribe(sessionId, undefined, 2)).pipe(
      Effect.map(Option.getOrThrow),
    );
    assert.equal(first.batchThrough, 32);
    assert.isTrue(first.hasMore);
    assert.notInclude(
      first.deliveries.map((delivery) => delivery.report.reportId),
      obsolete.reportId,
    );

    yield* outbox.acknowledge(sessionId, first.batchThrough);
    const second = yield* Stream.runHead(outbox.subscribe(sessionId, undefined, 2)).pipe(
      Effect.map(Option.getOrThrow),
    );
    assert.equal(second.batchThrough, 33);
    assert.deepEqual(second.deliveries, []);
    assert.deepEqual(second.removedReportIds, [obsolete.reportId]);
  }).pipe(
    Effect.provide(
      JarvisReportOutboxLive.pipe(
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("marks a session whose cursor falls behind bounded retention", () =>
  Effect.gen(function* () {
    const outbox = yield* JarvisReportOutbox;
    const sessionId = AuthSessionId.make("session-truncated-inbox");
    yield* createSession(sessionId);
    yield* outbox.register(sessionId);
    yield* Effect.forEach(
      Array.from({ length: 513 }, (_, index) => index + 1),
      (sequence) =>
        outbox.append({
          sourceSequence: sequence,
          report: report(`retained-report-${sequence}`, "2026-01-01T00:00:00.000Z"),
        }),
    );

    const batch = yield* nextBatch(outbox, sessionId);
    assert.equal(batch.truncatedBefore, 2);
    assert.equal(batch.deliveries[0]?.sequence, 2);
    assert.equal(yield* outbox.claimSpeech("retained-report-1", "desktop"), "missing");
    assert.equal(yield* outbox.confirmSpeech("retained-report-1", "desktop"), "missing");
  }).pipe(
    Effect.provide(
      JarvisReportOutboxLive.pipe(
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("allows a second device to recover an expired speech lease", () =>
  Effect.gen(function* () {
    const outbox = yield* JarvisReportOutbox;
    yield* outbox.append({
      sourceSequence: 1,
      report: report("expired-speech-lease", "2026-01-01T01:00:00.000Z"),
    });
    assert.equal(yield* outbox.claimSpeech("expired-speech-lease", "desktop-a"), "claimed");
    yield* TestClock.adjust(600_001);
    assert.equal(yield* outbox.claimSpeech("expired-speech-lease", "desktop-b"), "claimed");
    assert.equal(yield* outbox.confirmSpeech("expired-speech-lease", "desktop-a"), "lease-lost");
    assert.equal(yield* outbox.confirmSpeech("expired-speech-lease", "desktop-b"), "confirmed");
  }).pipe(
    Effect.provide(
      JarvisReportOutboxLive.pipe(
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("releases only the owning unspoken lease", () =>
  Effect.gen(function* () {
    const outbox = yield* JarvisReportOutbox;
    yield* outbox.append({
      sourceSequence: 1,
      report: report("released-speech", "2026-01-01T01:00:00.000Z"),
    });
    assert.equal(yield* outbox.claimSpeech("released-speech", "desktop-a"), "claimed");
    assert.equal(yield* outbox.releaseSpeech("released-speech", "desktop-b"), "lease-lost");
    assert.equal(yield* outbox.releaseSpeech("released-speech", "desktop-a"), "released");
    assert.equal(yield* outbox.claimSpeech("released-speech", "desktop-b"), "claimed");
    assert.equal(yield* outbox.confirmSpeech("released-speech", "desktop-b"), "confirmed");
    assert.equal(yield* outbox.releaseSpeech("released-speech", "desktop-b"), "already-spoken");
    assert.equal(yield* outbox.releaseSpeech("missing-speech", "desktop-b"), "missing");
  }).pipe(
    Effect.provide(
      JarvisReportOutboxLive.pipe(
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("emits a speech-state wake even when the batch is unchanged", () =>
  Effect.gen(function* () {
    const outbox = yield* JarvisReportOutbox;
    const sessionId = AuthSessionId.make("session-speech-wake");
    yield* createSession(sessionId);
    yield* outbox.register(sessionId);
    yield* outbox.append({
      sourceSequence: 1,
      report: report("speech-wake", "2026-01-01T01:00:00.000Z"),
    });
    const batches = yield* Queue.unbounded<JarvisVoiceReportBatch>();
    const consumer = yield* Stream.runForEach(outbox.subscribe(sessionId), (batch) =>
      Queue.offer(batches, batch),
    ).pipe(Effect.forkChild);
    const first = yield* Queue.take(batches);
    yield* Effect.yieldNow;
    assert.equal(yield* outbox.claimSpeech("speech-wake", "desktop"), "claimed");
    assert.equal(yield* outbox.confirmSpeech("speech-wake", "other-device"), "lease-lost");
    yield* Effect.yieldNow;
    assert.isTrue(Option.isNone(yield* Queue.poll(batches)));
    assert.equal(yield* outbox.releaseSpeech("speech-wake", "desktop"), "released");
    const second = yield* Queue.take(batches);
    assert.equal(second.batchThrough, first.batchThrough);
    assert.equal(yield* outbox.claimSpeech("speech-wake", "desktop"), "claimed");
    assert.equal(yield* outbox.confirmSpeech("speech-wake", "desktop"), "confirmed");
    const third = yield* Queue.take(batches);
    assert.equal(third.batchThrough, first.batchThrough);
    assert.equal(yield* outbox.confirmSpeech("speech-wake", "other-device"), "already-spoken");
    yield* Effect.yieldNow;
    assert.isTrue(Option.isNone(yield* Queue.poll(batches)));
    assert.equal(yield* outbox.confirmSpeech("missing-speech", "desktop"), "missing");
    yield* Effect.yieldNow;
    assert.isTrue(Option.isNone(yield* Queue.poll(batches)));
    yield* Fiber.interrupt(consumer);
  }).pipe(
    Effect.provide(
      JarvisReportOutboxLive.pipe(
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
it.effect("claims speech once across outbox service restarts", () =>
  Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-jarvis-speech-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
    );
    const database = makeSqlitePersistenceLive(NodePath.join(tempDir, "state.sqlite"));
    const layer = JarvisReportOutboxLive.pipe(
      Layer.provideMerge(database),
      Layer.provideMerge(NodeServices.layer),
    );

    yield* Effect.gen(function* () {
      const outbox = yield* JarvisReportOutbox;
      yield* outbox.append({
        sourceSequence: 1,
        report: report("spoken-once", "2026-01-01T01:00:00.000Z"),
      });
      assert.equal(yield* outbox.claimSpeech("spoken-once", "desktop-a"), "claimed");
      assert.equal(yield* outbox.claimSpeech("spoken-once", "desktop-b"), "leased");
      assert.equal(yield* outbox.claimSpeech("spoken-once", "desktop-a"), "claimed");
      assert.equal(yield* outbox.confirmSpeech("spoken-once", "desktop-b"), "lease-lost");
      assert.equal(yield* outbox.confirmSpeech("spoken-once", "desktop-a"), "confirmed");
      const restartTurn = TurnId.make("turn-restart-candidate");
      const restartCandidate = workStartedReport(restartTurn, "Candidate survives restart.");
      assert.isTrue(
        yield* outbox.stageWorkStartedCandidate({
          threadId: restartCandidate.threadId,
          turnId: restartTurn,
          assistantMessageId: MessageId.make("assistant-restart"),
          sourceSequence: 3,
          report: restartCandidate,
        }),
      );
    }).pipe(Effect.provide(layer));

    yield* Effect.gen(function* () {
      const outbox = yield* JarvisReportOutbox;
      assert.isTrue(
        yield* outbox.promoteWorkStartedCandidate({
          threadId: ThreadId.make("thread-auth-review"),
          turnId: TurnId.make("turn-restart-candidate"),
          sourceSequence: 4,
        }),
      );
      assert.equal(yield* outbox.claimSpeech("spoken-once", "desktop-b"), "already-spoken");
      assert.equal(yield* outbox.confirmSpeech("spoken-once", "desktop-b"), "already-spoken");
      assert.equal(yield* outbox.claimSpeech("legacy-hot-report", "desktop-b"), "missing");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("stages work-started candidates invisibly and promotes them once", () =>
  Effect.gen(function* () {
    const outbox = yield* JarvisReportOutbox;
    const sql = yield* SqlClient.SqlClient;
    const turnId = TurnId.make("turn-work-started");
    const first = workStartedReport(turnId, "Inspecting the authentication boundary.");
    const second = workStartedReport(turnId, "A later duplicate must not win.");
    assert.isTrue(
      yield* outbox.stageWorkStartedCandidate({
        threadId: first.threadId,
        turnId,
        assistantMessageId: MessageId.make("assistant-first"),
        sourceSequence: 1,
        report: first,
      }),
    );
    assert.isFalse(
      yield* outbox.stageWorkStartedCandidate({
        threadId: first.threadId,
        turnId,
        assistantMessageId: MessageId.make("assistant-second"),
        sourceSequence: 2,
        report: second,
      }),
    );
    const staged = yield* sql<{
      readonly assistantMessageId: string;
      readonly reportJson: string;
    }>`
      SELECT assistant_message_id AS assistantMessageId, report_json AS reportJson
      FROM jarvis_voice_work_started_candidates
    `;
    assert.equal(staged.length, 1);
    assert.equal(staged[0]?.assistantMessageId, "assistant-first");
    const reportsBeforePromotion = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM jarvis_voice_reports WHERE kind = 'work-started'
    `;
    assert.equal(reportsBeforePromotion[0]?.count, 0);
    const sessionId = AuthSessionId.make("session-work-started-invisible");
    yield* createSession(sessionId);
    yield* outbox.register(sessionId);
    const unrelated = report("unrelated-before-promotion", "2026-01-01T00:00:00.000Z");
    yield* outbox.append({ sourceSequence: 9, report: unrelated });
    const visible = yield* nextBatch(outbox, sessionId);
    assert.deepEqual(
      visible.deliveries.map((delivery) => delivery.report.reportId),
      [unrelated.reportId],
    );
    assert.equal(visible.batchThrough, 1);
    assert.isTrue(
      yield* outbox.promoteWorkStartedCandidate({
        threadId: first.threadId,
        turnId,
        sourceSequence: 3,
      }),
    );
    assert.isFalse(
      yield* outbox.promoteWorkStartedCandidate({
        threadId: first.threadId,
        turnId,
        sourceSequence: 3,
      }),
    );
    const promoted = yield* sql<{
      readonly sourceSequence: number;
      readonly reportJson: string;
    }>`
      SELECT source_sequence AS sourceSequence, report_json AS reportJson
      FROM jarvis_voice_reports WHERE kind = 'work-started'
    `;
    assert.equal(promoted.length, 1);
    assert.equal(promoted[0]?.sourceSequence, 3);
    assert.isTrue(promoted[0]?.reportJson.includes(first.text));
  }).pipe(
    Effect.provide(
      JarvisReportOutboxLive.pipe(
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("dismisses staged and promoted work-started state without touching other reports", () =>
  Effect.gen(function* () {
    const outbox = yield* JarvisReportOutbox;
    const sql = yield* SqlClient.SqlClient;
    const turnId = TurnId.make("turn-dismiss-work-started");
    const started = workStartedReport(turnId, "Starting the requested change.");
    const unrelated = report("unrelated-report", "2026-01-01T00:00:00.000Z");
    yield* outbox.stageWorkStartedCandidate({
      threadId: started.threadId,
      turnId,
      assistantMessageId: MessageId.make("assistant-dismiss"),
      sourceSequence: 1,
      report: started,
    });
    yield* outbox.promoteWorkStartedCandidate({
      threadId: started.threadId,
      turnId,
      sourceSequence: 2,
    });
    const otherTurn = TurnId.make("turn-other-work-started");
    const otherStarted = workStartedReport(otherTurn, "A different turn remains active.");
    yield* outbox.stageWorkStartedCandidate({
      threadId: otherStarted.threadId,
      turnId: otherTurn,
      assistantMessageId: MessageId.make("assistant-other-turn"),
      sourceSequence: 3,
      report: otherStarted,
    });
    yield* outbox.promoteWorkStartedCandidate({
      threadId: otherStarted.threadId,
      turnId: otherTurn,
      sourceSequence: 4,
    });
    yield* outbox.append({ sourceSequence: 3, report: unrelated });
    assert.equal(yield* outbox.claimSpeech(started.reportId, "desktop"), "claimed");
    yield* outbox.dismissWorkStartedCandidate({ threadId: started.threadId, turnId });
    const startedRow = yield* sql<{
      readonly active: number;
      readonly leaseDevice: string | null;
      readonly leaseExpiry: string | null;
    }>`
      SELECT active, speech_lease_device_id AS leaseDevice,
        speech_lease_expires_at AS leaseExpiry
      FROM jarvis_voice_reports WHERE report_id = ${started.reportId}
    `;
    assert.deepEqual(startedRow[0], { active: 0, leaseDevice: null, leaseExpiry: null });
    const unrelatedRow = yield* sql<{ readonly active: number }>`
      SELECT active FROM jarvis_voice_reports WHERE report_id = ${unrelated.reportId}
    `;
    assert.equal(unrelatedRow[0]?.active, 1);
    const otherRow = yield* sql<{ readonly active: number }>`
      SELECT active FROM jarvis_voice_reports WHERE report_id = ${otherStarted.reportId}
    `;
    assert.equal(otherRow[0]?.active, 1);
    const stagedTurn = TurnId.make("turn-staged-dismiss");
    const staged = workStartedReport(stagedTurn, "This candidate is discarded.");
    yield* outbox.stageWorkStartedCandidate({
      threadId: staged.threadId,
      turnId: stagedTurn,
      assistantMessageId: MessageId.make("assistant-staged-dismiss"),
      sourceSequence: 4,
      report: staged,
    });
    yield* outbox.dismissWorkStartedCandidate({ threadId: staged.threadId, turnId: stagedTurn });
    const candidates = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM jarvis_voice_work_started_candidates
      WHERE turn_id = ${stagedTurn} AND phase <> 'dismissed'
    `;
    assert.equal(candidates[0]?.count, 0);
  }).pipe(
    Effect.provide(
      JarvisReportOutboxLive.pipe(
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("rejects an earlier tool and permanently tombstones the first same-turn candidate", () =>
  Effect.gen(function* () {
    const outbox = yield* JarvisReportOutbox;
    const sql = yield* SqlClient.SqlClient;
    const turnId = TurnId.make("turn-first-wins");
    const first = workStartedReport(turnId, "First provider message.");
    const second = workStartedReport(turnId, "Second provider message.");
    yield* outbox.stageWorkStartedCandidate({
      threadId: first.threadId,
      turnId,
      assistantMessageId: MessageId.make("assistant-first"),
      sourceSequence: 10,
      report: first,
    });
    assert.isFalse(
      yield* outbox.promoteWorkStartedCandidate({
        threadId: first.threadId,
        turnId,
        sourceSequence: 9,
      }),
    );
    yield* outbox.dismissWorkStartedCandidate({ threadId: first.threadId, turnId });
    assert.isFalse(
      yield* outbox.stageWorkStartedCandidate({
        threadId: second.threadId,
        turnId,
        assistantMessageId: MessageId.make("assistant-second"),
        sourceSequence: 11,
        report: second,
      }),
    );
    assert.isFalse(
      yield* outbox.promoteWorkStartedCandidate({
        threadId: first.threadId,
        turnId,
        sourceSequence: 11,
      }),
    );
    const rows = yield* sql<{ readonly assistant: string | null; readonly phase: string }>`
      SELECT assistant_message_id AS assistant, phase FROM jarvis_voice_work_started_candidates
      WHERE thread_id = ${first.threadId} AND turn_id = ${turnId}
    `;
    assert.deepEqual(rows[0], { assistant: "assistant-first", phase: "dismissed" });
  }).pipe(
    Effect.provide(
      JarvisReportOutboxLive.pipe(
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("replays a work-start removal after acknowledgement and service restart", () =>
  Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-jarvis-removal-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
    );
    const database = makeSqlitePersistenceLive(NodePath.join(tempDir, "state.sqlite"));
    const layer = JarvisReportOutboxLive.pipe(
      Layer.provideMerge(database),
      Layer.provideMerge(NodeServices.layer),
    );
    const firstSession = AuthSessionId.make("removal-first");
    const nextSession = AuthSessionId.make("removal-next");
    const origin = "removal-origin";
    const turnId = TurnId.make("turn-removal-restart");
    const started = workStartedReport(turnId, "Starting before reconnect.");
    yield* Effect.gen(function* () {
      const outbox = yield* JarvisReportOutbox;
      yield* createSession(firstSession);
      yield* createSession(nextSession);
      yield* outbox.register(firstSession, origin);
      yield* outbox.stageWorkStartedCandidate({
        threadId: started.threadId,
        turnId,
        assistantMessageId: MessageId.make("assistant-removal"),
        sourceSequence: 1,
        report: started,
      });
      yield* outbox.promoteWorkStartedCandidate({
        threadId: started.threadId,
        turnId,
        sourceSequence: 2,
      });
      const batch = yield* Stream.runHead(outbox.subscribe(firstSession, origin, 2)).pipe(
        Effect.map(Option.getOrThrow),
      );
      assert.deepEqual(
        batch.deliveries.map((d) => d.report.reportId),
        [started.reportId],
      );
      yield* outbox.acknowledge(firstSession, batch.batchThrough, origin);
      yield* outbox.dismissWorkStartedCandidate({ threadId: started.threadId, turnId });
      assert.equal(yield* outbox.claimSpeech(started.reportId, "desktop"), "missing");
    }).pipe(Effect.provide(layer));
    yield* Effect.gen(function* () {
      const outbox = yield* JarvisReportOutbox;
      const batch = yield* Stream.runHead(outbox.subscribe(nextSession, origin, 2)).pipe(
        Effect.map(Option.getOrThrow),
      );
      assert.deepEqual(batch.removedReportIds, [started.reportId]);
      assert.equal(batch.batchThrough, 2);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("rolls back attention dismissal when its removal change cannot be inserted", () =>
  Effect.gen(function* () {
    const outbox = yield* JarvisReportOutbox;
    const sql = yield* SqlClient.SqlClient;
    const sessionId = AuthSessionId.make("dismiss-rollback");
    yield* createSession(sessionId);
    const waiting = {
      ...report("rollback-attention", "2026-01-01T00:00:00.000Z"),
      kind: "waiting-for-input" as const,
    };
    yield* outbox.append({ sourceSequence: 1, requestId: "request-rollback", report: waiting });
    yield* sql`
      CREATE TRIGGER fail_jarvis_remove_change BEFORE INSERT ON jarvis_voice_report_changes
      WHEN NEW.change_kind = 'remove'
      BEGIN SELECT RAISE(ABORT, 'remove insert failed'); END
    `;
    const failed = yield* Effect.exit(
      outbox.dismissAttention({
        threadId: waiting.threadId,
        requestId: "request-rollback",
        kind: "waiting-for-input",
      }),
    );
    assert.isTrue(Exit.isFailure(failed));
    const activeAfterFailure = yield* sql<{ readonly active: number }>`
      SELECT active FROM jarvis_voice_reports WHERE report_id = ${waiting.reportId}
    `;
    assert.equal(activeAfterFailure[0]?.active, 1);
    yield* sql`DROP TRIGGER fail_jarvis_remove_change`;
    yield* outbox.dismissAttention({
      threadId: waiting.threadId,
      requestId: "request-rollback",
      kind: "waiting-for-input",
    });
    const finalState = yield* sql<{ readonly active: number; readonly removals: number }>`
      SELECT r.active, (SELECT COUNT(*) FROM jarvis_voice_report_changes WHERE report_id = r.report_id AND change_kind = 'remove') AS removals
      FROM jarvis_voice_reports r WHERE r.report_id = ${waiting.reportId}
    `;
    assert.deepEqual(finalState[0], { active: 0, removals: 1 });
  }).pipe(
    Effect.provide(
      JarvisReportOutboxLive.pipe(
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect(
  "retains the newest dismissed candidates by update time and keeps active candidates",
  () =>
    Effect.gen(function* () {
      const outbox = yield* JarvisReportOutbox;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-retention-dismissed");
      const activeStagedTurn = TurnId.make("retention-active-staged");
      const activeStaged = workStartedReport(activeStagedTurn, "Still staged.");
      yield* outbox.stageWorkStartedCandidate({
        threadId,
        turnId: activeStagedTurn,
        assistantMessageId: MessageId.make("assistant-active-staged"),
        sourceSequence: 1,
        report: activeStaged,
      });
      const activePromotedTurn = TurnId.make("retention-active-promoted");
      const activePromoted = workStartedReport(activePromotedTurn, "Still promoted.");
      yield* outbox.stageWorkStartedCandidate({
        threadId,
        turnId: activePromotedTurn,
        assistantMessageId: MessageId.make("assistant-active-promoted"),
        sourceSequence: 2,
        report: activePromoted,
      });
      yield* outbox.promoteWorkStartedCandidate({
        threadId,
        turnId: activePromotedTurn,
        sourceSequence: 3,
      });

      yield* Effect.forEach(
        Array.from({ length: 513 }, (_, index) => index),
        (index) => {
          const turnId = TurnId.make(`retention-dismissed-${index}`);
          const candidate = workStartedReport(turnId, `Dismissed ${index}.`);
          return Effect.gen(function* () {
            yield* outbox.stageWorkStartedCandidate({
              threadId,
              turnId,
              assistantMessageId: MessageId.make(`assistant-dismissed-${index}`),
              sourceSequence: 100 + index,
              report: candidate,
            });
            yield* outbox.dismissWorkStartedCandidate({ threadId, turnId });
          });
        },
      );

      const candidates = yield* sql<{ readonly phase: string; readonly turnId: string }>`
      SELECT phase, turn_id AS turnId FROM jarvis_voice_work_started_candidates
      WHERE thread_id = ${threadId}
    `;
      assert.isAtMost(candidates.filter((row) => row.phase === "dismissed").length, 512);
      assert.isTrue(
        candidates.some((row) => row.turnId === activeStagedTurn && row.phase === "staged"),
      );
      assert.isTrue(
        candidates.some((row) => row.turnId === activePromotedTurn && row.phase === "promoted"),
      );
      const counts = yield* sql<{ readonly reports: number; readonly changes: number }>`
      SELECT
        (SELECT COUNT(*) FROM jarvis_voice_reports) AS reports,
        (SELECT COUNT(*) FROM jarvis_voice_report_changes) AS changes
    `;
      assert.isAtMost(counts[0]?.reports ?? 0, 512);
      assert.isAtMost(counts[0]?.changes ?? 0, 512);
    }).pipe(
      Effect.provide(
        JarvisReportOutboxLive.pipe(
          Layer.provideMerge(SqlitePersistenceMemory),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);

it.effect("retains only bounded report history while preserving promoted candidates", () =>
  Effect.gen(function* () {
    const outbox = yield* JarvisReportOutbox;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("thread-retention-promoted");
    yield* Effect.forEach(
      Array.from({ length: 513 }, (_, index) => index),
      (index) => {
        const turnId = TurnId.make(`retention-promoted-${index}`);
        const candidate = workStartedReport(turnId, `Promoted ${index}.`);
        return Effect.gen(function* () {
          yield* outbox.stageWorkStartedCandidate({
            threadId,
            turnId,
            assistantMessageId: MessageId.make(`assistant-promoted-${index}`),
            sourceSequence: 1_000 + index * 2,
            report: candidate,
          });
          yield* outbox.promoteWorkStartedCandidate({
            threadId,
            turnId,
            sourceSequence: 1_001 + index * 2,
          });
        });
      },
    );
    const counts = yield* sql<{
      readonly reports: number;
      readonly changes: number;
      readonly promoted: number;
    }>`
      SELECT
        (SELECT COUNT(*) FROM jarvis_voice_reports) AS reports,
        (SELECT COUNT(*) FROM jarvis_voice_report_changes) AS changes,
        (SELECT COUNT(*) FROM jarvis_voice_work_started_candidates WHERE phase = 'promoted') AS promoted
    `;
    assert.isAtMost(counts[0]?.reports ?? 0, 512);
    assert.isAtMost(counts[0]?.changes ?? 0, 512);
    assert.equal(counts[0]?.promoted, 513);
  }).pipe(
    Effect.provide(
      JarvisReportOutboxLive.pipe(
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
