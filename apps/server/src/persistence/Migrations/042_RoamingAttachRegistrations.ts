import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// M5.6 bidirectional pairing: the reverse half of the unified handshake.
// The initiator posts an attach registration (its label, candidate base
// URLs, and a standard-scoped bearer) so this machine's OWN clients can
// attach back to it. Metadata lives here; the bearer token lives in
// ServerSecretStore under `roaming-attach-<environmentId>`.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE roaming_attach_registrations (
      environment_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      base_urls TEXT NOT NULL,
      expires_at TEXT,
      registered_at TEXT NOT NULL
    )
  `;
});
