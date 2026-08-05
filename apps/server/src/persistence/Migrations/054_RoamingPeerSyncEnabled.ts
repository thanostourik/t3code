import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Sync on/off is a pause flag on the standing pairing, not credential
  // churn (2026-07-06 product decision): toggling must never require a new
  // pairing code, so the peer row and its credential survive with sync off.
  yield* sql`
    ALTER TABLE roaming_peers ADD COLUMN sync_enabled INTEGER NOT NULL DEFAULT 1
  `;
});
