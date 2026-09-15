import { EnvironmentId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CirceLiveVoiceSessionRepository } from "../Services/CirceLiveVoiceSessions.ts";
import { CirceLiveVoiceSessionsLive } from "./CirceLiveVoiceSessions.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  Layer.mergeAll(
    CirceLiveVoiceSessionsLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

layer("CirceLiveVoiceSessions repository", (it) => {
  it.effect("upserts, lists, and removes a lease", () =>
    Effect.gen(function* () {
      const leases = yield* CirceLiveVoiceSessionRepository;
      const lease = {
        sessionId: "live_1",
        environmentId: EnvironmentId.make("node-1"),
        createdAt: 1000,
        deadlineAt: 2000,
      };
      yield* leases.put(lease);
      assert.deepStrictEqual(yield* leases.list(), [lease]);

      // Re-creating the same session refreshes the ceiling instead of failing.
      yield* leases.put({ ...lease, deadlineAt: 3000 });
      const stored = yield* leases.list();
      assert.strictEqual(stored.length, 1);
      assert.strictEqual(stored[0]?.deadlineAt, 3000);

      assert.strictEqual(yield* leases.remove({ sessionId: "live_1" }), true);
      assert.deepStrictEqual(yield* leases.list(), []);
      assert.strictEqual(yield* leases.remove({ sessionId: "live_1" }), false);
    }),
  );
});
