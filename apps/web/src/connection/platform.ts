import {
  ClientPresentation,
  CloudSession,
  EnvironmentOwnedDataCleanup,
  PlatformConnectionSource,
  PrimaryEnvironmentAuth,
  RelayDeviceIdentity,
  SshEnvironmentGateway,
} from "@t3tools/client-runtime/platform";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
  ConnectionBlockedError,
  ConnectionTransientError,
  Connectivity,
  mapRemoteEnvironmentError,
  type PlatformConnectionRegistration,
  PrimaryConnectionRegistration,
  PrimaryConnectionTarget,
  Wakeups,
} from "@t3tools/client-runtime/connection";
import { bootstrapRemoteBearerSession } from "@t3tools/client-runtime/authorization";
import {
  deriveWsBaseUrl,
  fetchRemoteEnvironmentDescriptor,
  normalizeHttpBaseUrl,
} from "@t3tools/client-runtime/environment";
import { managedRelayAccountChanges, managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import { EnvironmentRpcRequestObserver } from "@t3tools/client-runtime/rpc";
import {
  AuthStandardClientScopes,
  type DesktopBridge,
  type DesktopEnvironmentBootstrap,
  type DesktopSshEnvironmentTarget,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type RoamingAttachRegistration,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/unstable/http";

import { APP_VERSION } from "../branding";
import { readDesktopPrimaryBearerToken } from "../environments/primary/desktopAuth";
import { primaryEnvironmentHttpLayer } from "../environments/primary/httpLayer";
import { listRoamingAttachRegistrations } from "../environments/primary/roaming";
import {
  readPrimaryEnvironmentTarget,
  type PrimaryEnvironmentTarget,
} from "../environments/primary/target";
import { clearComposerDraftsEnvironment } from "../composerDraftStore";
import { isHostedStaticApp } from "../hostedPairing";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { acknowledgeRpcRequest, trackRpcRequestSent } from "../rpc/requestLatencyState";
import {
  desktopLocalConnectionId,
  readDesktopSecondaryBootstrapsResult,
  type DesktopSecondaryBootstrapsRead,
} from "./desktopLocal";
import { connectionStorageLayer } from "./storage";
import { clientPresentationMetadata } from "./clientMetadata";

let nextObservedRpcRequestId = 0;

function currentNetworkStatus(): "unknown" | "offline" | "online" {
  if (typeof navigator === "undefined") {
    return "unknown";
  }
  return navigator.onLine ? "online" : "offline";
}

const connectivityLayer = Connectivity.layer({
  status: Effect.sync(currentNetworkStatus),
  changes: Stream.callback((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const online = () => Queue.offerUnsafe(queue, "online");
        const offline = () => Queue.offerUnsafe(queue, "offline");
        window.addEventListener("online", online);
        window.addEventListener("offline", offline);
        return { online, offline };
      }),
      ({ online, offline }) =>
        Effect.sync(() => {
          window.removeEventListener("online", online);
          window.removeEventListener("offline", offline);
        }),
    ).pipe(Effect.asVoid),
  ),
});

const wakeupsLayer = Wakeups.layer({
  changes: Stream.merge(
    Stream.callback<"application-active">((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const listener = () => {
            if (document.visibilityState === "visible") {
              Queue.offerUnsafe(queue, "application-active");
            }
          };
          document.addEventListener("visibilitychange", listener);
          return listener;
        }),
        (listener) =>
          Effect.sync(() => {
            document.removeEventListener("visibilitychange", listener);
          }),
      ).pipe(Effect.asVoid),
    ),
    managedRelayAccountChanges(appAtomRegistry).pipe(
      Stream.map(() => "credentials-changed" as const),
    ),
  ),
});

function clientMetadata() {
  return clientPresentationMetadata({
    appVersion: APP_VERSION,
    hosted: isHostedStaticApp(),
    identity: {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      maxTouchPoints: navigator.maxTouchPoints,
    },
    desktopBridge: window.desktopBridge,
  });
}

function sshPreparationError(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (message.toLowerCase().includes("cancel")) {
    return new ConnectionBlockedError({
      reason: "authentication",
      detail: message,
    });
  }
  return new ConnectionTransientError({
    reason: "remote-unavailable",
    detail: `Could not prepare the SSH environment: ${message}`,
  });
}

export const provisionDesktopSshEnvironment = Effect.fn(
  "web.connectionPlatform.ssh.provisionDesktop",
)(function* (bridge: DesktopBridge, target: DesktopSshEnvironmentTarget) {
  const bootstrap = yield* Effect.tryPromise({
    try: () =>
      bridge.ensureSshEnvironment(target, {
        issuePairingToken: true,
      }),
    catch: sshPreparationError,
  });
  const pairingToken = bootstrap.pairingToken;
  if (pairingToken === null) {
    return yield* new ConnectionBlockedError({
      reason: "authentication",
      detail: "The SSH environment did not issue a pairing credential.",
    });
  }
  const descriptor = yield* Effect.tryPromise({
    try: () => bridge.fetchSshEnvironmentDescriptor(bootstrap.httpBaseUrl),
    catch: sshPreparationError,
  });
  const access = yield* Effect.tryPromise({
    try: () => bridge.bootstrapSshBearerSession(bootstrap.httpBaseUrl, pairingToken),
    catch: sshPreparationError,
  });
  return {
    environmentId: descriptor.environmentId,
    label: descriptor.label,
    bootstrap,
    bearerToken: access.access_token,
  };
});

const capabilitiesLayer = Layer.effectContext(
  Effect.sync(() => {
    const presentation = ClientPresentation.of({
      metadata: clientMetadata(),
      scopes: AuthStandardClientScopes,
    });
    const cloudSession = CloudSession.of({
      identity: Effect.sync(() =>
        Option.fromNullishOr(appAtomRegistry.get(managedRelaySessionAtom)),
      ),
      clerkToken: Effect.gen(function* () {
        const session = appAtomRegistry.get(managedRelaySessionAtom);
        if (session === null) {
          return yield* new ConnectionBlockedError({
            reason: "authentication",
            detail: "Sign in to T3 Connect to connect this environment.",
          });
        }
        const token = yield* session.readClerkToken().pipe(
          Effect.mapError(
            (error) =>
              new ConnectionTransientError({
                reason: "network",
                detail: error.message,
              }),
          ),
        );
        if (token === null) {
          return yield* new ConnectionBlockedError({
            reason: "authentication",
            detail: "The T3 Connect session is unavailable.",
          });
        }
        return token;
      }),
    });
    const identity = RelayDeviceIdentity.of({
      deviceId: Effect.succeed(Option.none()),
    });
    const primaryAuth = PrimaryEnvironmentAuth.of({
      bearerToken: Effect.tryPromise({
        try: readDesktopPrimaryBearerToken,
        catch: (cause) =>
          new ConnectionTransientError({
            reason: "remote-unavailable",
            detail: `Could not load the desktop primary credential: ${String(cause)}`,
          }),
      }).pipe(Effect.map(Option.fromNullishOr)),
    });
    const ssh = SshEnvironmentGateway.of({
      provision: Effect.fn("web.connectionPlatform.ssh.provision")(function* (target) {
        const bridge = window.desktopBridge;
        if (bridge === undefined) {
          return yield* new ConnectionBlockedError({
            reason: "unsupported",
            detail: "SSH environments are only available in the desktop app.",
          });
        }
        return yield* provisionDesktopSshEnvironment(bridge, target);
      }),
      prepare: Effect.fn("web.connectionPlatform.ssh.prepare")(function* (input) {
        const bridge = window.desktopBridge;
        if (bridge === undefined) {
          return yield* new ConnectionBlockedError({
            reason: "unsupported",
            detail: "SSH environments are only available in the desktop app.",
          });
        }
        const bootstrap = yield* Effect.tryPromise({
          try: () =>
            bridge.ensureSshEnvironment(input.target, {
              issuePairingToken: true,
            }),
          catch: sshPreparationError,
        });
        if (bootstrap.pairingToken === null) {
          return yield* new ConnectionBlockedError({
            reason: "authentication",
            detail: "The SSH environment did not issue a pairing credential.",
          });
        }
        const access = yield* Effect.tryPromise({
          try: () =>
            bridge.bootstrapSshBearerSession(bootstrap.httpBaseUrl, bootstrap.pairingToken!),
          catch: sshPreparationError,
        });
        return {
          bootstrap,
          bearerToken: access.access_token,
        };
      }),
      disconnect: Effect.fn("web.connectionPlatform.ssh.disconnect")(function* (target) {
        const bridge = window.desktopBridge;
        if (bridge === undefined) {
          return;
        }
        yield* Effect.tryPromise({
          try: () => bridge.disconnectSshEnvironment(target),
          catch: (cause) =>
            new ConnectionTransientError({
              reason: "remote-unavailable",
              detail: `Could not disconnect the SSH environment: ${String(cause)}`,
            }),
        });
      }),
    });

    return Context.make(CloudSession, cloudSession).pipe(
      Context.add(PrimaryEnvironmentAuth, primaryAuth),
      Context.add(RelayDeviceIdentity, identity),
      Context.add(ClientPresentation, presentation),
      Context.add(SshEnvironmentGateway, ssh),
    );
  }),
);

const loadPrimaryConnectionRegistration = Effect.fn(
  "web.connectionPlatform.loadPrimaryConnectionRegistration",
)(function* (resolved: PrimaryEnvironmentTarget) {
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({
    httpBaseUrl: resolved.target.httpBaseUrl,
  }).pipe(Effect.provide(primaryEnvironmentHttpLayer), Effect.mapError(mapRemoteEnvironmentError));
  return new PrimaryConnectionRegistration({
    target: new PrimaryConnectionTarget({
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      httpBaseUrl: resolved.target.httpBaseUrl,
      wsBaseUrl: resolved.target.wsBaseUrl,
    }),
  });
});

// A desktop-local secondary backend (e.g. a parallel WSL backend) lives on its
// own loopback origin, so — unlike the same-origin primary — it authenticates
// with a bearer token minted from the bootstrap credential the desktop issues.
const loadSecondaryConnectionRegistration = Effect.fn(
  "web.connectionPlatform.loadSecondaryConnectionRegistration",
)(function* (entry: DesktopEnvironmentBootstrap) {
  if (
    entry.httpBaseUrl === null ||
    entry.wsBaseUrl === null ||
    entry.bootstrapToken === undefined
  ) {
    return yield* new ConnectionTransientError({
      reason: "endpoint-unavailable",
      detail: `Desktop-local backend ${entry.id} is not ready yet.`,
    });
  }
  const httpBaseUrl = entry.httpBaseUrl;
  const wsBaseUrl = entry.wsBaseUrl;
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl }).pipe(
    Effect.mapError(mapRemoteEnvironmentError),
  );
  const issuedAtEpochMs = yield* Clock.currentTimeMillis;
  const access = yield* bootstrapRemoteBearerSession({
    httpBaseUrl,
    credential: entry.bootstrapToken,
    scopes: AuthStandardClientScopes,
    clientMetadata: clientMetadata(),
  }).pipe(Effect.mapError(mapRemoteEnvironmentError));
  // Keep the desktop pool's stable backend id in the connection id. The
  // descriptor environment id still scopes projects and RPC state, while the
  // backend id lets desktop-only operations (notably the WSL folder picker)
  // route back to the instance that owns the environment.
  const connectionId = desktopLocalConnectionId(entry.id);
  // Prefer the desktop's bootstrap label (it identifies the backend and distro,
  // e.g. "WSL: Ubuntu") over the generic descriptor label, so consumers can show
  // a meaningful name without recovering it from the bootstrap list later.
  const label = entry.label || descriptor.label;
  return {
    registration: new BearerConnectionRegistration({
      target: new BearerConnectionTarget({
        environmentId: descriptor.environmentId,
        label,
        connectionId,
      }),
      profile: new BearerConnectionProfile({
        connectionId,
        environmentId: descriptor.environmentId,
        label,
        httpBaseUrl,
        wsBaseUrl,
      }),
      credential: new BearerConnectionCredential({ token: access.access_token }),
    }),
    expiresAtEpochMs: secondaryBearerExpiresAtEpochMs(issuedAtEpochMs, access.expires_in),
    refreshAtEpochMs: secondaryBearerRefreshAtEpochMs(issuedAtEpochMs, access.expires_in),
  };
});

// Poll cadence for the desktop bootstrap topology. There is no change event on
// the bridge, so the renderer polls; successful registrations are cached by a
// signature of their endpoint + token until bearer credentials approach expiry.
const PLATFORM_POLL_INTERVAL = "3 seconds";
const SECONDARY_BEARER_REFRESH_SKEW_MS = 5_000;

export function secondaryBearerExpiresAtEpochMs(
  issuedAtEpochMs: number,
  expiresInSeconds: number,
): number {
  return issuedAtEpochMs + Math.max(0, expiresInSeconds * 1_000);
}

export function secondaryBearerRefreshAtEpochMs(
  issuedAtEpochMs: number,
  expiresInSeconds: number,
): number {
  return Math.max(
    issuedAtEpochMs,
    secondaryBearerExpiresAtEpochMs(issuedAtEpochMs, expiresInSeconds) -
      SECONDARY_BEARER_REFRESH_SKEW_MS,
  );
}

interface CachedPlatformRegistration {
  readonly signature: string;
  readonly registration: PlatformConnectionRegistration;
  readonly expiresAtEpochMs?: number;
  readonly refreshAtEpochMs?: number;
}

// M5.6 bidirectional pairing: the primary server hands out attach
// registrations for machines this client should reach (the reverse half of
// the roaming handshake). They ride the platform source so the existing
// reconcile covers install, refresh, and removal, and they are never
// written into the browser's own connection catalog. The list route is
// polled on a throttle riding the 3s platform tick; candidate URLs are
// identity-probed (first descriptor answering as the registered
// environment wins) and an unreachable machine still installs on its
// first candidate so the ordinary supervisor retry/offline presentation
// applies.
const ROAMING_REGISTRATIONS_REFRESH_MS = 15_000;
const ROAMING_PROBE_TIMEOUT = "2 seconds";

interface CachedRoamingRegistration {
  readonly signature: string;
  readonly registration: BearerConnectionRegistration;
  /** Whether a candidate URL answered as the registered environment. */
  readonly verified: boolean;
}

export function roamingRegistrationSignature(registration: RoamingAttachRegistration): string {
  return `${registration.environmentId}|${registration.label}|${registration.baseUrls.join(",")}|${registration.token}`;
}

export const buildRoamingRegistration = Effect.fn(
  "web.connectionPlatform.buildRoamingRegistration",
)(function* (registration: RoamingAttachRegistration) {
  let chosenBaseUrl: string | undefined;
  // A candidate that answers as a DIFFERENT environment is poison, never a
  // fallback: a loopback candidate reaches THIS reader's own backend, which
  // answers as itself forever (2026-07-31 field bug — the row sat red on
  // "connected environment X does not match Y"). Only a candidate that
  // stayed SILENT may be installed unverified, because not answering is
  // exactly what an offline peer looks like.
  let silentBaseUrl: string | undefined;
  for (const candidate of registration.baseUrls) {
    const httpBaseUrl = normalizeHttpBaseUrl(candidate);
    const descriptor = yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl }).pipe(
      Effect.timeout(ROAMING_PROBE_TIMEOUT),
      Effect.option,
    );
    if (Option.isNone(descriptor)) {
      silentBaseUrl ??= candidate;
      continue;
    }
    if (descriptor.value.environmentId === registration.environmentId) {
      chosenBaseUrl = candidate;
      break;
    }
  }
  const verified = chosenBaseUrl !== undefined;
  const usableBaseUrl = chosenBaseUrl ?? silentBaseUrl;
  if (usableBaseUrl === undefined) {
    // Every advertised address belongs to someone else — installing one
    // would attach this client to the wrong machine and render a
    // permanently failing row. Skip until the peer re-advertises.
    yield* Effect.logWarning(
      "Skipping a roaming registration whose addresses all answer as a different environment.",
      { environmentId: registration.environmentId },
    );
    return null;
  }
  const httpBaseUrl = normalizeHttpBaseUrl(usableBaseUrl);
  const connectionId = `bearer:${registration.environmentId}`;
  return {
    signature: roamingRegistrationSignature(registration),
    verified,
    registration: new BearerConnectionRegistration({
      target: new BearerConnectionTarget({
        environmentId: registration.environmentId,
        label: registration.label,
        connectionId,
      }),
      profile: new BearerConnectionProfile({
        connectionId,
        environmentId: registration.environmentId,
        label: registration.label,
        httpBaseUrl,
        wsBaseUrl: deriveWsBaseUrl(httpBaseUrl),
      }),
      credential: new BearerConnectionCredential({ token: registration.token }),
    }),
  } satisfies CachedRoamingRegistration;
});

export type PrimaryEnvironmentTargetRead =
  | {
      readonly _tag: "Success";
      readonly target: PrimaryEnvironmentTarget | null;
    }
  | {
      readonly _tag: "Failure";
      readonly cause: unknown;
    };

export function readPrimaryEnvironmentTargetResult(
  readTarget: () => PrimaryEnvironmentTarget | null = readPrimaryEnvironmentTarget,
): PrimaryEnvironmentTargetRead {
  try {
    return { _tag: "Success", target: readTarget() };
  } catch (cause) {
    return { _tag: "Failure", cause };
  }
}

export function primaryRegistrationToRetainAfterTopologyRead(
  previous: ReadonlyMap<string, CachedPlatformRegistration>,
  topologyRead: PrimaryEnvironmentTargetRead,
): CachedPlatformRegistration | undefined {
  return topologyRead._tag === "Failure" ? previous.get(PRIMARY_LOCAL_ENVIRONMENT_ID) : undefined;
}

export function canReuseCachedPlatformRegistration(
  cached: CachedPlatformRegistration,
  signature: string,
  nowEpochMs: number,
): boolean {
  return (
    cached.signature === signature &&
    (cached.refreshAtEpochMs === undefined || nowEpochMs < cached.refreshAtEpochMs)
  );
}

export function canRetainCachedPlatformRegistrationAfterRefreshFailure(
  cached: CachedPlatformRegistration,
  signature: string,
  nowEpochMs: number,
): boolean {
  return (
    cached.signature === signature &&
    cached.expiresAtEpochMs !== undefined &&
    nowEpochMs < cached.expiresAtEpochMs
  );
}

export function secondaryRegistrationsToRetainAfterTopologyRead(
  previous: ReadonlyMap<string, CachedPlatformRegistration>,
  topologyRead: DesktopSecondaryBootstrapsRead,
  nowEpochMs: number,
): ReadonlyMap<string, CachedPlatformRegistration> {
  if (topologyRead._tag === "Success") {
    return new Map();
  }
  return new Map(
    [...previous].filter(
      ([, cached]) => cached.expiresAtEpochMs !== undefined && nowEpochMs < cached.expiresAtEpochMs,
    ),
  );
}

const platformConnectionSourceLayer = Layer.effect(
  PlatformConnectionSource,
  Effect.gen(function* () {
    if (isHostedStaticApp()) {
      return PlatformConnectionSource.of({
        registrations: Stream.empty,
      });
    }
    const cacheRef = yield* Ref.make(new Map<string, CachedPlatformRegistration>());
    const roamingCacheRef = yield* Ref.make(new Map<string, CachedRoamingRegistration>());
    const roamingFetchedAtRef = yield* Ref.make(0);

    // Refresh the server-provided roaming registrations at most every
    // ROAMING_REGISTRATIONS_REFRESH_MS. A failed list fetch keeps the
    // previous cache (if the primary is unreachable the whole client is
    // down anyway); an empty/404 list clears it, which reconciles the
    // environments away — consistent with roaming's gate-off masking.
    const refreshRoamingRegistrations = Effect.gen(function* () {
      const nowEpochMs = yield* Clock.currentTimeMillis;
      if (nowEpochMs - (yield* Ref.get(roamingFetchedAtRef)) < ROAMING_REGISTRATIONS_REFRESH_MS) {
        return;
      }
      yield* Ref.set(roamingFetchedAtRef, nowEpochMs);
      const listed = yield* Effect.tryPromise(() => listRoamingAttachRegistrations()).pipe(
        Effect.map((response) => response.registrations),
        Effect.catch((error) =>
          Effect.logDebug("Could not list roaming attach registrations.", { error }).pipe(
            Effect.as(null),
          ),
        ),
      );
      if (listed === null) {
        return;
      }
      const previous = yield* Ref.get(roamingCacheRef);
      const next = new Map<string, CachedRoamingRegistration>();
      for (const registration of listed) {
        const signature = roamingRegistrationSignature(registration);
        const cached = previous.get(registration.environmentId);
        // A verified entry is settled until the registration changes; an
        // unverified one re-probes so the machine coming online on a later
        // candidate URL is eventually found.
        if (cached !== undefined && cached.signature === signature && cached.verified) {
          next.set(registration.environmentId, cached);
          continue;
        }
        const built = yield* buildRoamingRegistration(registration);
        if (built !== null) {
          next.set(registration.environmentId, built);
        }
      }
      yield* Ref.set(roamingCacheRef, next);
    });

    // Resolve the full set of platform-managed environments the host currently
    // reports: the primary (same-origin cookie auth) plus any desktop-local
    // backends running alongside it (bearer auth). Reused registrations come
    // from the cache; a failed entry is skipped and retried on the next poll.
    const buildPlatformRegistrations = Effect.gen(function* () {
      const previous = yield* Ref.get(cacheRef);
      const nowEpochMs = yield* Clock.currentTimeMillis;
      const next = new Map<string, CachedPlatformRegistration>();
      const registrations: Array<PlatformConnectionRegistration> = [];

      const primaryTopologyRead = readPrimaryEnvironmentTargetResult();
      const retainedPrimary = primaryRegistrationToRetainAfterTopologyRead(
        previous,
        primaryTopologyRead,
      );
      if (retainedPrimary !== undefined) {
        next.set(PRIMARY_LOCAL_ENVIRONMENT_ID, retainedPrimary);
        registrations.push(retainedPrimary.registration);
      }

      if (primaryTopologyRead._tag === "Failure") {
        yield* Effect.logWarning("Could not read the primary environment topology.", {
          cause: primaryTopologyRead.cause,
        });
      } else if (primaryTopologyRead.target !== null) {
        const primaryTarget = primaryTopologyRead.target;
        const signature = `primary|${primaryTarget.target.httpBaseUrl}|${primaryTarget.target.wsBaseUrl}`;
        const cached = previous.get(PRIMARY_LOCAL_ENVIRONMENT_ID);
        if (
          cached !== undefined &&
          canReuseCachedPlatformRegistration(cached, signature, nowEpochMs)
        ) {
          next.set(PRIMARY_LOCAL_ENVIRONMENT_ID, cached);
          registrations.push(cached.registration);
        } else {
          const built = yield* loadPrimaryConnectionRegistration(primaryTarget).pipe(
            Effect.tapError((error) =>
              Effect.logWarning("Could not discover the primary environment.", { error }),
            ),
            Effect.option,
          );
          if (Option.isSome(built)) {
            const cacheEntry = { signature, registration: built.value };
            next.set(PRIMARY_LOCAL_ENVIRONMENT_ID, cacheEntry);
            registrations.push(built.value);
          }
        }
      }

      const topologyRead = readDesktopSecondaryBootstrapsResult();
      for (const [id, cached] of secondaryRegistrationsToRetainAfterTopologyRead(
        previous,
        topologyRead,
        nowEpochMs,
      )) {
        next.set(id, cached);
        registrations.push(cached.registration);
      }

      if (topologyRead._tag === "Failure") {
        yield* Effect.logWarning("Could not read the desktop-local backend topology.", {
          cause: topologyRead.cause,
        });
      } else {
        for (const bootstrap of topologyRead.bootstraps) {
          const signature = `${bootstrap.httpBaseUrl}|${bootstrap.wsBaseUrl}|${bootstrap.bootstrapToken ?? ""}`;
          const cached = previous.get(bootstrap.id);
          if (
            cached !== undefined &&
            canReuseCachedPlatformRegistration(cached, signature, nowEpochMs)
          ) {
            next.set(bootstrap.id, cached);
            registrations.push(cached.registration);
            continue;
          }
          const built = yield* loadSecondaryConnectionRegistration(bootstrap).pipe(
            Effect.tapError((error) =>
              Effect.logWarning("Could not connect a desktop-local backend.", {
                id: bootstrap.id,
                error,
              }),
            ),
            Effect.option,
          );
          if (Option.isSome(built)) {
            const cacheEntry = { signature, ...built.value };
            next.set(bootstrap.id, cacheEntry);
            registrations.push(built.value.registration);
          } else if (
            cached !== undefined &&
            canRetainCachedPlatformRegistrationAfterRefreshFailure(cached, signature, nowEpochMs)
          ) {
            next.set(bootstrap.id, cached);
            registrations.push(cached.registration);
          }
        }
      }

      yield* refreshRoamingRegistrations;
      // Anything already claimed by the primary or a desktop-local backend
      // wins over a roaming registration for the same environment.
      const claimedEnvironmentIds = new Set(
        registrations.map((registration) => registration.target.environmentId),
      );
      for (const entry of (yield* Ref.get(roamingCacheRef)).values()) {
        if (claimedEnvironmentIds.has(entry.registration.target.environmentId)) {
          continue;
        }
        registrations.push(entry.registration);
      }

      yield* Ref.set(cacheRef, next);
      return registrations as ReadonlyArray<PlatformConnectionRegistration>;
    }).pipe(Effect.provide(FetchHttpClient.layer));

    return PlatformConnectionSource.of({
      registrations: Stream.tick(PLATFORM_POLL_INTERVAL).pipe(
        Stream.mapEffect(() => buildPlatformRegistrations),
      ),
    });
  }),
);

const environmentOwnedDataCleanupLayer = Layer.succeed(
  EnvironmentOwnedDataCleanup,
  EnvironmentOwnedDataCleanup.of({
    clear: (environmentId) =>
      Effect.sync(() => {
        clearComposerDraftsEnvironment(environmentId);
      }),
  }),
);

const rpcRequestObserverLayer = Layer.succeed(
  EnvironmentRpcRequestObserver,
  EnvironmentRpcRequestObserver.of({
    observe: ({ environmentId, method }) =>
      Effect.sync(() => {
        nextObservedRpcRequestId += 1;
        const requestId = `${environmentId}:${nextObservedRpcRequestId}`;
        trackRpcRequestSent(requestId, method, `${method} · ${environmentId}`);
        return Effect.sync(() => {
          acknowledgeRpcRequest(requestId);
        });
      }),
  }),
);

type ConnectionPlatformLayerSource =
  | typeof connectionStorageLayer
  | typeof connectivityLayer
  | typeof wakeupsLayer
  | typeof capabilitiesLayer
  | typeof platformConnectionSourceLayer
  | typeof environmentOwnedDataCleanupLayer
  | typeof rpcRequestObserverLayer;

export const connectionPlatformLayer: Layer.Layer<
  Layer.Success<ConnectionPlatformLayerSource>,
  Layer.Error<ConnectionPlatformLayerSource>,
  Layer.Services<ConnectionPlatformLayerSource>
> = Layer.mergeAll(
  connectionStorageLayer,
  connectivityLayer,
  wakeupsLayer,
  capabilitiesLayer,
  platformConnectionSourceLayer,
  environmentOwnedDataCleanupLayer,
  rpcRequestObserverLayer,
);
