/**
 * PeerMirror - Background reconciliation of roaming blobs with peer machines.
 *
 * Tries every enrolled peer on startup, on an interval, and after local blob
 * writes (the write trigger is an optimization — startup/interval passes are
 * the delivery guarantee). One direction of connectivity yields bidirectional
 * data flow: a pass exchanges manifests, pushes blobs the peer lacks, and
 * fetches blobs this machine lacks, all under the blob store's
 * reconciliation rule.
 *
 * The reactor always starts and no-ops while roaming is off (no enrolled
 * peers — the derived gate, D3).
 */
import {
  ROAMING_MIRROR_FETCH_PATH,
  ROAMING_MIRROR_MANIFEST_PATH,
  ROAMING_MIRROR_PUSH_PATH,
  ROAMING_MIRROR_WAIT_PATH,
  RoamingBlobManifestEntry,
  type RoamingBlobRef,
  RoamingFetchBlobsRequest,
  RoamingFetchBlobsResponse,
  type RoamingPeer,
  RoamingPushBlobsRequest,
  RoamingPushBlobsResponse,
  RoamingSyncManifestRequest,
  RoamingSyncManifestResponse,
  RoamingWaitChangesRequest,
  RoamingWaitChangesResponse,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { RoamingBlobStore } from "./RoamingBlobStore.ts";
import { RoamingPeers, roamingPeerSecretName } from "./RoamingPeers.ts";

const MIRROR_INTERVAL = Duration.seconds(60);
// Data-path requests (manifest/fetch/push) get a hard deadline: a
// black-holed base URL degrades to a logged failed pass instead of stalling
// the drain loop (and syncNowAndWait callers) for minutes. The wait
// long-poll manages its own WAIT_CLIENT_TIMEOUT instead.
const DATA_REQUEST_TIMEOUT = Duration.seconds(30);
// Long-poll pacing (M3.7): the server holds a wait for 25s (see http.ts);
// the client allows 40s before treating the request as dead, and backs off
// 15s between failed attempts (peer down, paused, or pre-M3.7).
const WAIT_CLIENT_TIMEOUT = Duration.seconds(40);
const WAIT_RETRY_DELAY = Duration.seconds(15);
const WAITER_RECONCILE_INTERVAL = Duration.seconds(30);

export class PeerMirror extends Context.Service<
  PeerMirror,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Request a sync pass soon (coalesced); returns immediately. */
    readonly syncNow: () => Effect.Effect<void>;
    /**
     * Run one full pass NOW and wait for it — for callers that need fresh
     * blobs before proceeding (on-demand materialize from a live peer).
     * Never fails; per-peer failures are logged like any pass.
     */
    readonly syncNowAndWait: () => Effect.Effect<void>;
  }
>()("t3/roaming/PeerMirror") {}

const decodeManifestResponse = Schema.decodeUnknownEffect(RoamingSyncManifestResponse);
const decodeFetchResponse = Schema.decodeUnknownEffect(RoamingFetchBlobsResponse);
const decodePushResponse = Schema.decodeUnknownEffect(RoamingPushBlobsResponse);
const decodeWaitResponse = Schema.decodeUnknownEffect(RoamingWaitChangesResponse);
const encodeManifestRequest = Schema.encodeUnknownEffect(RoamingSyncManifestRequest);
const encodeFetchRequest = Schema.encodeUnknownEffect(RoamingFetchBlobsRequest);
const encodePushRequest = Schema.encodeUnknownEffect(RoamingPushBlobsRequest);
const encodeWaitRequest = Schema.encodeUnknownEffect(RoamingWaitChangesRequest);

class PeerMirrorRequestError extends Schema.TaggedErrorClass<PeerMirrorRequestError>()(
  "PeerMirrorRequestError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

const requestError = (operation: string) => (cause: unknown) =>
  new PeerMirrorRequestError({ operation, cause });

const manifestKey = (entry: { readonly kind: string; readonly key: string }): string =>
  `${entry.kind}\0${entry.key}`;

/**
 * What to move after comparing manifests. Equal-version different-hash
 * entries appear on both sides so both machines record the conflict.
 */
export function diffManifests(
  local: ReadonlyArray<RoamingBlobManifestEntry>,
  remote: ReadonlyArray<RoamingBlobManifestEntry>,
): {
  readonly toFetch: ReadonlyArray<RoamingBlobRef>;
  readonly toPush: ReadonlyArray<RoamingBlobRef>;
} {
  const localByKey = new Map(local.map((entry) => [manifestKey(entry), entry]));
  const remoteByKey = new Map(remote.map((entry) => [manifestKey(entry), entry]));

  const toFetch: RoamingBlobRef[] = [];
  for (const entry of remote) {
    const mine = localByKey.get(manifestKey(entry));
    if (
      mine === undefined ||
      entry.version > mine.version ||
      (entry.version === mine.version && entry.contentHash !== mine.contentHash)
    ) {
      toFetch.push({ kind: entry.kind, key: entry.key });
    }
  }

  const toPush: RoamingBlobRef[] = [];
  for (const entry of local) {
    const theirs = remoteByKey.get(manifestKey(entry));
    if (
      theirs === undefined ||
      entry.version > theirs.version ||
      (entry.version === theirs.version && entry.contentHash !== theirs.contentHash)
    ) {
      toPush.push({ kind: entry.kind, key: entry.key });
    }
  }

  return { toFetch, toPush };
}

const make = Effect.gen(function* () {
  const blobStore = yield* RoamingBlobStore;
  const peers = yield* RoamingPeers;
  const secretStore = yield* ServerSecretStore;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const httpClient = yield* HttpClient.HttpClient;

  // The slot carries the trigger's provenance so a delivery can be
  // attributed to the write-trigger fast path vs the interval tick in the
  // timing logs; coalescing keeps only the latest label, which is fine —
  // the label is diagnostic, not behavioral.
  const trigger = yield* Queue.sliding<string>(1);
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const postJson = (
    token: string,
    baseUrl: string,
    path: string,
    body: unknown,
    timeout?: Duration.Duration,
  ): Effect.Effect<unknown, PeerMirrorRequestError> =>
    httpClient
      .pipe(HttpClient.mapRequest(HttpClientRequest.setHeader("authorization", `Bearer ${token}`)))
      .post(`${baseUrl.replace(/\/$/, "")}${path}`, { body: HttpBody.jsonUnsafe(body) })
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        (effect) => (timeout === undefined ? effect : Effect.timeout(effect, timeout)),
        Effect.mapError(requestError(path)),
      );

  const syncWithPeerAt = (peer: RoamingPeer, token: string, baseUrl: string, source: string) =>
    Effect.gen(function* () {
      const environmentId = yield* serverEnvironment.getEnvironmentId;
      const localManifest = yield* blobStore.manifest();

      const exchangeStartedMs = yield* Clock.currentTimeMillis;
      const manifestBody = yield* encodeManifestRequest({
        environmentId,
        manifest: localManifest,
      }).pipe(Effect.mapError(requestError("encode-manifest")));
      const manifestRaw = yield* postJson(
        token,
        baseUrl,
        ROAMING_MIRROR_MANIFEST_PATH,
        manifestBody,
        DATA_REQUEST_TIMEOUT,
      );
      const manifestResponse = yield* decodeManifestResponse(manifestRaw).pipe(
        Effect.mapError(requestError("decode-manifest")),
      );

      const { toFetch, toPush } = diffManifests(localManifest, manifestResponse.manifest);
      if (toFetch.length > 0 || toPush.length > 0) {
        const manifestDoneMs = yield* Clock.currentTimeMillis;
        yield* Effect.logInfo("roaming timing: mirror-exchange", {
          peer: peer.environmentId,
          source,
          manifestMs: manifestDoneMs - exchangeStartedMs,
          toPush: toPush.map((ref) => `${ref.kind}:${ref.key}`),
          toFetch: toFetch.map((ref) => `${ref.kind}:${ref.key}`),
        });
      }

      if (toFetch.length > 0) {
        const fetchBody = yield* encodeFetchRequest({ refs: toFetch }).pipe(
          Effect.mapError(requestError("encode-fetch")),
        );
        const fetched = yield* decodeFetchResponse(
          yield* postJson(
            token,
            baseUrl,
            ROAMING_MIRROR_FETCH_PATH,
            fetchBody,
            DATA_REQUEST_TIMEOUT,
          ),
        ).pipe(Effect.mapError(requestError("decode-fetch")));
        for (const blob of fetched.blobs) {
          const outcome = yield* blobStore
            .applyRemote(blob)
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("roaming: rejected fetched blob", { cause }).pipe(
                  Effect.as("stale" as const),
                ),
              ),
            );
          if (outcome === "conflict") {
            yield* Effect.logWarning("roaming: blob conflict recorded", {
              kind: blob.kind,
              key: blob.key,
              peer: peer.environmentId,
            });
          }
        }
      }

      if (toPush.length > 0) {
        const blobs = yield* blobStore.getMany(toPush);
        const pushBody = yield* encodePushRequest({ environmentId, blobs }).pipe(
          Effect.mapError(requestError("encode-push")),
        );
        const pushStartedMs = yield* Clock.currentTimeMillis;
        const pushResponse = yield* decodePushResponse(
          yield* postJson(token, baseUrl, ROAMING_MIRROR_PUSH_PATH, pushBody, DATA_REQUEST_TIMEOUT),
        ).pipe(Effect.mapError(requestError("decode-push")));
        const pushDoneMs = yield* Clock.currentTimeMillis;
        yield* Effect.logInfo("roaming timing: blobs-pushed-to-peer", {
          peer: peer.environmentId,
          source,
          count: blobs.length,
          durationMs: pushDoneMs - pushStartedMs,
        });
        for (const result of pushResponse.results) {
          if (result.outcome === "conflict") {
            yield* Effect.logWarning("roaming: peer recorded blob conflict", {
              kind: result.kind,
              key: result.key,
              peer: peer.environmentId,
            });
          }
        }
      }

      yield* peers.recordContact(peer.environmentId, yield* nowIso);
    });

  const syncWithPeer = (peer: RoamingPeer, source: string) =>
    Effect.gen(function* () {
      const secret = yield* secretStore.get(roamingPeerSecretName(peer.environmentId));
      if (secret._tag === "None") {
        // Normal for the callee side of a pairing (data flows when the peer
        // contacts us) — debug, or every pass would log a scary warning.
        yield* Effect.logDebug("roaming: no credential for peer, skipping", {
          peer: peer.environmentId,
        });
        return;
      }
      const token = new TextDecoder().decode(secret.value);

      let lastError: unknown = null;
      for (const baseUrl of peer.baseUrls) {
        const attemptStartedMs = yield* Clock.currentTimeMillis;
        const result = yield* syncWithPeerAt(peer, token, baseUrl, source).pipe(Effect.exit);
        if (result._tag === "Success") {
          return;
        }
        // A stale first URL that stalls to a timeout delays every pass by
        // its full duration — the attempt time is the evidence.
        const attemptDoneMs = yield* Clock.currentTimeMillis;
        yield* Effect.logInfo("roaming timing: peer-attempt-failed", {
          peer: peer.environmentId,
          baseUrl,
          durationMs: attemptDoneMs - attemptStartedMs,
        });
        lastError = result.cause;
      }
      yield* Effect.logDebug("roaming: peer unreachable", {
        peer: peer.environmentId,
        cause: lastError,
      });
    });

  const syncPass = (source: string) =>
    Effect.gen(function* () {
      if (!(yield* peers.roamingEnabled)) {
        return;
      }
      const enrolledPeers = yield* peers
        .list()
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("roaming: failed to list peers", { cause }).pipe(Effect.as([])),
          ),
        );
      for (const peer of enrolledPeers) {
        // Sync-off is a pause, not an unpair: the credential stays but no
        // passes run against this peer until the user re-enables it.
        if (!peer.syncEnabled) continue;
        yield* syncWithPeer(peer, source);
      }
    });

  // ── Change waiters (M3.7) ─────────────────────────────────────────────
  // Mirror connectivity is one-directional: only the pairing initiator
  // holds a credential + base URLs for its peer, so the CALLEE's beacon
  // writes used to sit unnoticed until this machine's next interval tick
  // (the measured ~52s deliveries). One long-poll per reachable peer turns
  // the callee's writes into an immediate trigger; the interval pass stays
  // the delivery guarantee.

  const waitForChanges = (token: string, baseUrl: string, since: number | null) =>
    encodeWaitRequest({ sinceRevision: since }).pipe(
      Effect.mapError(requestError("encode-wait")),
      Effect.flatMap((body) => postJson(token, baseUrl, ROAMING_MIRROR_WAIT_PATH, body)),
      Effect.flatMap((raw) =>
        decodeWaitResponse(raw).pipe(Effect.mapError(requestError("decode-wait"))),
      ),
      Effect.timeout(WAIT_CLIENT_TIMEOUT),
    );

  const peerWaiter = (peerEnvironmentId: RoamingPeer["environmentId"]) =>
    Effect.gen(function* () {
      let since: number | null = null;
      while (true) {
        if (!(yield* peers.roamingEnabled)) return;
        const peer = (yield* peers.list().pipe(Effect.orElseSucceed(() => []))).find(
          (candidate) => candidate.environmentId === peerEnvironmentId,
        );
        if (peer === undefined || !peer.syncEnabled || peer.baseUrls.length === 0) return;
        const secret = yield* secretStore
          .get(roamingPeerSecretName(peerEnvironmentId))
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (secret._tag === "None") return;
        const token = new TextDecoder().decode(secret.value);

        let waited: RoamingWaitChangesResponse | null = null;
        for (const baseUrl of peer.baseUrls) {
          const attempt: RoamingWaitChangesResponse | null = yield* waitForChanges(
            token,
            baseUrl,
            since,
          ).pipe(Effect.orElseSucceed(() => null));
          if (attempt !== null) {
            waited = attempt;
            break;
          }
        }
        if (waited === null) {
          yield* Effect.sleep(WAIT_RETRY_DELAY);
          continue;
        }
        // The first response only primes the cursor — the startup pass
        // already reconciled whatever existed before.
        if (since !== null && waited.revision !== since) {
          yield* Effect.logInfo("roaming timing: peer-changes-notified", {
            peer: peerEnvironmentId,
            revision: waited.revision,
          });
          yield* Queue.offer(trigger, "peer-notify");
        }
        since = waited.revision;
      }
    });

  const runningWaiters = yield* Ref.make(new Set<string>());

  const ensureWaiters = Effect.gen(function* () {
    if (!(yield* peers.roamingEnabled)) return;
    const enrolledPeers = yield* peers.list().pipe(Effect.orElseSucceed(() => []));
    for (const peer of enrolledPeers) {
      if (!peer.syncEnabled || peer.baseUrls.length === 0) continue;
      // Atomic claim: the drain loop and the interval scan both reconcile,
      // and a check-then-add would double-spawn the waiter.
      const claimed = yield* Ref.modify(runningWaiters, (set) =>
        set.has(peer.environmentId)
          ? ([false, set] as const)
          : ([true, new Set(set).add(peer.environmentId)] as const),
      );
      if (!claimed) continue;
      // The waiter exits on its own when the peer is paused/removed or
      // roaming turns off; this scan respawns it when conditions return.
      yield* peerWaiter(peer.environmentId).pipe(
        Effect.catchCause((cause) =>
          Effect.logDebug("roaming: peer change waiter failed", {
            peer: peer.environmentId,
            cause,
          }),
        ),
        Effect.ensuring(
          Ref.update(runningWaiters, (set) => {
            const next = new Set(set);
            next.delete(peer.environmentId);
            return next;
          }),
        ),
        Effect.forkScoped,
      );
    }
  });

  const syncNow: PeerMirror["Service"]["syncNow"] = () => Queue.offer(trigger, "manual");

  const syncNowAndWait: PeerMirror["Service"]["syncNowAndWait"] = () =>
    syncPass("on-demand").pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("roaming: on-demand mirror pass failed", { cause }),
      ),
    );

  const start: PeerMirror["Service"]["start"] = () =>
    Effect.gen(function* () {
      // Drain loop: coalesced trigger → one pass at a time. Every pass also
      // reconciles the change waiters, so a fresh pairing gets its long-poll
      // within the pass its own syncNow triggers — the 30s scan alone left a
      // window where the peer's first beacons went unnoticed (measured:
      // run-5 delivery 2 waited for the interval).
      yield* Effect.forkScoped(
        Effect.forever(
          Queue.take(trigger).pipe(
            Effect.flatMap((source) =>
              ensureWaiters.pipe(
                Effect.catchCause((cause) =>
                  Effect.logDebug("roaming: waiter reconcile failed", { cause }),
                ),
                Effect.andThen(
                  syncPass(source).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning("roaming: mirror pass failed", { cause }),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      // Interval trigger (also covers the startup pass).
      yield* Effect.forkScoped(
        Effect.forever(
          Queue.offer(trigger, "interval").pipe(Effect.andThen(Effect.sleep(MIRROR_INTERVAL))),
        ),
      );
      // Local-write trigger.
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          const changes = yield* blobStore.subscribeChanges;
          return yield* Effect.forever(
            PubSub.take(changes).pipe(Effect.andThen(Queue.offer(trigger, "blob-write"))),
          );
        }),
      );
      // Change waiters: one long-poll per reachable peer (M3.7).
      yield* Effect.forkScoped(
        Effect.forever(
          ensureWaiters.pipe(
            Effect.catchCause((cause) =>
              Effect.logDebug("roaming: waiter reconcile failed", { cause }),
            ),
            Effect.andThen(Effect.sleep(WAITER_RECONCILE_INTERVAL)),
          ),
        ),
      );
    });

  return { start, syncNow, syncNowAndWait } satisfies PeerMirror["Service"];
});

export const layer = Layer.effect(PeerMirror, make);
