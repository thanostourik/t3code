import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// M5.5 (2026-07-30 d): continuing a mirrored thread locally supersedes its
// fallback row — the link is machine-local and never mirrored. While the
// resumed thread exists (projection row, not deleted), the source thread is
// excluded from this machine's mirrored-thread shell.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE roaming_thread_resumptions (
      source_thread_id TEXT PRIMARY KEY,
      resumed_thread_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
});
