// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthSessionId, ProjectId, ThreadId, type JarvisVoiceReport } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
) {
  const value = yield* Stream.runHead(outbox.subscribe(sessionId));
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

    const batch = yield* nextBatch(outbox, sessionId);
    assert.equal(batch.batchThrough, 2);
    assert.deepEqual(
      batch.deliveries.map((delivery) => delivery.report.reportId),
      ["question-two"],
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
    }).pipe(Effect.provide(layer));

    yield* Effect.gen(function* () {
      const outbox = yield* JarvisReportOutbox;
      assert.equal(yield* outbox.claimSpeech("spoken-once", "desktop-b"), "already-spoken");
      assert.equal(yield* outbox.confirmSpeech("spoken-once", "desktop-b"), "already-spoken");
      assert.equal(yield* outbox.claimSpeech("legacy-hot-report", "desktop-b"), "missing");
    }).pipe(Effect.provide(layer));
  }),
);
