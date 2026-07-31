/**
 * RoamingService - Enrollment operations for the roaming workspace.
 *
 * Owns the flows that turn things into roaming state: enrolling a local
 * project (mint WorkspaceProjectId → write registry blob → link the local
 * project through the orchestration decider) and enrolling a peer machine
 * (exchange a pairing credential at the peer's /oauth/token, then mint the
 * long-lived scoped machine credential — decision D4).
 */
import {
  AuthAccessWriteScope,
  AuthRoamingMirrorScope,
  AuthStandardClientScopes,
  AuthTokenExchangeGrantType,
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  CommandId,
  EnvironmentId,
  ProjectId,
  ROAMING_ATTACH_REGISTRATION_PATH,
  ROAMING_HANDSHAKE_COMPLETE_PATH,
  ROAMING_MACHINE_CREDENTIAL_PATH,
  RoamingAttachRegistration,
  RoamingMachineCredentialRequest,
  RoamingMachineCredentialResponse,
  type RoamingAttachGrant,
  type RoamingPairMachineResponse,
  type RoamingPairSyncOptions,
  type RoamingPeer,
  RoamingRegistryPayload,
  WorkspaceProjectId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
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
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { advertisedBaseUrls } from "../startupAccess.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import { PeerMirror } from "./PeerMirror.ts";
import { RoamingBlobStore } from "./RoamingBlobStore.ts";
import { RoamingPeers, roamingPeerSecretName } from "./RoamingPeers.ts";

/** D4 machine-to-machine credential lifetime. */
const MACHINE_CREDENTIAL_TTL = Duration.days(365);

export class RoamingEnrollError extends Schema.TaggedErrorClass<RoamingEnrollError>()(
  "RoamingEnrollError",
  {
    reason: Schema.Literals([
      "project-not-found",
      "no-git-remote",
      "peer-unreachable",
      "credential-rejected",
      "internal",
    ]),
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Roaming enrollment failed (${this.reason})${this.detail === undefined ? "" : `: ${this.detail}`}`;
  }
}

export class RoamingService extends Context.Service<
  RoamingService,
  {
    /** Enroll a local project; idempotent when already enrolled. */
    readonly enrollProject: (
      projectId: ProjectId,
    ) => Effect.Effect<WorkspaceProjectId, RoamingEnrollError>;
    /**
     * Push a renamed local project's title into its registry blob (and mirror
     * it), preserving every other registry field. No-op when the project is
     * not enrolled, the registry is missing, or the title already matches.
     */
    readonly syncRegistryTitle: (projectId: ProjectId) => Effect.Effect<void, RoamingEnrollError>;
    /**
     * The unified pairing handshake (M2.5): exchange the single-use pairing
     * credential once, establish the mirror when the credential allows it,
     * and always derive an attach bearer for the client. Attach-only against
     * peers the user does not administer is a first-class outcome.
     */
    readonly addPeer: (input: {
      readonly baseUrls: ReadonlyArray<string>;
      readonly pairingCredential: string;
      readonly syncOptions?: RoamingPairSyncOptions | undefined;
    }) => Effect.Effect<RoamingPairMachineResponse, RoamingEnrollError>;
    /**
     * Mint the long-lived machine credential for a caller peer and record it
     * as a peer of this machine (without connectivity of our own to it
     * unless it advertised base URLs).
     */
    readonly mintMachineCredential: (input: {
      readonly callerEnvironmentId: EnvironmentId;
      readonly callerBaseUrls: ReadonlyArray<string>;
      readonly syncOptions?: RoamingPairSyncOptions | undefined;
      readonly callerLabel?: string | undefined;
      /** The authenticating handshake session's label — the user's own name for the caller. */
      readonly sessionLabel?: string | undefined;
    }) => Effect.Effect<RoamingMachineCredentialResponse, RoamingEnrollError>;
  }
>()("t3/roaming/RoamingService") {}

const decodeMachineCredentialResponse = Schema.decodeUnknownEffect(
  RoamingMachineCredentialResponse,
);
const encodeMachineCredentialRequest = Schema.encodeUnknownEffect(RoamingMachineCredentialRequest);
const encodeAttachRegistration = Schema.encodeUnknownEffect(RoamingAttachRegistration);
// Only the credential is needed; the full AuthPairingCredentialResult
// carries DateTime fields whose wire codec belongs to the HttpApi client.
const decodePairingCredentialResult = Schema.decodeUnknownEffect(
  Schema.Struct({ credential: Schema.String.check(Schema.isMinLength(1)) }),
);
// Only the id (and, since M5.6, the display label) is needed from the
// peer's descriptor; decoding the full ExecutionEnvironmentDescriptor
// would couple the handshake to fields (capabilities, versions) it has no
// business validating.
const decodePeerDescriptor = Schema.decodeUnknownEffect(
  Schema.Struct({ environmentId: EnvironmentId, label: Schema.optional(Schema.String) }),
);
const encodeRegistryPayloadJson = Schema.encodeUnknownEffect(
  Schema.fromJsonString(RoamingRegistryPayload),
);
const decodeRegistryPayloadJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RoamingRegistryPayload),
);

const internalError = (detail: string) => (cause: unknown) =>
  new RoamingEnrollError({ reason: "internal", detail, cause });

const isRoamingEnrollError = Schema.is(RoamingEnrollError);

const make = Effect.gen(function* () {
  const blobStore = yield* RoamingBlobStore;
  const peers = yield* RoamingPeers;
  const peerMirror = yield* PeerMirror;
  const secretStore = yield* ServerSecretStore;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const engine = yield* OrchestrationEngineService;
  const projectRepository = yield* ProjectionProjectRepository;
  const identityResolver = yield* RepositoryIdentityResolver;
  const auth = yield* EnvironmentAuth;
  const settingsService = yield* ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const writeRegistryBlob = (input: {
    readonly workspaceProjectId: WorkspaceProjectId;
    readonly title: string;
    readonly workspaceRoot: string;
  }) =>
    Effect.gen(function* () {
      const repository = yield* identityResolver.resolve(input.workspaceRoot);
      if (repository === null) {
        return yield* new RoamingEnrollError({
          reason: "no-git-remote",
          detail: `${input.workspaceRoot} has no usable git remote`,
        });
      }
      const environmentId = yield* serverEnvironment.getEnvironmentId;
      // Registry payload is encoded once here; the resulting string is
      // byte-authoritative from now on (never re-serialized).
      const payloadJson = yield* encodeRegistryPayloadJson({
        workspaceProjectId: input.workspaceProjectId,
        title: input.title,
        repository,
        perMachineRoots: { [environmentId]: input.workspaceRoot },
      }).pipe(Effect.mapError(internalError("registry payload encode failed")));
      yield* blobStore
        .writeLocal({
          kind: "registry",
          key: input.workspaceProjectId,
          workspaceProjectId: input.workspaceProjectId,
          payload: payloadJson,
        })
        .pipe(Effect.mapError(internalError("registry blob write failed")));
    });

  const enrollProject: RoamingService["Service"]["enrollProject"] = Effect.fn(
    "RoamingService.enrollProject",
  )(function* (projectId) {
    const projectRow = yield* projectRepository
      .getById({ projectId })
      .pipe(Effect.mapError(internalError("project lookup failed")));
    if (projectRow._tag === "None" || projectRow.value.deletedAt !== null) {
      return yield* new RoamingEnrollError({ reason: "project-not-found", detail: projectId });
    }
    const project = projectRow.value;

    // Idempotent re-enroll, self-healing: if a previous attempt linked the
    // project but the registry blob write failed, write it now.
    if (project.workspaceProjectId != null) {
      const existing = yield* blobStore
        .get({ kind: "registry", key: project.workspaceProjectId })
        .pipe(Effect.mapError(internalError("registry blob lookup failed")));
      if (existing === null) {
        yield* writeRegistryBlob({
          workspaceProjectId: project.workspaceProjectId,
          title: project.title,
          workspaceRoot: project.workspaceRoot,
        });
        yield* peerMirror.syncNow();
      }
      return project.workspaceProjectId;
    }

    const workspaceProjectId = WorkspaceProjectId.make(
      yield* crypto.randomUUIDv4.pipe(Effect.orDie),
    );

    // Dispatch first: the decider is the gate against concurrent double
    // enrollment, so a losing race never leaves an orphan registry blob
    // that would mirror to peers as a ghost entry.
    const dispatchError = yield* engine
      .dispatch({
        type: "project.roaming.enroll",
        commandId: CommandId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
        projectId,
        workspaceProjectId,
        createdAt: yield* nowIso,
      })
      .pipe(
        Effect.as(null),
        Effect.catch((cause) => Effect.succeed(cause)),
      );
    if (dispatchError !== null) {
      // Losing the decider race is the designed outcome of a concurrent
      // enrollment (auto-enroll races the explicit route between the
      // idempotency check above and this dispatch) — adopt the winner's
      // link instead of surfacing an internal error (M5 ladder flake).
      const rechecked = yield* projectRepository
        .getById({ projectId })
        .pipe(Effect.mapError(internalError("project lookup failed")));
      const winner =
        rechecked._tag === "Some" ? (rechecked.value.workspaceProjectId ?? null) : null;
      if (winner === null) {
        return yield* internalError("project link dispatch failed")(dispatchError);
      }
      return winner;
    }

    yield* writeRegistryBlob({
      workspaceProjectId,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
    });

    yield* peerMirror.syncNow();
    return workspaceProjectId;
  });

  const syncRegistryTitle: RoamingService["Service"]["syncRegistryTitle"] = Effect.fn(
    "RoamingService.syncRegistryTitle",
  )(function* (projectId) {
    const projectRow = yield* projectRepository
      .getById({ projectId })
      .pipe(Effect.mapError(internalError("project lookup failed")));
    if (projectRow._tag === "None" || projectRow.value.deletedAt !== null) {
      return;
    }
    const project = projectRow.value;
    if (project.workspaceProjectId == null) {
      return;
    }
    const blob = yield* blobStore
      .get({ kind: "registry", key: project.workspaceProjectId })
      .pipe(Effect.mapError(internalError("registry blob lookup failed")));
    if (blob === null) {
      return;
    }
    const registry = yield* decodeRegistryPayloadJson(blob.payload).pipe(
      Effect.mapError(internalError("registry payload decode failed")),
    );
    if (registry.title === project.title) {
      return;
    }
    // Patch ONLY the title — perMachineRoots and vault overrides accumulate
    // contributions from other machines and must survive the rewrite.
    const payloadJson = yield* encodeRegistryPayloadJson({
      ...registry,
      title: project.title,
    }).pipe(Effect.mapError(internalError("registry payload encode failed")));
    yield* blobStore
      .writeLocal({
        kind: "registry",
        key: project.workspaceProjectId,
        workspaceProjectId: project.workspaceProjectId,
        payload: payloadJson,
      })
      .pipe(Effect.mapError(internalError("registry blob write failed")));
    yield* peerMirror.syncNow();
  });

  const exchangePairingCredential = (baseUrl: string, pairingCredential: string) =>
    Effect.gen(function* () {
      const response = yield* httpClient.post(`${baseUrl.replace(/\/$/, "")}/oauth/token`, {
        body: HttpBody.text(
          new URLSearchParams({
            grant_type: AuthTokenExchangeGrantType,
            subject_token: pairingCredential,
            subject_token_type: AuthEnvironmentBootstrapTokenType,
            requested_token_type: AuthAccessTokenType,
            client_label: "roaming-enrollment",
            client_device_type: "bot",
          }).toString(),
          "application/x-www-form-urlencoded",
        ),
      });
      // The peer answering 4xx is not "unreachable" — it looked at the code
      // and said no (already used, expired, or mistyped). Pairing codes are
      // one-time, and a browser login consumes them too; the distinction is
      // the difference between debugging the network and regenerating a code.
      if (response.status === 400 || response.status === 401 || response.status === 403) {
        return yield* new RoamingEnrollError({
          reason: "credential-rejected",
          detail: `the machine at ${baseUrl} rejected the pairing code (${response.status})`,
        });
      }
      const okResponse = yield* HttpClientResponse.filterStatusOk(response);
      const body = (yield* okResponse.json) as {
        readonly access_token?: string;
        readonly scope?: string;
        readonly expires_in?: number;
      };
      if (typeof body.access_token !== "string") {
        return yield* new RoamingEnrollError({
          reason: "peer-unreachable",
          detail: "token exchange returned no access_token",
        });
      }
      const now = yield* DateTime.now;
      return {
        token: body.access_token,
        // No scope is requested on the exchange: the credential is consumed
        // before the scope check, so asking for more than a weaker code
        // grants would burn it. The response says what we actually got.
        scopes: typeof body.scope === "string" ? body.scope.split(" ").filter(Boolean) : [],
        expiresAt:
          typeof body.expires_in === "number"
            ? DateTime.formatIso(DateTime.add(now, { milliseconds: body.expires_in * 1000 }))
            : null,
      };
    });

  const fetchPeerDescriptor = (baseUrl: string) =>
    httpClient.get(`${baseUrl.replace(/\/$/, "")}/.well-known/t3/environment`).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.flatMap(decodePeerDescriptor),
      Effect.mapError(internalError("peer descriptor fetch failed")),
    );

  const fetchPeerEnvironmentId = (baseUrl: string) =>
    fetchPeerDescriptor(baseUrl).pipe(Effect.map((descriptor) => descriptor.environmentId));

  /**
   * Derive the client's attach bearer: mint a standard-scoped pairing
   * credential on the peer with the handshake bearer, then exchange it. The
   * privileged handshake bearer itself is never returned to the client.
   */
  const deriveAttachGrant = (input: {
    readonly baseUrl: string;
    readonly handshakeToken: string;
    readonly peerEnvironmentId: EnvironmentId;
    readonly attachLabel: string;
  }) =>
    Effect.gen(function* () {
      const minted = yield* httpClient
        .pipe(
          HttpClient.mapRequest(
            HttpClientRequest.setHeader("authorization", `Bearer ${input.handshakeToken}`),
          ),
        )
        .post(`${input.baseUrl.replace(/\/$/, "")}/api/auth/pairing-token`, {
          body: HttpBody.jsonUnsafe({
            label: input.attachLabel,
            scopes: AuthStandardClientScopes,
          }),
        })
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((response) => response.json),
          Effect.flatMap(decodePairingCredentialResult),
          Effect.mapError(internalError("attach credential mint failed")),
        );
      const attach = yield* exchangePairingCredential(input.baseUrl, minted.credential).pipe(
        Effect.mapError((error) =>
          isRoamingEnrollError(error) ? error : internalError("attach exchange failed")(error),
        ),
      );
      return {
        environmentId: input.peerEnvironmentId,
        baseUrl: input.baseUrl,
        token: attach.token,
        expiresAt: attach.expiresAt,
      } satisfies RoamingAttachGrant;
    });

  const addPeer: RoamingService["Service"]["addPeer"] = Effect.fn("RoamingService.addPeer")(
    function* (input) {
      const environmentId = yield* serverEnvironment.getEnvironmentId;

      // Reach the peer: the first base URL that completes the exchange wins,
      // and the rest of the handshake sticks to it — the code is consumed by
      // that exchange, so retrying another URL could only mislabel the
      // failure as "rejected".
      let exchange: {
        readonly token: string;
        readonly scopes: ReadonlyArray<string>;
        readonly expiresAt: string | null;
      } | null = null;
      let reachableBaseUrl: string | null = null;
      let lastCause: unknown = null;
      for (const baseUrl of input.baseUrls) {
        const attempt = yield* exchangePairingCredential(baseUrl, input.pairingCredential).pipe(
          Effect.exit,
        );
        if (attempt._tag === "Success") {
          exchange = attempt.value;
          reachableBaseUrl = baseUrl;
          break;
        }
        // A rejected code fails identically on every URL — surface it now
        // instead of letting the retry loop relabel it "unreachable".
        const rejected = attempt.cause.reasons
          .filter(Cause.isFailReason)
          .map((reason) => reason.error)
          .find(
            (error): error is RoamingEnrollError =>
              isRoamingEnrollError(error) && error.reason === "credential-rejected",
          );
        if (rejected !== undefined) {
          return yield* rejected;
        }
        lastCause = attempt.cause;
      }
      if (exchange === null || reachableBaseUrl === null) {
        // Log only failure tags, never the raw cause: a transport-failure
        // cause embeds the HTTP request whose form body carries the
        // still-live pairing credential, and a structured logger would
        // emit it.
        yield* Effect.logDebug("roaming: peer enrollment failed", {
          failureTags: Cause.isCause(lastCause)
            ? lastCause.reasons.map((reason) =>
                Cause.isFailReason(reason)
                  ? ((reason.error as { readonly _tag?: string })._tag ?? "unknown-failure")
                  : reason._tag,
              )
            : [],
          baseUrlCount: input.baseUrls.length,
        });
        return yield* new RoamingEnrollError({
          reason: "peer-unreachable",
          detail: `no base URL of ${input.baseUrls.join(", ")} completed enrollment`,
        });
      }

      // Attach-only degradation: the same dialog attaches to servers the
      // user does not administer. The exchanged bearer carries at most the
      // code's own grant (which lacks access:write here), so returning it is
      // no broader than what plain pairing would have produced.
      if (!exchange.scopes.includes(AuthAccessWriteScope)) {
        const peerEnvironmentId = yield* fetchPeerEnvironmentId(reachableBaseUrl);
        // Re-pairing an ALREADY-mirrored machine with a standard code must
        // not claim sync is unavailable — the existing credential keeps the
        // mirror alive regardless of this handshake (field finding). A bare
        // ensurePeer row is not enough: without the stored credential this
        // machine cannot initiate mirror passes (PeerMirror skips it).
        const peerRow =
          (yield* peers.list().pipe(Effect.orElseSucceed(() => []))).find(
            (candidate) => candidate.environmentId === peerEnvironmentId,
          ) ?? null;
        const hasCredential =
          peerRow !== null &&
          Option.isSome(
            yield* secretStore
              .get(roamingPeerSecretName(peerEnvironmentId))
              .pipe(Effect.orElseSucceed(() => Option.none())),
          );
        const existingPeer = hasCredential ? peerRow : null;
        return {
          attach: {
            environmentId: peerEnvironmentId,
            baseUrl: reachableBaseUrl,
            token: exchange.token,
            expiresAt: exchange.expiresAt,
          },
          peer: existingPeer,
          mirrorUnavailableReason: existingPeer !== null ? null : "credential-not-administrative",
        } satisfies RoamingPairMachineResponse;
      }

      // Mirror half. The server cannot discover its own reachable URLs
      // (M1 analysis), so it advertises none; the peer reaches us or we
      // reach it.
      const ownLabel = (yield* serverEnvironment.getDescriptor).label;
      const requestBody = yield* encodeMachineCredentialRequest({
        environmentId,
        baseUrls: [],
        ...(input.syncOptions !== undefined ? { syncOptions: input.syncOptions } : {}),
        callerLabel: ownLabel,
      }).pipe(Effect.mapError(internalError("machine credential request encode failed")));
      const mintResponse = yield* httpClient
        .pipe(
          HttpClient.mapRequest(
            HttpClientRequest.setHeader("authorization", `Bearer ${exchange.token}`),
          ),
        )
        .post(`${reachableBaseUrl.replace(/\/$/, "")}${ROAMING_MACHINE_CREDENTIAL_PATH}`, {
          body: HttpBody.jsonUnsafe(requestBody),
        })
        .pipe(Effect.mapError(internalError("machine credential request failed")));

      let credential: RoamingMachineCredentialResponse | null = null;
      let mirrorUnavailableReason: RoamingPairMachineResponse["mirrorUnavailableReason"] = null;
      if (mintResponse.status === 404) {
        // An upstream T3 server without roaming routes: attach still works.
        mirrorUnavailableReason = "peer-does-not-support-machine-pairing";
      } else {
        credential = yield* HttpClientResponse.filterStatusOk(mintResponse).pipe(
          Effect.flatMap((response) => response.json),
          Effect.flatMap(decodeMachineCredentialResponse),
          Effect.mapError(internalError("machine credential mint failed")),
        );
      }

      // Attach half — always freshly derived; the privileged handshake
      // bearer never leaves this process. Derived BEFORE anything persists
      // locally, so a failure here leaves no half-paired state (the code is
      // spent either way; the peer-side credential ages out).
      const attach = yield* deriveAttachGrant({
        baseUrl: reachableBaseUrl,
        handshakeToken: exchange.token,
        peerEnvironmentId:
          credential !== null
            ? credential.environmentId
            : yield* fetchPeerEnvironmentId(reachableBaseUrl),
        attachLabel: credential?.label ?? ownLabel,
      });

      // Reverse half (M5.6): make the CALLEE's clients full citizens too.
      // Mint a standard-scoped attach bearer for them (subject
      // `roaming-peer:<callee>` so the one-device grouping and the unpair
      // revocation sweep cover it) and register it on the callee together
      // with our best-effort self-advertised URLs. Best-effort end to end:
      // a pre-M5.6 callee answers 404 and pairing stays one-directional.
      // Runs while the handshake bearer is still valid.
      if (credential !== null) {
        yield* Effect.gen(function* () {
          const runtimeState = yield* readPersistedServerRuntimeState(
            config.serverRuntimeStatePath,
          ).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));
          const port = Option.isSome(runtimeState) ? runtimeState.value.port : config.port;
          // The session represents the CALLEE on this machine's authorized
          // clients — name it after the callee, not the pairing link (which
          // names US).
          const peerLabel = yield* fetchPeerDescriptor(reachableBaseUrl).pipe(
            Effect.map((descriptor) => descriptor.label),
            Effect.orElseSucceed(() => undefined),
          );
          const reverseSession = yield* auth.issueSession({
            ttl: MACHINE_CREDENTIAL_TTL,
            scopes: [...AuthStandardClientScopes],
            subject: `roaming-peer:${credential.environmentId}`,
            label: `${peerLabel ?? credential.environmentId} — attach`,
          });
          const registrationBody = yield* encodeAttachRegistration({
            environmentId,
            label: ownLabel,
            baseUrls: advertisedBaseUrls(config.host, port),
            token: reverseSession.token,
            expiresAt: DateTime.formatIso(reverseSession.expiresAt),
          });
          const response = yield* httpClient
            .pipe(
              HttpClient.mapRequest(
                HttpClientRequest.setHeader("authorization", `Bearer ${exchange.token}`),
              ),
            )
            .post(`${reachableBaseUrl.replace(/\/$/, "")}${ROAMING_ATTACH_REGISTRATION_PATH}`, {
              body: HttpBody.jsonUnsafe(registrationBody),
            });
          if (response.status === 404) {
            // Old callee: revoke the unused session instead of leaving a
            // 365-day orphan.
            yield* auth.revokeSession(reverseSession.sessionId).pipe(Effect.ignore);
            yield* Effect.logInfo(
              "roaming: peer does not support bidirectional pairing; reverse attach skipped",
            );
            return;
          }
          yield* HttpClientResponse.filterStatusOk(response);
        }).pipe(
          Effect.catch((cause) =>
            // Never the raw cause: the request bodies above carry live
            // bearer tokens a structured logger would emit.
            Effect.logWarning("roaming: reverse attach registration failed", {
              failureTag: (cause as { readonly _tag?: string })._tag ?? "unknown-failure",
            }),
          ),
        );
      }

      // Retire the handshake session: the generic revoke endpoint forbids
      // self-revocation, so the roaming handshake-complete route exists for
      // exactly this. Best-effort — a failure leaves a labeled session that
      // ages out on TTL.
      yield* httpClient
        .pipe(
          HttpClient.mapRequest(
            HttpClientRequest.setHeader("authorization", `Bearer ${exchange.token}`),
          ),
        )
        .post(`${reachableBaseUrl.replace(/\/$/, "")}${ROAMING_HANDSHAKE_COMPLETE_PATH}`, {
          body: HttpBody.jsonUnsafe({}),
        })
        .pipe(Effect.ignore);

      let peer: RoamingPeer | null = null;
      if (credential !== null) {
        yield* secretStore
          .set(
            roamingPeerSecretName(credential.environmentId),
            new TextEncoder().encode(credential.token),
          )
          .pipe(Effect.mapError(internalError("peer credential store failed")));
        // lastContactAt stays null until a mirror pass actually completes —
        // enrollment moving zero blobs must not read as "just synced".
        peer = {
          environmentId: credential.environmentId,
          baseUrls: input.baseUrls,
          lastContactAt: null,
          enrolledAt: yield* nowIso,
          syncEnabled: true,
        };
        // The peer row IS the on-switch: roaming derives from peer existence
        // (D3), so upserting the first peer turns the subsystem on.
        yield* peers.upsert(peer).pipe(Effect.mapError(internalError("peer record failed")));
        // The dialog's sync options are the local user's explicit choice, so
        // they apply unconditionally.
        if (input.syncOptions !== undefined) {
          yield* settingsService
            .updateSettings({
              ...(input.syncOptions.secretsSync !== undefined
                ? { roamingSecretsSync: input.syncOptions.secretsSync }
                : {}),
              ...(input.syncOptions.wipSync !== undefined
                ? { roamingWipSync: input.syncOptions.wipSync }
                : {}),
              ...(input.syncOptions.transcriptSync !== undefined
                ? { roamingTranscriptSync: input.syncOptions.transcriptSync }
                : {}),
            })
            .pipe(Effect.mapError(internalError("local settings update failed")));
        }
        yield* peerMirror.syncNow();
      }

      return { attach, peer, mirrorUnavailableReason } satisfies RoamingPairMachineResponse;
    },
  );

  const mintMachineCredential: RoamingService["Service"]["mintMachineCredential"] = Effect.fn(
    "RoamingService.mintMachineCredential",
  )(function* (input) {
    const environmentId = yield* serverEnvironment.getEnvironmentId;
    const session = yield* auth
      .issueSession({
        ttl: MACHINE_CREDENTIAL_TTL,
        scopes: [AuthRoamingMirrorScope],
        subject: `roaming-peer:${input.callerEnvironmentId}`,
        // The label the user typed on the pairing link wins; machine names
        // are fallbacks only (field finding: never override "Laptop" with a
        // hostname).
        label: `${input.sessionLabel ?? input.callerLabel ?? input.callerEnvironmentId} — sync`,
      })
      .pipe(Effect.mapError(internalError("machine credential issue failed")));

    // First pairing or re-pair? Decided BEFORE the caller's row lands: the
    // received sync options may only seed consents on a machine that has
    // never paired (G8) — an explicit prior choice is never overridden by a
    // re-pair.
    const isFirstPairing = !(yield* peers.roamingEnabled);

    // Record the caller's existence only. Its advertised base URLs are
    // deliberately ignored: a caller identifying itself is not authority to
    // (re)direct our outbound mirror traffic, and we hold no credential for
    // it anyway — data flows when it contacts us. Since D3 this row is also
    // what turns roaming on for this machine.
    yield* peers
      .ensurePeer(input.callerEnvironmentId, yield* nowIso)
      .pipe(Effect.mapError(internalError("caller peer record failed")));

    // ONE secrets decision for the pairing (2026-07-06, user override of the
    // M2 'each machine consents to its own files' rule): on FIRST pairing the
    // dialog's Secret-files choice applies here — so the machine holding a
    // project captures its secrets without a second toggle anywhere. There is
    // deliberately no secrets control on this (the paired-into) machine; the
    // choice rides the pairing. The same one-decision rule covers Work in
    // progress. A re-pair never overrides this machine's existing choice.
    if (isFirstPairing && input.syncOptions !== undefined) {
      yield* settingsService
        .updateSettings({
          ...(input.syncOptions.secretsSync !== undefined
            ? { roamingSecretsSync: input.syncOptions.secretsSync }
            : {}),
          ...(input.syncOptions.wipSync !== undefined
            ? { roamingWipSync: input.syncOptions.wipSync }
            : {}),
          ...(input.syncOptions.transcriptSync !== undefined
            ? { roamingTranscriptSync: input.syncOptions.transcriptSync }
            : {}),
        })
        .pipe(Effect.mapError(internalError("settings update failed")));
    }

    return {
      environmentId,
      token: session.token,
      expiresAt: DateTime.formatIso(session.expiresAt),
      ...(input.sessionLabel !== undefined ? { label: input.sessionLabel } : {}),
    };
  });

  return {
    enrollProject,
    syncRegistryTitle,
    addPeer,
    mintMachineCredential,
  } satisfies RoamingService["Service"];
});

export const layer = Layer.effect(RoamingService, make);
