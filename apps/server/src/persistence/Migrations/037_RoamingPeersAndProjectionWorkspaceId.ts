import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE roaming_peers (
      environment_id TEXT PRIMARY KEY,
      base_urls TEXT NOT NULL,
      last_contact_at TEXT,
      enrolled_at TEXT NOT NULL
    )
  `;

  yield* sql`
    ALTER TABLE projection_projects ADD COLUMN workspace_project_id TEXT
  `;
});
