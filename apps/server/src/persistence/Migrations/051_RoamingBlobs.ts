import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE roaming_blobs (
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      workspace_project_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      author_environment_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      payload TEXT NOT NULL,
      PRIMARY KEY (kind, key)
    )
  `;

  yield* sql`
    CREATE INDEX idx_roaming_blobs_workspace_project
    ON roaming_blobs(workspace_project_id)
  `;

  yield* sql`
    CREATE TABLE roaming_blob_conflicts (
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      workspace_project_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      local_content_hash TEXT NOT NULL,
      remote_record TEXT NOT NULL,
      detected_at TEXT NOT NULL,
      PRIMARY KEY (kind, key)
    )
  `;
});
