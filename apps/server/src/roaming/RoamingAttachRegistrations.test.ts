import { EnvironmentId, RoamingAttachRegistration } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  RoamingAttachRegistrations,
  layer as registrationsLayer,
  roamingAttachSecretName,
} from "./RoamingAttachRegistrations.ts";

const PEER_ENVIRONMENT_ID = EnvironmentId.make("env-initiator");
const decodeRegistration = Schema.decodeUnknownSync(RoamingAttachRegistration);

const registration = (overrides?: Partial<RoamingAttachRegistration>): RoamingAttachRegistration =>
  decodeRegistration({
    environmentId: PEER_ENVIRONMENT_ID,
    label: "Desktop",
    baseUrls: ["http://192.168.1.10:14800", "http://127.0.0.1:14800"],
    token: "attach-token-1",
    expiresAt: null,
    ...overrides,
  });

const makeSecretStoreLayer = (secrets: Ref.Ref<ReadonlyMap<string, Uint8Array>>) =>
  Layer.succeed(ServerSecretStore, {
    get: (name) =>
      Ref.get(secrets).pipe(Effect.map((map) => Option.fromUndefinedOr(map.get(name)))),
    set: (name, value) => Ref.update(secrets, (map) => new Map([...map, [name, value]] as const)),
    create: () => Effect.die("unused"),
    getOrCreateRandom: () => Effect.die("unused"),
    remove: (name) =>
      Ref.update(secrets, (map) => {
        const next = new Map(map);
        next.delete(name);
        return next;
      }),
  } satisfies ServerSecretStore["Service"]);

const withStore = <A, E>(
  body: (
    store: RoamingAttachRegistrations["Service"],
    secrets: Ref.Ref<ReadonlyMap<string, Uint8Array>>,
  ) => Effect.Effect<A, E, never>,
) =>
  Effect.gen(function* () {
    const secrets = yield* Ref.make<ReadonlyMap<string, Uint8Array>>(new Map());
    const testLayer = registrationsLayer.pipe(
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(makeSecretStoreLayer(secrets)),
    );
    return yield* RoamingAttachRegistrations.pipe(
      Effect.flatMap((store) => body(store, secrets)),
      Effect.provide(testLayer),
    );
  });

it.effect("upsert + list round-trips the registration with its token", () =>
  withStore((store) =>
    Effect.gen(function* () {
      yield* store.upsert(registration());
      assert.deepStrictEqual(yield* store.list(), [registration()]);

      // Refresh replaces in place — one row per environment.
      yield* store.upsert(registration({ label: "Desktop 2", token: "attach-token-2" }));
      const refreshed = yield* store.list();
      assert.lengthOf(refreshed, 1);
      assert.strictEqual(refreshed[0]!.label, "Desktop 2");
      assert.strictEqual(refreshed[0]!.token, "attach-token-2");
    }),
  ),
);

it.effect("remove drops the row and the stored token", () =>
  withStore((store, secrets) =>
    Effect.gen(function* () {
      yield* store.upsert(registration());
      assert.isTrue(yield* store.remove(PEER_ENVIRONMENT_ID));
      assert.deepStrictEqual(yield* store.list(), []);
      const stored = yield* Ref.get(secrets);
      assert.isFalse(stored.has(roamingAttachSecretName(PEER_ENVIRONMENT_ID)));
      // Idempotent: a second remove reports nothing existed.
      assert.isFalse(yield* store.remove(PEER_ENVIRONMENT_ID));
    }),
  ),
);

it.effect("a row whose secret is missing is skipped, never handed out tokenless", () =>
  withStore((store, secrets) =>
    Effect.gen(function* () {
      yield* store.upsert(registration());
      yield* Ref.set(secrets, new Map());
      assert.deepStrictEqual(yield* store.list(), []);
    }),
  ),
);
