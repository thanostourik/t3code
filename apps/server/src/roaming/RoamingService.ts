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
  AuthRoamingMirrorScope,
  AuthTokenExchangeGrantType,
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  CommandId,
  EnvironmentId,
  ProjectId,
  ROAMING_MACHINE_CREDENTIAL_PATH,
  RoamingMachineCredentialRequest,
  RoamingMachineCredentialResponse,
  type RoamingPeer,
  RoamingRegistryPayload,
  WorkspaceProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
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
    /** Enroll a peer machine from a pairing credential it minted. */
    readonly addPeer: (input: {
      readonly baseUrls: ReadonlyArray<string>;
      readonly pairingCredential: string;
    }) => Effect.Effect<RoamingPeer, RoamingEnrollError>;
    /**
     * Mint the long-lived machine credential for a caller peer and record it
     * as a peer of this machine (without connectivity of our own to it
     * unless it advertised base URLs).
     */
    readonly mintMachineCredential: (input: {
      readonly callerEnvironmentId: EnvironmentId;
      readonly callerBaseUrls: ReadonlyArray<string>;
    }) => Effect.Effect<RoamingMachineCredentialResponse, RoamingEnrollError>;
  }
>()("t3/roaming/RoamingService") {}

const decodeMachineCredentialResponse = Schema.decodeUnknownEffect(
  RoamingMachineCredentialResponse,
);
const encodeMachineCredentialRequest = Schema.encodeUnknownEffect(RoamingMachineCredentialRequest);
const encodeRegistryPayloadJson = Schema.encodeUnknownEffect(
  Schema.fromJsonString(RoamingRegistryPayload),
);

const internalError = (detail: string) => (cause: unknown) =>
  new RoamingEnrollError({ reason: "internal", detail, cause });

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
  const httpClient = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;

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
        vaultManifest: [],
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
    yield* engine
      .dispatch({
        type: "project.roaming.enroll",
        commandId: CommandId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
        projectId,
        workspaceProjectId,
        createdAt: yield* nowIso,
      })
      .pipe(Effect.mapError(internalError("project link dispatch failed")));

    yield* writeRegistryBlob({
      workspaceProjectId,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
    });

    yield* peerMirror.syncNow();
    return workspaceProjectId;
  });

  const exchangePairingCredential = (baseUrl: string, pairingCredential: string) =>
    Effect.gen(function* () {
      const response = yield* httpClient
        .post(`${baseUrl.replace(/\/$/, "")}/oauth/token`, {
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
        })
        .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
      const body = (yield* response.json) as { readonly access_token?: string };
      if (typeof body.access_token !== "string") {
        return yield* new RoamingEnrollError({
          reason: "peer-unreachable",
          detail: "token exchange returned no access_token",
        });
      }
      return body.access_token;
    });

  const addPeer: RoamingService["Service"]["addPeer"] = Effect.fn("RoamingService.addPeer")(
    function* (input) {
      const environmentId = yield* serverEnvironment.getEnvironmentId;

      let lastCause: unknown = null;
      for (const baseUrl of input.baseUrls) {
        const attempt = yield* Effect.gen(function* () {
          const shortToken = yield* exchangePairingCredential(baseUrl, input.pairingCredential);
          // The server cannot discover its own reachable URLs (M1 analysis),
          // so it advertises none; the peer reaches us or we reach it.
          const requestBody = yield* encodeMachineCredentialRequest({
            environmentId,
            baseUrls: [],
          });
          const raw = yield* httpClient
            .pipe(
              HttpClient.mapRequest(
                HttpClientRequest.setHeader("authorization", `Bearer ${shortToken}`),
              ),
            )
            .post(`${baseUrl.replace(/\/$/, "")}${ROAMING_MACHINE_CREDENTIAL_PATH}`, {
              body: HttpBody.jsonUnsafe(requestBody),
            })
            .pipe(
              Effect.flatMap(HttpClientResponse.filterStatusOk),
              Effect.flatMap((response) => response.json),
            );
          return yield* decodeMachineCredentialResponse(raw);
        }).pipe(Effect.exit);

        if (attempt._tag === "Success") {
          const credential = attempt.value;
          yield* secretStore
            .set(
              roamingPeerSecretName(credential.environmentId),
              new TextEncoder().encode(credential.token),
            )
            .pipe(Effect.mapError(internalError("peer credential store failed")));
          // lastContactAt stays null until a mirror pass actually completes —
          // enrollment moving zero blobs must not read as "just synced".
          const peer: RoamingPeer = {
            environmentId: credential.environmentId,
            baseUrls: input.baseUrls,
            lastContactAt: null,
            enrolledAt: yield* nowIso,
          };
          yield* peers.upsert(peer).pipe(Effect.mapError(internalError("peer record failed")));
          yield* peerMirror.syncNow();
          return peer;
        }
        lastCause = attempt.cause;
      }

      // Log the cause locally but do not attach it to the returned error:
      // failed exchange attempts can embed the pairing credential.
      yield* Effect.logDebug("roaming: peer enrollment failed", { cause: lastCause });
      return yield* new RoamingEnrollError({
        reason: "peer-unreachable",
        detail: `no base URL of ${input.baseUrls.join(", ")} completed enrollment`,
      });
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
        label: `Roaming mirror credential for ${input.callerEnvironmentId}`,
      })
      .pipe(Effect.mapError(internalError("machine credential issue failed")));

    // Record the caller's existence only. Its advertised base URLs are
    // deliberately ignored: a caller identifying itself is not authority to
    // (re)direct our outbound mirror traffic, and we hold no credential for
    // it anyway — data flows when it contacts us.
    yield* peers
      .ensurePeer(input.callerEnvironmentId, yield* nowIso)
      .pipe(Effect.mapError(internalError("caller peer record failed")));

    return {
      environmentId,
      token: session.token,
      expiresAt: DateTime.formatIso(session.expiresAt),
    };
  });

  return { enrollProject, addPeer, mintMachineCredential } satisfies RoamingService["Service"];
});

export const layer = Layer.effect(RoamingService, make);
