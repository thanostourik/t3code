/**
 * Raw HTTP calls to the primary server's roaming routes. These routes live
 * outside `EnvironmentHttpApi` on purpose (fork discipline — see the roaming
 * plan), so they can't ride `PrimaryEnvironmentHttpClient`; this module
 * mirrors the auth behavior of `httpLayer.ts` for plain fetch: same-origin
 * browser sends the session cookie, desktop sends the bearer token.
 */
import {
  ROAMING_CONFLICT_GET_PATH,
  ROAMING_CONFLICT_RESOLVE_PATH,
  ROAMING_MATERIALIZE_PATH,
  ROAMING_WIP_DIVERGENCE_PATH,
  ROAMING_WIP_DIVERGENCE_RESOLVE_PATH,
  ROAMING_WIP_TAKEOVER_PATH,
  ROAMING_PEERS_LIST_PATH,
  ROAMING_PEERS_PATH,
  ROAMING_PEERS_REMOVE_PATH,
  ROAMING_PEERS_SYNC_PATH,
  RoamingAddPeerRequest,
  RoamingListPeersResponse,
  RoamingConflictGetRequest,
  RoamingConflictGetResponse,
  RoamingConflictResolveRequest,
  RoamingConflictResolveResponse,
  RoamingMaterializeRequest,
  RoamingMaterializeResponse,
  RoamingPairMachineResponse,
  RoamingRemovePeerRequest,
  RoamingRemovePeerResponse,
  RoamingSetPeerSyncRequest,
  RoamingSetPeerSyncResponse,
  RoamingWipDivergenceRequest,
  RoamingWipDivergenceResolveRequest,
  RoamingWipDivergenceResolveResponse,
  RoamingWipDivergenceResponse,
  RoamingWipTakeoverRequest,
  RoamingWipTakeoverResponse,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { readDesktopPrimaryBearerToken } from "./desktopAuth";
import { isSameOriginBrowserPrimary } from "./httpLayer";
import { resolvePrimaryEnvironmentHttpUrl } from "./target";

export class PrimaryRoamingRequestError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number | null,
    detail: string,
  ) {
    super(`${operation} failed${status === null ? "" : ` (${status})`}: ${detail}`);
    this.name = "PrimaryRoamingRequestError";
  }
}

async function postRoaming<
  Req extends Schema.Top & { readonly EncodingServices: never },
  Res extends Schema.Top & { readonly DecodingServices: never },
>(input: {
  operation: string;
  path: string;
  requestSchema: Req;
  responseSchema: Res;
  body: Req["Type"];
}): Promise<Res["Type"]> {
  const bearerToken = await readDesktopPrimaryBearerToken();
  const encoded = await Effect.runPromise(
    // oxlint-disable-next-line t3code/no-inline-schema-compile -- schema is a generic call input
    Schema.encodeUnknownEffect(input.requestSchema)(input.body),
  );
  let response: Response;
  try {
    response = await fetch(resolvePrimaryEnvironmentHttpUrl(input.path), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
      },
      // Same three cases as httpLayer.ts: same-origin browser rides the
      // session cookie; desktop rides the bearer; cross-origin without a
      // bearer stays anonymous rather than forcing a credentialed preflight.
      credentials: isSameOriginBrowserPrimary() ? "include" : "omit",
      body: JSON.stringify(encoded),
    });
  } catch (error) {
    throw new PrimaryRoamingRequestError(
      input.operation,
      null,
      error instanceof Error ? error.message : "network error",
    );
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new PrimaryRoamingRequestError(
      input.operation,
      response.status,
      detail || response.statusText,
    );
  }
  const json: unknown = await response.json();
  // oxlint-disable-next-line t3code/no-inline-schema-compile -- schemas are generic call inputs
  return Effect.runPromise(Schema.decodeUnknownEffect(input.responseSchema)(json));
}

export function addRoamingPeer(body: RoamingAddPeerRequest): Promise<RoamingPairMachineResponse> {
  return postRoaming({
    operation: "roaming.add-peer",
    path: ROAMING_PEERS_PATH,
    requestSchema: RoamingAddPeerRequest,
    responseSchema: RoamingPairMachineResponse,
    body,
  });
}

const EmptyRequest = Schema.Struct({});

export function listRoamingPeers(): Promise<RoamingListPeersResponse> {
  return postRoaming({
    operation: "roaming.list-peers",
    path: ROAMING_PEERS_LIST_PATH,
    requestSchema: EmptyRequest,
    responseSchema: RoamingListPeersResponse,
    body: {},
  });
}

export function removeRoamingPeer(
  body: RoamingRemovePeerRequest,
): Promise<RoamingRemovePeerResponse> {
  return postRoaming({
    operation: "roaming.remove-peer",
    path: ROAMING_PEERS_REMOVE_PATH,
    requestSchema: RoamingRemovePeerRequest,
    responseSchema: RoamingRemovePeerResponse,
    body,
  });
}

export function setRoamingPeerSync(
  body: RoamingSetPeerSyncRequest,
): Promise<RoamingSetPeerSyncResponse> {
  return postRoaming({
    operation: "roaming.set-peer-sync",
    path: ROAMING_PEERS_SYNC_PATH,
    requestSchema: RoamingSetPeerSyncRequest,
    responseSchema: RoamingSetPeerSyncResponse,
    body,
  });
}

export function materializeRoamingProject(
  body: RoamingMaterializeRequest,
): Promise<RoamingMaterializeResponse> {
  return postRoaming({
    operation: "roaming.materialize",
    path: ROAMING_MATERIALIZE_PATH,
    requestSchema: RoamingMaterializeRequest,
    responseSchema: RoamingMaterializeResponse,
    body,
  });
}

export function takeoverRoamingWip(
  body: RoamingWipTakeoverRequest,
): Promise<RoamingWipTakeoverResponse> {
  return postRoaming({
    operation: "roaming.wip-takeover",
    path: ROAMING_WIP_TAKEOVER_PATH,
    requestSchema: RoamingWipTakeoverRequest,
    responseSchema: RoamingWipTakeoverResponse,
    body,
  });
}

export function getRoamingWipDivergence(
  body: RoamingWipDivergenceRequest,
): Promise<RoamingWipDivergenceResponse> {
  return postRoaming({
    operation: "roaming.wip-divergence",
    path: ROAMING_WIP_DIVERGENCE_PATH,
    requestSchema: RoamingWipDivergenceRequest,
    responseSchema: RoamingWipDivergenceResponse,
    body,
  });
}

export function resolveRoamingWipDivergence(
  body: RoamingWipDivergenceResolveRequest,
): Promise<RoamingWipDivergenceResolveResponse> {
  return postRoaming({
    operation: "roaming.wip-divergence-resolve",
    path: ROAMING_WIP_DIVERGENCE_RESOLVE_PATH,
    requestSchema: RoamingWipDivergenceResolveRequest,
    responseSchema: RoamingWipDivergenceResolveResponse,
    body,
  });
}

export function getRoamingConflict(
  body: RoamingConflictGetRequest,
): Promise<RoamingConflictGetResponse> {
  return postRoaming({
    operation: "roaming.conflict-get",
    path: ROAMING_CONFLICT_GET_PATH,
    requestSchema: RoamingConflictGetRequest,
    responseSchema: RoamingConflictGetResponse,
    body,
  });
}

export function resolveRoamingConflict(
  body: RoamingConflictResolveRequest,
): Promise<RoamingConflictResolveResponse> {
  return postRoaming({
    operation: "roaming.conflict-resolve",
    path: ROAMING_CONFLICT_RESOLVE_PATH,
    requestSchema: RoamingConflictResolveRequest,
    responseSchema: RoamingConflictResolveResponse,
    body,
  });
}
