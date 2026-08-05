import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE roaming_materializations (
      workspace_project_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      steps_json TEXT NOT NULL,
      notices_json TEXT NOT NULL,
      target_path TEXT,
      local_project_id TEXT,
      error TEXT,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
