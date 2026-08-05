import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// D2 (2026-07-22): materialize is a stateless idempotent re-run — progress
// streams from memory, "completed" is observable from the registered
// project, and the auto-enroll fork guard reads the marker file the clone
// step writes into the checkout. The persisted step machine caused the one
// recorded materialize field bug and goes away with its table.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TABLE IF EXISTS roaming_materializations`;
});
