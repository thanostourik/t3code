/**
 * Roaming HTTP routes.
 *
 * Mirror RPCs (manifest/fetch/push) are peer-to-peer and require the
 * `roaming:mirror` scope carried by the D4 machine credential. Enrollment
 * RPCs are local user actions and require `orchestration:operate`. Every
 * route 404s while the `roaming` server setting is off, so a disabled
 * server does not advertise the feature at all.
 */
import {
  AuthOrchestrationOperateScope,
  AuthRoamingMirrorScope,
  type AuthEnvironmentScope,
  ROAMING_ENROLL_PROJECT_PATH,
  ROAMING_MACHINE_CREDENTIAL_PATH,
  ROAMING_MIRROR_FETCH_PATH,
  ROAMING_MIRROR_MANIFEST_PATH,
  ROAMING_MIRROR_PUSH_PATH,
  ROAMING_PEERS_PATH,
  RoamingAddPeerRequest,
  RoamingAddPeerResponse,
  RoamingEnrollProjectRequest,
  RoamingEnrollProjectResponse,
  RoamingFetchBlobsRequest,
  RoamingFetchBlobsResponse,
  RoamingMachineCredentialRequest,
  RoamingMachineCredentialResponse,
  RoamingPushBlobsRequest,
  RoamingPushBlobsResponse,
  RoamingSyncManifestRequest,
  RoamingSyncManifestResponse,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { RoamingBlobStore } from "./RoamingBlobStore.ts";
import { RoamingService } from "./RoamingService.ts";

class RoamingRouteRejection extends Schema.TaggedErrorClass<RoamingRouteRejection>()(
  "RoamingRouteRejection",
  { status: Schema.Int, body: Schema.String },
) {}

const reject = (status: number, body: string) => new RoamingRouteRejection({ status, body });

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
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* auth.authenticateHttpRequest(request).pipe(
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, () =>
        reject(401, "Unauthorized"),
      ),
      Effect.mapError((error) =>
        Schema.is(RoamingRouteRejection)(error) ? error : reject(500, "Internal Server Error"),
      ),
    );
    if (!session.scopes.includes(scope)) {
      return yield* reject(403, "Forbidden");
    }
    return session;
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
      Schema.is(RoamingRouteRejection)(error) ? error : reject(500, "Internal Server Error"),
    ),
  );

const handleRejection = <A, R>(
  effect: Effect.Effect<A, RoamingRouteRejection, R>,
): Effect.Effect<A | HttpServerResponse.HttpServerResponse, never, R> =>
  effect.pipe(
    Effect.catchTag("RoamingRouteRejection", (rejection) =>
      Effect.succeed(
        HttpServerResponse.text(rejection.body, { status: rejection.status }),
      ),
    ),
  );

const manifestRoute = HttpRouter.add(
  "POST",
  ROAMING_MIRROR_MANIFEST_PATH,
  handleRejection(
    Effect.gen(function* () {
      yield* requireRoamingScope(AuthRoamingMirrorScope);
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
      yield* requireRoamingScope(AuthRoamingMirrorScope);
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
      yield* requireRoamingScope(AuthRoamingMirrorScope);
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
        const outcome = yield* blobStore.applyRemote(blob).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("roaming: rejected pushed blob", { cause }).pipe(
              Effect.as("stale" as const),
            ),
          ),
        );
        results.push({ kind: blob.kind, key: blob.key, outcome });
      }
      return yield* respondJson(RoamingPushBlobsResponse, { results });
    }),
  ),
);

const machineCredentialRoute = HttpRouter.add(
  "POST",
  ROAMING_MACHINE_CREDENTIAL_PATH,
  handleRejection(
    Effect.gen(function* () {
      yield* requireRoamingScope(AuthOrchestrationOperateScope);
      const body = yield* decodeBody(RoamingMachineCredentialRequest);
      const roamingService = yield* RoamingService;
      const response = yield* roamingService
        .mintMachineCredential({
          callerEnvironmentId: body.environmentId,
          callerBaseUrls: body.baseUrls,
        })
        .pipe(Effect.mapError(() => reject(500, "Internal Server Error")));
      return yield* respondJson(RoamingMachineCredentialResponse, response);
    }),
  ),
);

const addPeerRoute = HttpRouter.add(
  "POST",
  ROAMING_PEERS_PATH,
  handleRejection(
    Effect.gen(function* () {
      yield* requireRoamingScope(AuthOrchestrationOperateScope);
      const body = yield* decodeBody(RoamingAddPeerRequest);
      const roamingService = yield* RoamingService;
      const peer = yield* roamingService.addPeer(body).pipe(
        Effect.mapError((error) =>
          error.reason === "peer-unreachable"
            ? reject(502, "Peer unreachable")
            : reject(500, "Internal Server Error"),
        ),
      );
      return yield* respondJson(RoamingAddPeerResponse, { peer });
    }),
  ),
);

const enrollProjectRoute = HttpRouter.add(
  "POST",
  ROAMING_ENROLL_PROJECT_PATH,
  handleRejection(
    Effect.gen(function* () {
      yield* requireRoamingScope(AuthOrchestrationOperateScope);
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

export const roamingRoutesLayer = Layer.mergeAll(
  manifestRoute,
  fetchRoute,
  pushRoute,
  machineCredentialRoute,
  addPeerRoute,
  enrollProjectRoute,
);
