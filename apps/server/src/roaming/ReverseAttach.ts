/**
 * ReverseAttach - keeps this machine's attach registration current on its
 * peers (M5.6 standing-channel model, 2026-08-01 binding decision).
 *
 * The reverse direction becomes relevant only after pairing — the
 * paired-into machine has nothing of its own until the user materializes
 * and works there — so the permission must never be frozen at handshake
 * time. Instead, after every successful mirror pass the initiator (the
 * machine holding the mirror credential) compares its advertised
 * addresses against what it last pushed to that peer: when they changed
 * it mints a fresh standard-scoped attach bearer and pushes
 * {label, addresses, token}; when they became empty (network access off)
 * it withdraws the registration and revokes the session. One pairing,
 * ever — the network-access toggle is the whole story, and pre-M5.6
 * pairings self-heal because the mirror credential already exists.
 */
import {
  AuthStandardClientScopes,
  EnvironmentId,
  ROAMING_ATTACH_REGISTRATION_PATH,
  ROAMING_ATTACH_REGISTRATION_WITHDRAW_PATH,
  RoamingAttachRegistration,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import { ServerConfig } from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { advertisedBaseUrls } from "../startupAccess.ts";

/** Matches the D4 machine credential; server-held, no user re-mint path. */
const REVERSE_ATTACH_TTL = Duration.days(365);
/** Sentinel signature for "we withdrew (or never had) a registration". */
const WITHDRAWN = "";

export class ReverseAttach extends Context.Service<
  ReverseAttach,
  {
    /**
     * Bring the peer's copy of our registration in line with our current
     * advertised addresses. Called after a successful mirror pass, with
     * the same credential and base URL that pass used. Never fails —
     * failures log (tags only) and retry on the next pass.
     */
    readonly ensureForPeer: (input: {
      readonly peerEnvironmentId: EnvironmentId;
      readonly baseUrl: string;
      readonly mirrorToken: string;
    }) => Effect.Effect<void>;
  }
>()("t3/roaming/ReverseAttach") {}

const encodeAttachRegistration = Schema.encodeUnknownEffect(RoamingAttachRegistration);

const make = Effect.gen(function* () {
  const auth = yield* EnvironmentAuth;
  const config = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const httpClient = yield* HttpClient.HttpClient;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;

  // Last pushed advertised-address signature per peer, per boot. A restart
  // re-pushes once (idempotent upsert on the peer) — that is also how a
  // peer upgraded to support the route eventually receives one.
  const lastPushed = new Map<EnvironmentId, string>();

  const currentAdvertised = Effect.gen(function* () {
    const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );
    const port = Option.isSome(runtimeState) ? runtimeState.value.port : config.port;
    return advertisedBaseUrls(config.host, port);
  });

  const authenticated = (mirrorToken: string) =>
    httpClient.pipe(
      HttpClient.mapRequest(HttpClientRequest.setHeader("authorization", `Bearer ${mirrorToken}`)),
    );

  // On THIS machine, every session with subject `roaming-peer:<peer>` is a
  // reverse attach session we minted (the peer's mirror sessions live on
  // the peer) — sweeping before a fresh mint prevents accumulation across
  // address changes and restarts.
  const sweepReverseSessions = (peerEnvironmentId: EnvironmentId) =>
    auth.listSessions().pipe(
      Effect.flatMap((sessions) =>
        Effect.forEach(
          sessions.filter((session) => session.subject === `roaming-peer:${peerEnvironmentId}`),
          (session) => auth.revokeSession(session.sessionId).pipe(Effect.ignore),
          { discard: true },
        ),
      ),
      Effect.ignore,
    );

  const withdraw = (input: {
    readonly peerEnvironmentId: EnvironmentId;
    readonly baseUrl: string;
    readonly mirrorToken: string;
  }) =>
    Effect.gen(function* () {
      const response = yield* authenticated(input.mirrorToken).post(
        `${input.baseUrl.replace(/\/$/, "")}${ROAMING_ATTACH_REGISTRATION_WITHDRAW_PATH}`,
        { body: HttpBody.jsonUnsafe({}) },
      );
      // 404 = a peer without the route; it holds no registration either.
      if (response.status !== 404) {
        yield* HttpClientResponse.filterStatusOk(response);
      }
      yield* sweepReverseSessions(input.peerEnvironmentId);
      lastPushed.set(input.peerEnvironmentId, WITHDRAWN);
      yield* Effect.logInfo("roaming: attach registration withdrawn (not reachable)", {
        peer: input.peerEnvironmentId,
      });
    });

  const push = (input: {
    readonly peerEnvironmentId: EnvironmentId;
    readonly baseUrl: string;
    readonly mirrorToken: string;
    readonly baseUrls: ReadonlyArray<string>;
    readonly signature: string;
  }) =>
    Effect.gen(function* () {
      const ownLabel = (yield* serverEnvironment.getDescriptor).label;
      const environmentId = yield* serverEnvironment.getEnvironmentId;
      yield* sweepReverseSessions(input.peerEnvironmentId);
      const session = yield* auth.issueSession({
        ttl: REVERSE_ATTACH_TTL,
        scopes: [...AuthStandardClientScopes],
        subject: `roaming-peer:${input.peerEnvironmentId}`,
        label: `${ownLabel} — attach`,
      });
      const registered = yield* Effect.gen(function* () {
        const body = yield* encodeAttachRegistration({
          environmentId,
          label: ownLabel,
          baseUrls: input.baseUrls,
          token: session.token,
          expiresAt: DateTime.formatIso(session.expiresAt),
        });
        const response = yield* authenticated(input.mirrorToken).post(
          `${input.baseUrl.replace(/\/$/, "")}${ROAMING_ATTACH_REGISTRATION_PATH}`,
          { body: HttpBody.jsonUnsafe(body) },
        );
        if (response.status === 404) {
          // Old peer. Don't retry until our addresses change (or restart):
          // the peer only gains the route by restarting on a new build,
          // and our next boot re-pushes anyway.
          yield* Effect.logInfo(
            "roaming: peer does not support bidirectional pairing; reverse attach skipped",
            { peer: input.peerEnvironmentId },
          );
          return false;
        }
        yield* HttpClientResponse.filterStatusOk(response);
        return true;
      }).pipe(
        Effect.catch((cause) =>
          // Tags only — bodies above carry live bearers.
          Effect.logWarning("roaming: reverse attach push failed", {
            peer: input.peerEnvironmentId,
            failureTag: (cause as { readonly _tag?: string })._tag ?? "unknown-failure",
          }).pipe(Effect.as(null)),
        ),
      );
      if (registered === null) {
        // Transient failure: revoke the unused session, retry next pass.
        yield* auth.revokeSession(session.sessionId).pipe(Effect.ignore);
        return;
      }
      if (!registered) {
        yield* auth.revokeSession(session.sessionId).pipe(Effect.ignore);
      }
      lastPushed.set(input.peerEnvironmentId, input.signature);
      if (registered) {
        yield* Effect.logInfo("roaming: attach registration pushed", {
          peer: input.peerEnvironmentId,
          addressCount: input.baseUrls.length,
        });
      }
    });

  const ensureForPeer: ReverseAttach["Service"]["ensureForPeer"] = (input) =>
    Effect.gen(function* () {
      const advertised = yield* currentAdvertised;
      const signature = advertised.join(",");
      if (lastPushed.get(input.peerEnvironmentId) === signature) {
        return;
      }
      if (advertised.length === 0) {
        if (lastPushed.get(input.peerEnvironmentId) === undefined) {
          // Never pushed anything this boot and nothing to advertise: a
          // loopback-only server (network access off). Withdraw anyway —
          // a registration from a previous, reachable boot may survive on
          // the peer and would point at a dead address.
          yield* Effect.logInfo(
            "roaming: not reachable over the network; the peer's clients cannot attach" +
              " here — enable network access to make this machine's threads live there",
            { peer: input.peerEnvironmentId },
          );
        }
        yield* withdraw(input);
        return;
      }
      yield* push({ ...input, baseUrls: advertised, signature });
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("roaming: reverse attach maintenance failed", {
          peer: input.peerEnvironmentId,
          failureTag: (cause as { readonly _tag?: string })._tag ?? "unknown-failure",
        }),
      ),
    );

  return { ensureForPeer } satisfies ReverseAttach["Service"];
});

export const layer = Layer.effect(ReverseAttach, make);
