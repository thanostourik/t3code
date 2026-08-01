import {
  EnvironmentId,
  ROAMING_ATTACH_REGISTRATION_PATH,
  ROAMING_ATTACH_REGISTRATION_WITHDRAW_PATH,
} from "@t3tools/contracts";
import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import { ServerConfig } from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { ReverseAttach, layer as reverseAttachLayer } from "./ReverseAttach.ts";

const OWN_ENVIRONMENT_ID = EnvironmentId.make("env-own");
const PEER_ENVIRONMENT_ID = EnvironmentId.make("env-peer");
const PEER_BASE_URL = "http://peer.test:14802";
const MIRROR_TOKEN = "mirror-credential-token";

const jsonResponse = (request: HttpClientRequest.HttpClientRequest, body: unknown, status = 200) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );

interface PeerCall {
  readonly path: string;
  readonly body: unknown;
  readonly authorization: string | undefined;
}

interface AuthEvent {
  readonly kind: "issue" | "revoke";
  readonly sessionId: string;
}

const serverEnvironmentStub = Layer.succeed(ServerEnvironment.ServerEnvironment, {
  getEnvironmentId: Effect.succeed(OWN_ENVIRONMENT_ID),
  getDescriptor: Effect.succeed({ label: "Test Laptop" }) as never,
});

const configStub = (host: string) =>
  Layer.succeed(ServerConfig, {
    host,
    port: 14800,
    serverRuntimeStatePath: "/nonexistent/server-runtime.json",
  } as unknown as ServerConfig["Service"]);

const makeAuthLayer = (events: Ref.Ref<ReadonlyArray<AuthEvent>>, sessions: string[]) =>
  Layer.succeed(EnvironmentAuth, {
    issueSession: () =>
      Effect.gen(function* () {
        const sessionId = `session-${sessions.length}`;
        sessions.push(sessionId);
        yield* Ref.update(events, (log) => [...log, { kind: "issue" as const, sessionId }]);
        return {
          token: `reverse-token-${sessionId}`,
          expiresAt: yield* DateTime.now,
          sessionId,
        };
      }),
    listSessions: () =>
      Effect.succeed(
        sessions.map((sessionId) => ({
          sessionId,
          subject: `roaming-peer:${PEER_ENVIRONMENT_ID}`,
        })),
      ),
    revokeSession: (sessionId: string) =>
      Effect.gen(function* () {
        const index = sessions.indexOf(sessionId);
        if (index >= 0) sessions.splice(index, 1);
        yield* Ref.update(events, (log) => [...log, { kind: "revoke" as const, sessionId }]);
        return true;
      }),
  } as unknown as EnvironmentAuth["Service"]);

const makePeerHttpLayer = (
  calls: Ref.Ref<ReadonlyArray<PeerCall>>,
  options?: { readonly registrationStatus?: number },
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.gen(function* () {
        const bodyText =
          request.body._tag === "Uint8Array"
            ? new TextDecoder().decode((request.body as HttpBody.Uint8Array).body)
            : "";
        yield* Ref.update(calls, (log) => [
          ...log,
          {
            path: url.pathname,
            body: bodyText.length > 0 ? JSON.parse(bodyText) : null,
            authorization: request.headers["authorization"],
          },
        ]);
        if (url.pathname === ROAMING_ATTACH_REGISTRATION_PATH) {
          const status = options?.registrationStatus ?? 200;
          return status === 200
            ? jsonResponse(request, { registered: true })
            : jsonResponse(request, { error: "nope" }, status);
        }
        if (url.pathname === ROAMING_ATTACH_REGISTRATION_WITHDRAW_PATH) {
          return jsonResponse(request, { removed: true });
        }
        return jsonResponse(request, { error: "unexpected path" }, 500);
      }),
    ),
  );

const runEnsure = (input: {
  readonly host: string;
  readonly registrationStatus?: number;
  readonly passes?: number;
}) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<PeerCall>>([]);
    const authEvents = yield* Ref.make<ReadonlyArray<AuthEvent>>([]);
    const sessions: string[] = [];
    const testLayer = reverseAttachLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          makePeerHttpLayer(calls, {
            ...(input.registrationStatus !== undefined
              ? { registrationStatus: input.registrationStatus }
              : {}),
          }),
          makeAuthLayer(authEvents, sessions),
          serverEnvironmentStub,
          configStub(input.host),
        ),
      ),
      Layer.provideMerge(NodeServices.layer),
    );
    return yield* Effect.gen(function* () {
      const service = yield* ReverseAttach;
      for (let pass = 0; pass < (input.passes ?? 1); pass++) {
        yield* service.ensureForPeer({
          peerEnvironmentId: PEER_ENVIRONMENT_ID,
          baseUrl: PEER_BASE_URL,
          mirrorToken: MIRROR_TOKEN,
        });
      }
      return {
        calls: yield* Ref.get(calls),
        authEvents: yield* Ref.get(authEvents),
        liveSessions: [...sessions],
      };
    }).pipe(Effect.provide(testLayer));
  });

it.effect("routable server pushes its registration over the mirror credential, once", () =>
  Effect.gen(function* () {
    const { calls, liveSessions } = yield* runEnsure({ host: "192.168.1.42", passes: 3 });
    // Three passes, ONE push — the signature dedupes unchanged addresses.
    const pushes = calls.filter((call) => call.path === ROAMING_ATTACH_REGISTRATION_PATH);
    assert.lengthOf(pushes, 1);
    const body = pushes[0]!.body as {
      environmentId: string;
      label: string;
      baseUrls: ReadonlyArray<string>;
      token: string;
    };
    assert.strictEqual(pushes[0]!.authorization, `Bearer ${MIRROR_TOKEN}`);
    assert.strictEqual(body.environmentId, OWN_ENVIRONMENT_ID);
    assert.strictEqual(body.label, "Test Laptop");
    assert.deepStrictEqual(body.baseUrls, ["http://192.168.1.42:14800"]);
    assert.strictEqual(body.token, "reverse-token-session-0");
    // The pushed session stays live.
    assert.deepStrictEqual(liveSessions, ["session-0"]);
  }),
);

it.effect("loopback-only server withdraws instead of pushing, and revokes its sessions", () =>
  Effect.gen(function* () {
    const { calls, liveSessions } = yield* runEnsure({ host: "127.0.0.1", passes: 3 });
    const pushes = calls.filter((call) => call.path === ROAMING_ATTACH_REGISTRATION_PATH);
    const withdrawals = calls.filter(
      (call) => call.path === ROAMING_ATTACH_REGISTRATION_WITHDRAW_PATH,
    );
    assert.lengthOf(pushes, 0);
    // One withdrawal; later passes no-op on the signature.
    assert.lengthOf(withdrawals, 1);
    assert.strictEqual(withdrawals[0]!.authorization, `Bearer ${MIRROR_TOKEN}`);
    assert.lengthOf(liveSessions, 0);
  }),
);

it.effect("a peer without the route (404) revokes the unused session and stops retrying", () =>
  Effect.gen(function* () {
    const { calls, authEvents, liveSessions } = yield* runEnsure({
      host: "192.168.1.42",
      registrationStatus: 404,
      passes: 3,
    });
    const pushes = calls.filter((call) => call.path === ROAMING_ATTACH_REGISTRATION_PATH);
    // One attempt, then settled until the addresses change or a restart.
    assert.lengthOf(pushes, 1);
    assert.deepStrictEqual(
      authEvents.map((event) => event.kind),
      ["issue", "revoke"],
    );
    assert.lengthOf(liveSessions, 0);
  }),
);

it.effect("a transient failure revokes the unused session and retries next pass", () =>
  Effect.gen(function* () {
    const { calls, liveSessions } = yield* runEnsure({
      host: "192.168.1.42",
      registrationStatus: 500,
      passes: 3,
    });
    const pushes = calls.filter((call) => call.path === ROAMING_ATTACH_REGISTRATION_PATH);
    // Retried every pass — the signature is only recorded on success/404.
    assert.lengthOf(pushes, 3);
    // No session left behind by the failed attempts.
    assert.lengthOf(liveSessions, 0);
  }),
);
