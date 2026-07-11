/**
 * Roaming HTTP routes.
 *
 * Mirror RPCs (manifest/fetch/push) are peer-to-peer and require the
 * `roaming:mirror` scope carried by the D4 machine credential. Enrollment
 * RPCs mint credentials and register peers — device management — so they
 * require the administrative `access:write` scope, which standard client
 * sessions do not hold. Routes 404 while the `roaming` server setting is
 * off, so a disabled server does not advertise the feature — EXCEPT the two
 * unified-pairing routes (peers, machine-credential): pairing is what turns
 * the setting on (M2.5), so a fresh machine must be able to answer them.
 */
import {
  AuthAccessWriteScope,
  AuthRoamingMirrorScope,
  type AuthEnvironmentScope,
  ROAMING_CONFLICT_GET_PATH,
  ROAMING_CONFLICT_RESOLVE_PATH,
  ROAMING_ENROLL_PROJECT_PATH,
  ROAMING_MACHINE_CREDENTIAL_PATH,
  ROAMING_MATERIALIZE_PATH,
  ROAMING_WIP_TAKEOVER_PATH,
  ROAMING_MIRROR_FETCH_PATH,
  ROAMING_MIRROR_MANIFEST_PATH,
  ROAMING_MIRROR_PUSH_PATH,
  ROAMING_MIRROR_WAIT_PATH,
  ROAMING_PEERS_LIST_PATH,
  ROAMING_PEERS_PATH,
  ROAMING_HANDSHAKE_COMPLETE_PATH,
  ROAMING_PEERS_REMOVE_PATH,
  ROAMING_PEERS_SYNC_PATH,
  RoamingAddPeerRequest,
  RoamingListPeersResponse,
  RoamingConflictGetRequest,
  RoamingConflictGetResponse,
  RoamingConflictResolveRequest,
  RoamingConflictResolveResponse,
  RoamingEnrollProjectRequest,
  RoamingEnrollProjectResponse,
  RoamingFetchBlobsRequest,
  RoamingFetchBlobsResponse,
  RoamingMachineCredentialRequest,
  RoamingMachineCredentialResponse,
  RoamingMaterializeRequest,
  RoamingMaterializeResponse,
  RoamingPairMachineResponse,
  RoamingPushBlobsRequest,
  RoamingRemovePeerRequest,
  RoamingRemovePeerResponse,
  RoamingSetPeerSyncRequest,
  RoamingSetPeerSyncResponse,
  RoamingPushBlobsResponse,
  RoamingSyncManifestRequest,
  RoamingSyncManifestResponse,
  RoamingWaitChangesRequest,
  RoamingWaitChangesResponse,
  RoamingWipTakeoverRequest,
  RoamingWipTakeoverResponse,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { Materializer } from "./Materializer.ts";
import { RoamingPeers, roamingPeerSecretName } from "./RoamingPeers.ts";
import { RoamingBlobStore } from "./RoamingBlobStore.ts";
import { RoamingService } from "./RoamingService.ts";
import { WipSnapshotReactor } from "./WipSnapshotReactor.ts";

class RoamingRouteRejection extends Schema.TaggedErrorClass<RoamingRouteRejection>()(
  "RoamingRouteRejection",
  { status: Schema.Int, body: Schema.String },
) {}

const isRoamingRouteRejection = Schema.is(RoamingRouteRejection);
const reject = (status: number, body: string) => new RoamingRouteRejection({ status, body });

/** Same treatment as the auth routes give every credential response. */
const CREDENTIAL_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
} as const;

/** 401/403 on auth failures; no roaming-setting gate (pairing routes). */
const requireScope = (scope: AuthEnvironmentScope) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* auth.authenticateHttpRequest(request).pipe(
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, () =>
        reject(401, "Unauthorized"),
      ),
      Effect.mapError((error) =>
        isRoamingRouteRejection(error) ? error : reject(500, "Internal Server Error"),
      ),
    );
    if (!session.scopes.includes(scope)) {
      return yield* reject(403, "Forbidden");
    }
    return session;
  });

/** 404 while the roaming setting is off; 401/403 on auth failures. */
const requireRoamingScope = (scope: AuthEnvironmentScope) =>
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService.pipe(
      Effect.flatMap((service) => service.getSettings),
      Effect.mapError(() => reject(500, "Internal Server Error")),
    );
    if (!settings.roaming) {
      return yield* reject(404, "Not Found");
    }
    return yield* requireScope(scope);
  });

const decodeBody = <S extends Schema.Top>(schema: S) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const raw = yield* request.json.pipe(Effect.mapError(() => reject(400, "Bad Request")));
    return yield* Schema.decodeUnknownEffect(schema)(raw).pipe(
      Effect.mapError(() => reject(400, "Bad Request")),
    );
  });

const respondJson = <S extends Schema.Top>(schema: S, value: S["Type"]) =>
  Schema.encodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() => reject(500, "Internal Server Error")),
    Effect.flatMap((encoded) => HttpServerResponse.json(encoded)),
    Effect.mapError((error) =>
      isRoamingRouteRejection(error) ? error : reject(500, "Internal Server Error"),
    ),
  );

const handleRejection = <A, R>(
  effect: Effect.Effect<A, RoamingRouteRejection, R>,
): Effect.Effect<A | HttpServerResponse.HttpServerResponse, never, R> =>
  effect.pipe(
    Effect.catchTag("RoamingRouteRejection", (rejection) =>
      Effect.succeed(HttpServerResponse.text(rejection.body, { status: rejection.status })),
    ),
  );

/**
 * Inbound half of the sync pause: a mirror session's subject names its peer
 * (`roaming-peer:<environmentId>`); while that peer's sync is off, its
 * passes are rejected — the credential itself stays valid for when the
 * user re-enables sync.
 */
const rejectPausedPeer = (session: { readonly subject: string }) =>
  Effect.gen(function* () {
    const match = /^roaming-peer:(.+)$/.exec(session.subject);
    if (match === null) return;
    const peers = yield* RoamingPeers;
    const peer = (yield* peers.list().pipe(Effect.orElseSucceed(() => []))).find(
      (candidate) => candidate.environmentId === match[1],
    );
    if (peer !== undefined && !peer.syncEnabled) {
      return yield* reject(403, "Sync is turned off for this machine");
    }
  });

const manifestRoute = HttpRouter.add(
  "POST",
  ROAMING_MIRROR_MANIFEST_PATH,
  handleRejection(
    Effect.gen(function* () {
      const session = yield* requireRoamingScope(AuthRoamingMirrorScope);
      yield* rejectPausedPeer(session);
      yield* decodeBody(RoamingSyncManifestRequest);
      const blobStore = yield* RoamingBlobStore;
      const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
      const manifest = yield* blobStore
        .manifest()
        .pipe(Effect.mapError(() => reject(500, "Internal Server Error")));
      return yield* respondJson(RoamingSyncManifestResponse, {
        environmentId: yield* serverEnvironment.getEnvironmentId,
        manifest,
      });
    }),
  ),
);

const fetchRoute = HttpRouter.add(
  "POST",
  ROAMING_MIRROR_FETCH_PATH,
  handleRejection(
    Effect.gen(function* () {
      const session = yield* requireRoamingScope(AuthRoamingMirrorScope);
      yield* rejectPausedPeer(session);
      const body = yield* decodeBody(RoamingFetchBlobsRequest);
      const blobStore = yield* RoamingBlobStore;
      const blobs = yield* blobStore
        .getMany(body.refs)
        .pipe(Effect.mapError(() => reject(500, "Internal Server Error")));
      return yield* respondJson(RoamingFetchBlobsResponse, { blobs });
    }),
  ),
);

const pushRoute = HttpRouter.add(
  "POST",
  ROAMING_MIRROR_PUSH_PATH,
  handleRejection(
    Effect.gen(function* () {
      const session = yield* requireRoamingScope(AuthRoamingMirrorScope);
      yield* rejectPausedPeer(session);
      const body = yield* decodeBody(RoamingPushBlobsRequest);
      const blobStore = yield* RoamingBlobStore;
      const results: Array<{
        kind: (typeof body.blobs)[number]["kind"];
        key: string;
        outcome: "applied" | "stale" | "conflict";
      }> = [];
      for (const blob of body.blobs) {
        // A record failing the integrity gate is reported as stale (not
        // applied) rather than failing the whole batch for honest records.
        const outcome = yield* blobStore
          .applyRemote(blob)
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("roaming: rejected pushed blob", { cause }).pipe(
                Effect.as("stale" as const),
              ),
            ),
          );
        results.push({ kind: blob.kind, key: blob.key, outcome });
        if (blob.kind === "wip") {
          yield* Effect.logInfo("roaming timing: wip-blob-ingested", {
            key: blob.key,
            version: blob.version,
            outcome,
          });
        }
      }
      return yield* respondJson(RoamingPushBlobsResponse, { results });
    }),
  ),
);

/**
 * Long-poll: respond when the blob store's change revision moves past the
 * caller's, or after the hold expires (M3.7). Mirror connectivity is
 * one-directional — the pairing initiator holds the only credential/URL
 * pair — so this is how a machine that cannot reach its peer makes its
 * writes visible in seconds instead of on the peer's interval tick.
 */
const WAIT_HOLD = Duration.seconds(25);

const waitRoute = HttpRouter.add(
  "POST",
  ROAMING_MIRROR_WAIT_PATH,
  handleRejection(
    Effect.gen(function* () {
      const session = yield* requireRoamingScope(AuthRoamingMirrorScope);
      yield* rejectPausedPeer(session);
      const body = yield* decodeBody(RoamingWaitChangesRequest);
      const blobStore = yield* RoamingBlobStore;
      const revision = yield* Effect.scoped(
        Effect.gen(function* () {
          // Subscribe BEFORE reading the revision so a write between the
          // read and the wait cannot be missed.
          const changes = yield* blobStore.subscribeChanges;
          const current = yield* blobStore.changeRevision;
          if (body.sinceRevision === null || body.sinceRevision !== current) {
            return current;
          }
          yield* Effect.race(PubSub.take(changes), Effect.sleep(WAIT_HOLD));
          return yield* blobStore.changeRevision;
        }),
      );
      return yield* respondJson(RoamingWaitChangesResponse, { revision });
    }),
  ),
);

const machineCredentialRoute = HttpRouter.add(
  "POST",
  ROAMING_MACHINE_CREDENTIAL_PATH,
  handleRejection(
    Effect.gen(function* () {
      // Deliberately not gated on the roaming setting: a successful mint is
      // what turns the setting on (pairing is the consent).
      const session = yield* requireScope(AuthAccessWriteScope);
      const body = yield* decodeBody(RoamingMachineCredentialRequest);
      // The handshake session carries the label the user typed on the
      // pairing link ("Laptop") — the user's name always wins over
      // machine-derived names downstream.
      const sessions = yield* SessionStore.SessionStore;
      const sessionLabel = yield* sessions.listActive().pipe(
        Effect.map(
          (active) =>
            active.find((candidate) => candidate.sessionId === session.sessionId)?.client.label,
        ),
        Effect.orElseSucceed(() => undefined),
      );
      const roamingService = yield* RoamingService;
      const response = yield* roamingService
        .mintMachineCredential({
          callerEnvironmentId: body.environmentId,
          callerBaseUrls: body.baseUrls,
          ...(body.syncOptions !== undefined ? { syncOptions: body.syncOptions } : {}),
          ...(body.callerLabel !== undefined ? { callerLabel: body.callerLabel } : {}),
          ...(sessionLabel !== undefined ? { sessionLabel } : {}),
        })
        .pipe(Effect.mapError(() => reject(500, "Internal Server Error")));
      return yield* respondJson(RoamingMachineCredentialResponse, response).pipe(
        Effect.map((httpResponse) =>
          HttpServerResponse.setHeaders(httpResponse, CREDENTIAL_RESPONSE_HEADERS),
        ),
      );
    }),
  ),
);

const addPeerRoute = HttpRouter.add(
  "POST",
  ROAMING_PEERS_PATH,
  handleRejection(
    Effect.gen(function* () {
      // Not gated on the roaming setting: a fresh machine pairs before the
      // setting exists; a successful handshake flips it on.
      yield* requireScope(AuthAccessWriteScope);
      const body = yield* decodeBody(RoamingAddPeerRequest);
      const roamingService = yield* RoamingService;
      const result = yield* roamingService
        .addPeer(body)
        .pipe(
          Effect.mapError((error) =>
            error.reason === "credential-rejected"
              ? reject(
                  400,
                  "The other machine did not accept this pairing code. Codes are one-time" +
                    " (logging into the web UI with one also uses it up) — generate a fresh" +
                    " code on that machine and try again.",
                )
              : error.reason === "peer-unreachable"
                ? reject(
                    502,
                    "Could not reach the other machine at that URL. Check the address and" +
                      " that both machines are on the same network or tailnet.",
                  )
                : reject(500, "Internal Server Error"),
          ),
        );
      // The response carries a bearer token; same no-store treatment as
      // every auth credential response.
      return yield* respondJson(RoamingPairMachineResponse, result).pipe(
        Effect.map((httpResponse) =>
          HttpServerResponse.setHeaders(httpResponse, CREDENTIAL_RESPONSE_HEADERS),
        ),
      );
    }),
  ),
);

const listPeersRoute = HttpRouter.add(
  "POST",
  ROAMING_PEERS_LIST_PATH,
  handleRejection(
    Effect.gen(function* () {
      // Un-gated like the other pairing routes: the per-environment sync
      // controls must render truthfully even while roaming is off.
      yield* requireScope(AuthAccessWriteScope);
      const peers = yield* RoamingPeers.pipe(
        Effect.flatMap((service) => service.list()),
        Effect.mapError(() => reject(500, "Internal Server Error")),
      );
      return yield* respondJson(RoamingListPeersResponse, { peers });
    }),
  ),
);

const removePeerRoute = HttpRouter.add(
  "POST",
  ROAMING_PEERS_REMOVE_PATH,
  handleRejection(
    Effect.gen(function* () {
      yield* requireScope(AuthAccessWriteScope);
      const body = yield* decodeBody(RoamingRemovePeerRequest);
      const peers = yield* RoamingPeers;
      const secretStore = yield* ServerSecretStore;
      const removed = yield* peers
        .remove(body.environmentId)
        .pipe(Effect.mapError(() => reject(500, "Internal Server Error")));
      // Dropping the stored credential stops OUR outbound mirror passes...
      yield* secretStore.remove(roamingPeerSecretName(body.environmentId)).pipe(Effect.ignore);
      // ...and revoking every mirror session minted FOR that peer stops its
      // inbound ones — otherwise the other machine keeps syncing until the
      // credential TTL (codex review P1). Subject match also sweeps
      // credentials orphaned by re-pairing. Best-effort: a failure here
      // must not strand the removal.
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      yield* auth.listSessions().pipe(
        Effect.flatMap((sessions) =>
          Effect.forEach(
            sessions.filter((session) => session.subject === `roaming-peer:${body.environmentId}`),
            (session) => auth.revokeSession(session.sessionId).pipe(Effect.ignore),
            { discard: true },
          ),
        ),
        Effect.ignore,
      );
      return yield* respondJson(RoamingRemovePeerResponse, { removed });
    }),
  ),
);

const setPeerSyncRoute = HttpRouter.add(
  "POST",
  ROAMING_PEERS_SYNC_PATH,
  handleRejection(
    Effect.gen(function* () {
      yield* requireScope(AuthAccessWriteScope);
      const body = yield* decodeBody(RoamingSetPeerSyncRequest);
      const peers = yield* RoamingPeers;
      const changed = yield* peers
        .setSyncEnabled(body.environmentId, body.syncEnabled)
        .pipe(Effect.mapError(() => reject(500, "Internal Server Error")));
      if (!changed) {
        return yield* reject(404, "No pairing exists for that machine");
      }
      const peer =
        (yield* peers.list().pipe(Effect.orElseSucceed(() => []))).find(
          (candidate) => candidate.environmentId === body.environmentId,
        ) ?? null;
      return yield* respondJson(RoamingSetPeerSyncResponse, { peer });
    }),
  ),
);

const handshakeCompleteRoute = HttpRouter.add(
  "POST",
  ROAMING_HANDSHAKE_COMPLETE_PATH,
  handleRejection(
    Effect.gen(function* () {
      // Deliberate self-revocation: the generic revoke endpoint forbids
      // revoking the calling session, but retiring the privileged handshake
      // session is this route's entire purpose. The caller must already
      // hold access:write, so this grants nothing it could not do to any
      // OTHER session.
      const session = yield* requireScope(AuthAccessWriteScope);
      const sessions = yield* SessionStore.SessionStore;
      yield* sessions.revoke(session.sessionId).pipe(Effect.ignore);
      return yield* respondJson(RoamingRemovePeerResponse, { removed: true });
    }),
  ),
);

const enrollProjectRoute = HttpRouter.add(
  "POST",
  ROAMING_ENROLL_PROJECT_PATH,
  handleRejection(
    Effect.gen(function* () {
      yield* requireRoamingScope(AuthAccessWriteScope);
      const body = yield* decodeBody(RoamingEnrollProjectRequest);
      const roamingService = yield* RoamingService;
      const workspaceProjectId = yield* roamingService.enrollProject(body.projectId).pipe(
        Effect.mapError((error) => {
          switch (error.reason) {
            case "project-not-found":
              return reject(404, "Project not found");
            case "no-git-remote":
              return reject(409, "Project has no usable git remote");
            default:
              return reject(500, "Internal Server Error");
          }
        }),
      );
      return yield* respondJson(RoamingEnrollProjectResponse, { workspaceProjectId });
    }),
  ),
);

const materializeRoute = HttpRouter.add(
  "POST",
  ROAMING_MATERIALIZE_PATH,
  handleRejection(
    Effect.gen(function* () {
      yield* requireRoamingScope(AuthAccessWriteScope);
      const body = yield* decodeBody(RoamingMaterializeRequest);
      const materializer = yield* Materializer;
      const materialization = yield* materializer
        .materialize(body)
        .pipe(Effect.mapError(() => reject(500, "Internal Server Error")));
      return yield* respondJson(RoamingMaterializeResponse, { materialization });
    }),
  ),
);

const wipTakeoverRoute = HttpRouter.add(
  "POST",
  ROAMING_WIP_TAKEOVER_PATH,
  handleRejection(
    Effect.gen(function* () {
      yield* requireRoamingScope(AuthAccessWriteScope);
      const body = yield* decodeBody(RoamingWipTakeoverRequest);
      const reactor = yield* WipSnapshotReactor;
      return yield* respondJson(RoamingWipTakeoverResponse, {
        applied: yield* reactor.takeover(body.workspaceProjectId),
      });
    }),
  ),
);

const conflictGetRoute = HttpRouter.add(
  "POST",
  ROAMING_CONFLICT_GET_PATH,
  handleRejection(
    Effect.gen(function* () {
      yield* requireRoamingScope(AuthAccessWriteScope);
      const body = yield* decodeBody(RoamingConflictGetRequest);
      const blobStore = yield* RoamingBlobStore;
      const conflicts = yield* blobStore
        .listConflicts()
        .pipe(Effect.mapError(() => reject(500, "Internal Server Error")));
      const conflict = conflicts.find(
        (candidate) => candidate.kind === body.ref.kind && candidate.key === body.ref.key,
      );
      if (conflict === undefined) {
        return yield* reject(404, "Conflict not found");
      }
      const local = yield* blobStore
        .get(body.ref)
        .pipe(Effect.mapError(() => reject(500, "Internal Server Error")));
      if (local === null) {
        return yield* reject(404, "Local record not found");
      }
      return yield* respondJson(RoamingConflictGetResponse, { conflict, local });
    }),
  ),
);

const conflictResolveRoute = HttpRouter.add(
  "POST",
  ROAMING_CONFLICT_RESOLVE_PATH,
  handleRejection(
    Effect.gen(function* () {
      yield* requireRoamingScope(AuthAccessWriteScope);
      const body = yield* decodeBody(RoamingConflictResolveRequest);
      const blobStore = yield* RoamingBlobStore;
      const conflicts = yield* blobStore
        .listConflicts()
        .pipe(Effect.mapError(() => reject(500, "Internal Server Error")));
      const conflict = conflicts.find(
        (candidate) => candidate.kind === body.ref.kind && candidate.key === body.ref.key,
      );
      if (conflict === undefined) {
        return yield* reject(404, "Conflict not found");
      }
      const local = yield* blobStore
        .get(body.ref)
        .pipe(Effect.mapError(() => reject(500, "Internal Server Error")));
      if (local === null) {
        return yield* reject(404, "Local record not found");
      }
      const picked = body.pick === "local" ? local : conflict.remote;
      const record = yield* blobStore
        .writeLocal({
          kind: picked.kind,
          key: picked.key,
          workspaceProjectId: conflict.workspaceProjectId,
          payload: picked.payload,
        })
        .pipe(Effect.mapError(() => reject(500, "Internal Server Error")));
      return yield* respondJson(RoamingConflictResolveResponse, { record });
    }),
  ),
);

export const roamingRoutesLayer = Layer.mergeAll(
  manifestRoute,
  fetchRoute,
  pushRoute,
  waitRoute,
  machineCredentialRoute,
  addPeerRoute,
  listPeersRoute,
  removePeerRoute,
  setPeerSyncRoute,
  handshakeCompleteRoute,
  enrollProjectRoute,
  materializeRoute,
  wipTakeoverRoute,
  conflictGetRoute,
  conflictResolveRoute,
);
