/**
 * Advisory lease records (M4): one kind=lease blob per (project, machine),
 * key `<wsid>/<envid>`, payload RoamingLeasePayload. "The lease" is derived,
 * never stored — the machine with the newest renewedAt is where work is
 * live — and takeover moves it by writing a fresh record for the taking
 * machine. Renewals are advisory: a lost write only ages the activity chip,
 * so every failure here is logged and swallowed.
 */
import {
  RoamingLeasePayload,
  type EnvironmentId,
  type WorkspaceProjectId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { RoamingBlobStore } from "./RoamingBlobStore.ts";

export const encodeLeasePayloadJson = Schema.encodeEffect(
  Schema.fromJsonString(RoamingLeasePayload),
);

export const decodeLeasePayloadJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RoamingLeasePayload),
);

/**
 * Throttle for activity-only renewals (an in-flight agent turn renews every
 * reactor pass): well under the contract's 2-minute active window so the
 * chip never flickers, but not per-pass blob-write noise.
 */
export const LEASE_RENEW_MIN_INTERVAL_MS = 60 * 1000;

/**
 * Write (or refresh) this machine's lease record. `lastSnapshotAt` set means
 * a snapshot just shipped — always write, carrying the new capture time.
 * Without it (turn activity), the write is throttled against the previous
 * record's renewedAt and preserves its lastSnapshotAt.
 */
export const renewLease = Effect.fn("WipLease.renewLease")(function* (input: {
  readonly workspaceProjectId: WorkspaceProjectId;
  readonly environmentId: EnvironmentId;
  readonly lastSnapshotAt?: string;
}) {
  yield* Effect.gen(function* () {
    const blobStore = yield* RoamingBlobStore;
    const key = `${input.workspaceProjectId}/${input.environmentId}`;
    const previous = yield* blobStore.get({ kind: "lease", key }).pipe(
      Effect.flatMap((blob) =>
        blob === null ? Effect.succeed(null) : decodeLeasePayloadJson(blob.payload),
      ),
      Effect.orElseSucceed(() => null),
    );
    const now = yield* DateTime.now;
    if (
      input.lastSnapshotAt === undefined &&
      previous !== null &&
      DateTime.toEpochMillis(now) - Date.parse(previous.renewedAt) < LEASE_RENEW_MIN_INTERVAL_MS
    ) {
      return;
    }
    const payload = yield* encodeLeasePayloadJson({
      schemaVersion: 1,
      environmentId: input.environmentId,
      renewedAt: DateTime.formatIso(now),
      ...(input.lastSnapshotAt !== undefined
        ? { lastSnapshotAt: input.lastSnapshotAt }
        : previous?.lastSnapshotAt !== undefined
          ? { lastSnapshotAt: previous.lastSnapshotAt }
          : {}),
    });
    yield* blobStore.writeLocal({
      kind: "lease",
      key,
      workspaceProjectId: input.workspaceProjectId,
      payload,
    });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("roaming wip: lease renewal failed", {
        workspaceProjectId: input.workspaceProjectId,
        cause,
      }),
    ),
  );
});
