import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ThreadId } from "@t3tools/contracts";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { JarvisPendingFollowUpQuery } from "../Services/JarvisPendingFollowUpQuery.ts";
import { JarvisPendingFollowUpQueryLive } from "./JarvisPendingFollowUpQuery.ts";

const layer = JarvisPendingFollowUpQueryLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("lists only ready, undispatched threads in stable order", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM projection_thread_activities`;
    yield* sql`DELETE FROM projection_thread_sessions`;

    yield* sql`
      INSERT INTO projection_thread_sessions(thread_id, status, updated_at)
      VALUES
        ('thread-ready-z', 'ready', '2026-08-23T00:00:00.000Z'),
        ('thread-ready-a', 'ready', '2026-08-23T00:00:00.000Z'),
        ('thread-running', 'running', '2026-08-23T00:00:00.000Z'),
        ('thread-dispatched', 'ready', '2026-08-23T00:00:00.000Z')
    `;

    yield* sql`
      INSERT INTO projection_thread_activities(
        activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
      )
      VALUES
        ('queued-z-1', 'thread-ready-z', NULL, 'info', 'jarvis.followup.queued', 'z1', '{}', '2026-08-23T00:00:01.000Z'),
        ('queued-z-2', 'thread-ready-z', NULL, 'info', 'jarvis.followup.queued', 'z2', '{}', '2026-08-23T00:00:02.000Z'),
        ('queued-a-1', 'thread-ready-a', NULL, 'info', 'jarvis.followup.queued', 'a1', '{}', '2026-08-23T00:00:01.000Z'),
        ('queued-running', 'thread-running', NULL, 'info', 'jarvis.followup.queued', 'running', '{}', '2026-08-23T00:00:01.000Z'),
        ('queued-dispatched', 'thread-dispatched', NULL, 'info', 'jarvis.followup.queued', 'done', '{}', '2026-08-23T00:00:01.000Z'),
        ('dispatched-1', 'thread-dispatched', NULL, 'info', 'jarvis.followup.dispatched', 'done', '{"queueId":"queued-dispatched"}', '2026-08-23T00:00:02.000Z')
    `;

    const query = yield* JarvisPendingFollowUpQuery;
    assert.deepEqual(yield* query.listReadyThreads(), [
      ThreadId.make("thread-ready-a"),
      ThreadId.make("thread-ready-z"),
    ]);
  }).pipe(Effect.provide(layer)),
);
