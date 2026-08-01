import {
  AuthAccessWriteScope,
  AuthStandardClientScopes,
  EnvironmentId,
  ROAMING_ATTACH_REGISTRATION_PATH,
  ROAMING_MACHINE_CREDENTIAL_PATH,
} from "@t3tools/contracts";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { PeerMirror } from "./PeerMirror.ts";
import { RoamingBlobStore } from "./RoamingBlobStore.ts";
import { RoamingPeers, roamingPeerSecretName } from "./RoamingPeers.ts";
import { RoamingService, layer as RoamingServiceLayer } from "./RoamingService.ts";
import * as Stream from "effect/Stream";

const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("env-local");
const PEER_ENVIRONMENT_ID = EnvironmentId.make("env-peer");
const PEER_BASE_URL = "http://peer.test:14802";
const ADMIN_CODE = "pairing-code-admin";
const STANDARD_CODE = "pairing-code-standard";
const MINTED_ATTACH_CODE = "pairing-code-minted-attach";
const HANDSHAKE_TOKEN = "bearer-handshake";
const ATTACH_TOKEN = "bearer-attach";
const MACHINE_TOKEN = "machine-credential-token";
const ISSUED_SESSION_TOKEN = "locally-issued-session-token";

const jsonResponse = (request: HttpClientRequest.HttpClientRequest, body: unknown, status = 200) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );

const requestBodyText = (request: HttpClientRequest.HttpClientRequest) =>
  new TextDecoder().decode((request.body as HttpBody.Uint8Array).body);

/**
 * A fake peer server: /oauth/token exchanges the admin/standard/minted
 * codes (one-time), the machine-credential and pairing-token routes demand
 * the handshake bearer, and /.well-known serves the descriptor.
 */
const makePeerHttpLayer = (options: {
  readonly grantedScopes: ReadonlyArray<string>;
  readonly machineCredentialStatus?: number;
}) =>
  Effect.gen(function* () {
    const consumedCodes = yield* Ref.make<ReadonlyArray<string>>([]);
    const mintedAttachCodes = yield* Ref.make(0);
    const attachRegistrations = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const layer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request, url) =>
        Effect.gen(function* () {
          if (url.pathname === "/.well-known/t3/environment") {
            return jsonResponse(request, {
              environmentId: PEER_ENVIRONMENT_ID,
              label: "Test Desktop",
            });
          }
          if (url.pathname === "/oauth/token") {
            const form = new URLSearchParams(requestBodyText(request));
            const code = form.get("subject_token") ?? "";
            if (form.has("scope")) {
              return jsonResponse(request, { error: "scope must not be requested" }, 400);
            }
            const consumed = yield* Ref.get(consumedCodes);
            if (consumed.includes(code)) {
              return jsonResponse(request, { error: "consumed" }, 401);
            }
            yield* Ref.update(consumedCodes, (codes) => [...codes, code]);
            if (code === ADMIN_CODE || code === STANDARD_CODE) {
              return jsonResponse(request, {
                access_token: HANDSHAKE_TOKEN,
                token_type: "Bearer",
                expires_in: 3600,
                scope: options.grantedScopes.join(" "),
              });
            }
            if (code === MINTED_ATTACH_CODE) {
              return jsonResponse(request, {
                access_token: ATTACH_TOKEN,
                token_type: "Bearer",
                expires_in: 3600,
                scope: AuthStandardClientScopes.join(" "),
              });
            }
            return jsonResponse(request, { error: "unknown code" }, 401);
          }
          if (request.headers["authorization"] !== `Bearer ${HANDSHAKE_TOKEN}`) {
            return jsonResponse(request, { error: "unauthorized" }, 401);
          }
          if (url.pathname === ROAMING_MACHINE_CREDENTIAL_PATH) {
            const status = options.machineCredentialStatus ?? 200;
            if (status !== 200) {
              return jsonResponse(request, { error: "not found" }, status);
            }
            return jsonResponse(request, {
              environmentId: PEER_ENVIRONMENT_ID,
              token: MACHINE_TOKEN,
              expiresAt: null,
            });
          }
          if (url.pathname === "/api/auth/pairing-token") {
            yield* Ref.update(mintedAttachCodes, (count) => count + 1);
            return jsonResponse(request, {
              id: "minted-attach",
              credential: MINTED_ATTACH_CODE,
              expiresAt: "2099-01-01T00:00:00.000Z",
            });
          }
          if (url.pathname === ROAMING_ATTACH_REGISTRATION_PATH) {
            yield* Ref.update(attachRegistrations, (bodies) => [
              ...bodies,
              JSON.parse(requestBodyText(request)),
            ]);
            return jsonResponse(request, { registered: true });
          }
          return jsonResponse(request, { error: "unexpected path" }, 500);
        }),
      ),
    );
    return { layer, mintedAttachCodes, attachRegistrations };
  });

// The well-known descriptor rides the same mock; attach-only tests need it.
const makeAttachOnlyHttpLayer = () =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.gen(function* () {
        if (url.pathname === "/oauth/token") {
          const form = new URLSearchParams(requestBodyText(request));
          if (form.get("subject_token") !== STANDARD_CODE) {
            return jsonResponse(request, { error: "unknown code" }, 401);
          }
          return jsonResponse(request, {
            access_token: HANDSHAKE_TOKEN,
            token_type: "Bearer",
            expires_in: 3600,
            scope: AuthStandardClientScopes.join(" "),
          });
        }
        if (url.pathname === "/.well-known/t3/environment") {
          return jsonResponse(request, { environmentId: PEER_ENVIRONMENT_ID });
        }
        return jsonResponse(request, { error: "unexpected path" }, 500);
      }),
    ),
  );

const makeSecretStoreLayer = (store: Ref.Ref<ReadonlyMap<string, Uint8Array>>) =>
  Layer.succeed(ServerSecretStore, {
    get: (name) => Ref.get(store).pipe(Effect.map((map) => Option.fromUndefinedOr(map.get(name)))),
    set: (name, value) => Ref.update(store, (map) => new Map([...map, [name, value]] as const)),
    create: () => Effect.die("unused"),
    getOrCreateRandom: () => Effect.die("unused"),
    remove: () => Effect.die("unused"),
  } satisfies ServerSecretStore["Service"]);

const makePeersLayer = (rows: Ref.Ref<ReadonlyArray<{ environmentId: string }>>) =>
  Layer.succeed(RoamingPeers, {
    upsert: (peer: { environmentId: string }) => Ref.update(rows, (current) => [...current, peer]),
    ensurePeer: (environmentId: string) =>
      Ref.update(rows, (current) => [...current, { environmentId }]),
    list: () => Ref.get(rows),
    recordContact: () => Effect.die("unused"),
    subscribeChanges: Effect.die("unused") as never,
    // Mirrors the real service's derived gate (D3): on iff a row exists.
    roamingEnabled: Ref.get(rows).pipe(Effect.map((current) => current.length > 0)),
  } as unknown as RoamingPeers["Service"]);

const unusedStubs = Layer.mergeAll(
  Layer.succeed(RoamingBlobStore, {} as unknown as RoamingBlobStore["Service"]),
  Layer.succeed(PeerMirror, {
    start: () => Effect.void,
    syncNow: () => Effect.void,
    syncNowAndWait: () => Effect.void,
  } satisfies PeerMirror["Service"]),
  Layer.succeed(ServerEnvironment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(LOCAL_ENVIRONMENT_ID),
    // The handshake reads its own label to name the sessions it mints.
    getDescriptor: Effect.succeed({ label: "Test Laptop" }) as never,
  }),
  Layer.succeed(OrchestrationEngineService, {
    readEvents: () => Stream.empty,
    latestSequence: Effect.succeed(0),
    streamDomainEvents: Stream.empty,
    dispatch: () => Effect.die("unused"),
  } satisfies OrchestrationEngineService["Service"]),
  Layer.succeed(
    ProjectionProjectRepository,
    {} as unknown as ProjectionProjectRepository["Service"],
  ),
  Layer.succeed(RepositoryIdentityResolver, {} as unknown as RepositoryIdentityResolver["Service"]),
  // M5.6 reverse attach reads the bind host + runtime-state path (the
  // missing file falls back to config.port). A ROUTABLE host: a
  // loopback-only server advertises nothing and skips the reverse half.
  Layer.succeed(ServerConfig, {
    host: "192.168.1.42",
    port: 14800,
    serverRuntimeStatePath: "/nonexistent/server-runtime.json",
  } as unknown as ServerConfig["Service"]),
);

/** Same stubs, but a loopback-only server (network access off). */
const loopbackOnlyStubs = Layer.mergeAll(
  unusedStubs,
  Layer.succeed(ServerConfig, {
    host: "127.0.0.1",
    port: 14800,
    serverRuntimeStatePath: "/nonexistent/server-runtime.json",
  } as unknown as ServerConfig["Service"]),
);

const makeAuthLayer = (issued: Ref.Ref<ReadonlyArray<{ scopes: ReadonlyArray<string> }>>) =>
  Layer.succeed(EnvironmentAuth, {
    issueSession: (input?: { readonly scopes?: ReadonlyArray<string> }) =>
      Ref.update(issued, (calls) => [...calls, { scopes: input?.scopes ?? [] }]).pipe(
        Effect.flatMap(() => DateTime.now),
        Effect.map((now) => ({
          token: ISSUED_SESSION_TOKEN,
          expiresAt: now,
          sessionId: "session-1",
        })),
      ),
  } as unknown as EnvironmentAuth["Service"]);

const runAddPeer = (input: {
  readonly httpLayer: Layer.Layer<HttpClient.HttpClient>;
  readonly syncOptions?: { readonly secretsSync?: boolean };
  /** Swap in the loopback-only ServerConfig (network access off). */
  readonly stubs?: typeof unusedStubs;
}) =>
  Effect.gen(function* () {
    const secrets = yield* Ref.make<ReadonlyMap<string, Uint8Array>>(new Map());
    const peerRows = yield* Ref.make<ReadonlyArray<{ environmentId: string }>>([]);
    const issued = yield* Ref.make<ReadonlyArray<{ scopes: ReadonlyArray<string> }>>([]);
    const settingsLayer = ServerSettingsService.layerTest();
    const testLayer = RoamingServiceLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          input.httpLayer,
          settingsLayer,
          makeSecretStoreLayer(secrets),
          makePeersLayer(peerRows),
          makeAuthLayer(issued),
          input.stubs ?? unusedStubs,
        ),
      ),
      // The settings assertions read through the same test settings service.
      Layer.provideMerge(settingsLayer),
      Layer.provideMerge(NodeServices.layer),
    );
    return yield* Effect.gen(function* () {
      const service = yield* RoamingService;
      const result = yield* service.addPeer({
        baseUrls: [PEER_BASE_URL],
        pairingCredential: ADMIN_CODE,
        ...(input.syncOptions !== undefined ? { syncOptions: input.syncOptions } : {}),
      });
      const settings = yield* ServerSettingsService.pipe(
        Effect.flatMap((settingsService) => settingsService.getSettings),
      );
      return {
        result,
        settings,
        secrets: yield* Ref.get(secrets),
        peerRows: yield* Ref.get(peerRows),
      };
    }).pipe(Effect.provide(testLayer));
  });

describe("RoamingService unified pairing handshake", () => {
  it.effect("full handshake: mirror established, standard attach bearer derived", () =>
    Effect.gen(function* () {
      const peer = yield* makePeerHttpLayer({
        grantedScopes: [...AuthStandardClientScopes, AuthAccessWriteScope],
      });
      const { result, settings, secrets, peerRows } = yield* runAddPeer({
        httpLayer: peer.layer,
        syncOptions: { secretsSync: true },
      });

      assert.isNotNull(result.peer);
      assert.strictEqual(result.peer?.environmentId, PEER_ENVIRONMENT_ID);
      assert.isNull(result.mirrorUnavailableReason);
      // The attach bearer is the freshly derived standard one — never the
      // privileged handshake bearer.
      assert.strictEqual(result.attach.token, ATTACH_TOKEN);
      assert.strictEqual(result.attach.baseUrl, PEER_BASE_URL);
      assert.strictEqual(result.attach.environmentId, PEER_ENVIRONMENT_ID);
      assert.strictEqual(yield* Ref.get(peer.mintedAttachCodes), 1);
      assert.strictEqual(
        new TextDecoder().decode(secrets.get(roamingPeerSecretName(PEER_ENVIRONMENT_ID))),
        MACHINE_TOKEN,
      );
      // The peer row IS the on-switch (D3); the dialog's choice applies.
      assert.strictEqual(peerRows.length, 1);
      assert.isTrue(settings.roamingSecretsSync);
    }),
  );

  it.effect("full handshake posts the reverse attach registration to the callee (M5.6)", () =>
    Effect.gen(function* () {
      const peer = yield* makePeerHttpLayer({
        grantedScopes: [...AuthStandardClientScopes, AuthAccessWriteScope],
      });
      yield* runAddPeer({ httpLayer: peer.layer });
      const registrations = yield* Ref.get(peer.attachRegistrations);
      assert.lengthOf(registrations, 1);
      const registration = registrations[0] as {
        environmentId: string;
        label: string;
        baseUrls: ReadonlyArray<string>;
        token: string;
      };
      assert.strictEqual(registration.environmentId, LOCAL_ENVIRONMENT_ID);
      assert.strictEqual(registration.label, "Test Laptop");
      // The routable bind address, at the config port (the runtime-state
      // file is absent in tests).
      assert.deepStrictEqual(registration.baseUrls, ["http://192.168.1.42:14800"]);
      // The registered token is a freshly issued local session, never the
      // handshake or mirror bearer received from the callee.
      assert.strictEqual(registration.token, ISSUED_SESSION_TOKEN);
    }),
  );

  // The 2026-07-31 field bug: a loopback-only server advertised
  // `127.0.0.1`, so the peer's client attached to its OWN backend and sat
  // on a permanent identity mismatch. Advertise nothing instead — pairing
  // degrades to one-directional, exactly as against a pre-M5.6 peer.
  it.effect("loopback-only server registers nothing (and mints no session) for the callee", () =>
    Effect.gen(function* () {
      const peer = yield* makePeerHttpLayer({
        grantedScopes: [...AuthStandardClientScopes, AuthAccessWriteScope],
      });
      const { result } = yield* runAddPeer({
        httpLayer: peer.layer,
        stubs: loopbackOnlyStubs,
      });
      // The forward half is untouched: pairing still succeeds.
      assert.isNotNull(result.peer);
      assert.strictEqual(result.attach.token, ATTACH_TOKEN);
      assert.lengthOf(yield* Ref.get(peer.attachRegistrations), 0);
    }),
  );

  it.effect("attach-only: standard code degrades without mirror or side effects", () =>
    Effect.gen(function* () {
      const { result, settings, secrets, peerRows } = yield* runAddPeerAttachOnly();
      assert.isNull(result.peer);
      assert.strictEqual(result.mirrorUnavailableReason, "credential-not-administrative");
      assert.strictEqual(result.attach.token, HANDSHAKE_TOKEN);
      assert.strictEqual(result.attach.environmentId, PEER_ENVIRONMENT_ID);
      assert.strictEqual(secrets.size, 0);
      // No peer row → roaming stays off (D3).
      assert.strictEqual(peerRows.length, 0);
    }),
  );

  it.effect("re-pairing an already-mirrored peer with a standard code reports the mirror", () =>
    Effect.gen(function* () {
      const { result } = yield* runAddPeerAttachOnly({
        existingPeers: [{ environmentId: PEER_ENVIRONMENT_ID }],
      });
      // The existing credential keeps the mirror alive regardless of this
      // handshake — claiming sync is unavailable would be a lie.
      assert.isNotNull(result.peer);
      assert.isNull(result.mirrorUnavailableReason);
      assert.strictEqual(result.attach.token, HANDSHAKE_TOKEN);
    }),
  );

  it.effect("peer without roaming routes: attach still derived, mirror reported unavailable", () =>
    Effect.gen(function* () {
      const peer = yield* makePeerHttpLayer({
        grantedScopes: [...AuthStandardClientScopes, AuthAccessWriteScope],
        machineCredentialStatus: 404,
      });
      const { result, secrets, peerRows } = yield* runAddPeerWith404(peer.layer);
      assert.isNull(result.peer);
      assert.strictEqual(result.mirrorUnavailableReason, "peer-does-not-support-machine-pairing");
      assert.strictEqual(result.attach.token, ATTACH_TOKEN);
      assert.strictEqual(secrets.size, 0);
      assert.strictEqual(peerRows.length, 0);
    }),
  );

  it.effect("mintMachineCredential applies sync options on first pairing only (G8)", () =>
    Effect.gen(function* () {
      const secrets = yield* Ref.make<ReadonlyMap<string, Uint8Array>>(new Map());
      const peerRows = yield* Ref.make<ReadonlyArray<{ environmentId: string }>>([]);
      const issued = yield* Ref.make<ReadonlyArray<{ scopes: ReadonlyArray<string> }>>([]);
      const settingsLayer = ServerSettingsService.layerTest();
      const testLayer = RoamingServiceLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make(() => Effect.die("unused")),
            ),
            settingsLayer,
            makeSecretStoreLayer(secrets),
            makePeersLayer(peerRows),
            makeAuthLayer(issued),
            unusedStubs,
          ),
        ),
        Layer.provideMerge(settingsLayer),
        Layer.provideMerge(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const service = yield* RoamingService;
        const settingsService = yield* ServerSettingsService;

        // First pairing (no peers yet): the dialog's choices seed the
        // consents.
        yield* service.mintMachineCredential({
          callerEnvironmentId: PEER_ENVIRONMENT_ID,
          callerBaseUrls: [],
          syncOptions: { secretsSync: true, wipSync: false },
        });
        const first = yield* settingsService.getSettings;
        assert.isTrue(first.roamingSecretsSync);
        assert.isFalse(first.roamingWipSync);

        // Re-pair on a machine that already has a peer: an explicit prior
        // choice is never overridden remotely (G8).
        yield* service.mintMachineCredential({
          callerEnvironmentId: EnvironmentId.make("env-other"),
          callerBaseUrls: [],
          syncOptions: { secretsSync: false, wipSync: true },
        });
        const second = yield* settingsService.getSettings;
        assert.isTrue(second.roamingSecretsSync);
        assert.isFalse(second.roamingWipSync);

        // The mirror credential is least-privilege.
        const issuedCalls = yield* Ref.get(issued);
        assert.deepStrictEqual(issuedCalls[0]?.scopes, ["roaming:mirror"]);
      }).pipe(Effect.provide(testLayer));
    }),
  );
});

const runAddPeerAttachOnly = (options?: {
  readonly existingPeers?: ReadonlyArray<{ environmentId: string }>;
}) =>
  Effect.gen(function* () {
    // An existing peer only counts as a mirror when its credential is
    // stored too — seed both, matching what a completed addPeer leaves.
    const secrets = yield* Ref.make<ReadonlyMap<string, Uint8Array>>(
      new Map(
        (options?.existingPeers ?? []).map((peer) => [
          roamingPeerSecretName(EnvironmentId.make(peer.environmentId)),
          new TextEncoder().encode(MACHINE_TOKEN),
        ]),
      ),
    );
    const peerRows = yield* Ref.make<ReadonlyArray<{ environmentId: string }>>(
      options?.existingPeers ?? [],
    );
    const issued = yield* Ref.make<ReadonlyArray<{ scopes: ReadonlyArray<string> }>>([]);
    const settingsLayer = ServerSettingsService.layerTest();
    const testLayer = RoamingServiceLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          makeAttachOnlyHttpLayer(),
          settingsLayer,
          makeSecretStoreLayer(secrets),
          makePeersLayer(peerRows),
          makeAuthLayer(issued),
          unusedStubs,
        ),
      ),
      Layer.provideMerge(settingsLayer),
      Layer.provideMerge(NodeServices.layer),
    );
    return yield* Effect.gen(function* () {
      const service = yield* RoamingService;
      const result = yield* service.addPeer({
        baseUrls: [PEER_BASE_URL],
        pairingCredential: STANDARD_CODE,
      });
      const settings = yield* ServerSettingsService.pipe(
        Effect.flatMap((settingsService) => settingsService.getSettings),
      );
      return {
        result,
        settings,
        secrets: yield* Ref.get(secrets),
        peerRows: yield* Ref.get(peerRows),
      };
    }).pipe(Effect.provide(testLayer));
  });

const runAddPeerWith404 = (baseLayer: Layer.Layer<HttpClient.HttpClient>) =>
  Effect.gen(function* () {
    const secrets = yield* Ref.make<ReadonlyMap<string, Uint8Array>>(new Map());
    const peerRows = yield* Ref.make<ReadonlyArray<{ environmentId: string }>>([]);
    const issued = yield* Ref.make<ReadonlyArray<{ scopes: ReadonlyArray<string> }>>([]);
    const settingsLayer = ServerSettingsService.layerTest();
    // Wrap the peer mock so the well-known descriptor resolves in the
    // no-roaming-routes sub-case.
    const httpLayer = Layer.effect(
      HttpClient.HttpClient,
      Effect.gen(function* () {
        const inner = yield* HttpClient.HttpClient;
        return HttpClient.make((request, url, signal, fiber) =>
          url.pathname === "/.well-known/t3/environment"
            ? Effect.succeed(jsonResponse(request, { environmentId: PEER_ENVIRONMENT_ID }))
            : (inner.execute(request) as never),
        );
      }),
    ).pipe(Layer.provide(baseLayer));
    const testLayer = RoamingServiceLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          httpLayer,
          settingsLayer,
          makeSecretStoreLayer(secrets),
          makePeersLayer(peerRows),
          makeAuthLayer(issued),
          unusedStubs,
        ),
      ),
      Layer.provideMerge(settingsLayer),
      Layer.provideMerge(NodeServices.layer),
    );
    return yield* Effect.gen(function* () {
      const service = yield* RoamingService;
      const result = yield* service.addPeer({
        baseUrls: [PEER_BASE_URL],
        pairingCredential: ADMIN_CODE,
      });
      return {
        result,
        secrets: yield* Ref.get(secrets),
        peerRows: yield* Ref.get(peerRows),
      };
    }).pipe(Effect.provide(testLayer));
  });
