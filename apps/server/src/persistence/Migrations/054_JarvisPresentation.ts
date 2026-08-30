import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Remove the retired durable voice-delivery projection. T3 projections remain untouched. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP TABLE IF EXISTS jarvis_voice_work_started_candidates`;
  yield* sql`DROP TABLE IF EXISTS jarvis_voice_report_changes`;
  yield* sql`DROP TABLE IF EXISTS jarvis_voice_report_cursors`;
  yield* sql`DROP TABLE IF EXISTS jarvis_voice_reports`;
  yield* sql`DROP TABLE IF EXISTS jarvis_voice_report_projection`;
});
