/**
 * RoamingThreadResumptions — machine-local record that a mirrored thread was
 * continued locally as a new thread (M5.5 d). Never mirrored: the link only
 * affects THIS machine's mirrored-thread shell, where the source thread's
 * fallback row is superseded while the resumed thread exists (deleting the
 * resumed thread brings the fallback row back). Insert-or-replace: resuming
 * the same source again points it at the newest local thread.
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export class RoamingThreadResumptionError extends Schema.TaggedErrorClass<RoamingThreadResumptionError>()(
  "RoamingThreadResumptionError",
  {
    detail: Schema.optional(Schema.String),
  },
) {}

export class RoamingThreadResumptions extends Context.Service<
  RoamingThreadResumptions,
  {
    readonly record: (
      sourceThreadId: ThreadId,
      resumedThreadId: ThreadId,
    ) => Effect.Effect<void, RoamingThreadResumptionError>;
  }
>()("t3/roaming/RoamingThreadResumptions") {}

export const layer = Layer.effect(
  RoamingThreadResumptions,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const record: RoamingThreadResumptions["Service"]["record"] = (
      sourceThreadId,
      resumedThreadId,
    ) =>
      Effect.gen(function* () {
        const createdAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
        yield* sql`
          INSERT INTO roaming_thread_resumptions (source_thread_id, resumed_thread_id, created_at)
          VALUES (${sourceThreadId}, ${resumedThreadId}, ${createdAt})
          ON CONFLICT(source_thread_id) DO UPDATE SET
            resumed_thread_id = excluded.resumed_thread_id,
            created_at = excluded.created_at
        `;
      }).pipe(
        Effect.mapError((cause) => new RoamingThreadResumptionError({ detail: String(cause) })),
      );

    return { record } satisfies RoamingThreadResumptions["Service"];
  }),
);
