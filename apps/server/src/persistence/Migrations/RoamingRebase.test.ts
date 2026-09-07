import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { migrationEntries, migrationManifest, runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layerMemory())("roaming rebase migrations", (it) => {
  it.effect(
    "upgrades the previous branch without losing roaming data or skipping upstream schema",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 49 });
        for (const [id, name, migration] of migrationEntries) {
          if (id < 51) continue;
          yield* migration;
          yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id - 1}, ${name})`;
        }
        yield* sql`INSERT INTO roaming_peers (environment_id, base_urls, enrolled_at, sync_enabled)
        VALUES ('retained-peer', '["https://peer.example"]', '2026-08-06T00:00:00.000Z', 0)`;
        yield* sql`INSERT INTO roaming_blobs (kind, key, workspace_project_id, version, content_hash, author_environment_id, updated_at, payload)
        VALUES ('registry', 'retained-project', 'retained-project', 7, 'retained-hash', 'retained-peer', '2026-08-06T00:00:00.000Z', '{"retained":true}')`;
        yield* runMigrations();
        const peers = yield* sql`SELECT environment_id, sync_enabled FROM roaming_peers`;
        assert.deepEqual(peers, [{ environment_id: "retained-peer", sync_enabled: 0 }]);
        const blobs = yield* sql`SELECT version, payload FROM roaming_blobs`;
        assert.deepEqual(blobs, [{ version: 7, payload: '{"retained":true}' }]);
        const ledger = yield* sql<{
          migration_id: number;
          name: string;
        }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
        assert.deepEqual(
          ledger.map((row) => [row.migration_id, row.name]),
          migrationManifest.map(([id, name]) => [id, name]),
        );
        const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
        assert.isTrue(columns.some((column) => column.name === "active_order_key"));
        assert.isTrue(columns.some((column) => column.name === "branch_pull_request_json"));
        const pullRequestTables =
          yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projection_thread_pull_requests'`;
        assert.deepEqual(pullRequestTables, [{ name: "projection_thread_pull_requests" }]);
        assert.deepEqual(yield* runMigrations(), []);
      }),
  );
});
