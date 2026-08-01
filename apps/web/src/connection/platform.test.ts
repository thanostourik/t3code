import {
  AuthStandardClientScopes,
  EnvironmentId,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type DesktopBridge,
  type DesktopSshEnvironmentTarget,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";

import {
  buildRoamingRegistration,
  canRetainCachedPlatformRegistrationAfterRefreshFailure,
  canReuseCachedPlatformRegistration,
  primaryRegistrationToRetainAfterTopologyRead,
  provisionDesktopSshEnvironment,
  readPrimaryEnvironmentTargetResult,
  roamingRegistrationSignature,
  secondaryRegistrationsToRetainAfterTopologyRead,
  secondaryBearerExpiresAtEpochMs,
  secondaryBearerRefreshAtEpochMs,
} from "./platform.ts";

const TARGET: DesktopSshEnvironmentTarget = {
  alias: "devbox",
  hostname: "devbox.example.test",
  username: "developer",
  port: 22,
};

function makeBridge(
  calls: string[],
  options?: { readonly failDescriptor?: boolean },
): DesktopBridge {
  return {
    ensureSshEnvironment: async (target: DesktopSshEnvironmentTarget) => {
      calls.push("ensure");
      return {
        target,
        httpBaseUrl: "http://127.0.0.1:3201/",
        wsBaseUrl: "ws://127.0.0.1:3201/",
        pairingToken: "pairing-token",
      };
    },
    fetchSshEnvironmentDescriptor: async () => {
      calls.push("descriptor");
      if (options?.failDescriptor === true) {
        throw new Error("descriptor unavailable");
      }
      return {
        environmentId: EnvironmentId.make("environment-ssh"),
        label: "SSH environment",
        platform: {
          os: "linux",
          arch: "x64",
        },
        serverVersion: "0.0.0-test",
        capabilities: {
          repositoryIdentity: true,
        },
      };
    },
    bootstrapSshBearerSession: async () => {
      calls.push("token");
      return {
        access_token: "bearer-token",
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        token_type: "Bearer",
        expires_in: 3_600,
        scope: AuthStandardClientScopes.join(" "),
      };
    },
  } as unknown as DesktopBridge;
}

describe("desktop SSH pairing", () => {
  it.effect("fetches the descriptor before consuming the one-time credential", () =>
    Effect.gen(function* () {
      const calls: string[] = [];

      const provisioned = yield* provisionDesktopSshEnvironment(makeBridge(calls), TARGET);

      expect(provisioned.environmentId).toBe(EnvironmentId.make("environment-ssh"));
      expect(calls).toEqual(["ensure", "descriptor", "token"]);
    }),
  );

  it.effect("does not consume the credential when descriptor discovery fails", () =>
    Effect.gen(function* () {
      const calls: string[] = [];

      yield* provisionDesktopSshEnvironment(
        makeBridge(calls, { failDescriptor: true }),
        TARGET,
      ).pipe(Effect.flip);

      expect(calls).toEqual(["ensure", "descriptor"]);
    }),
  );
});

describe("desktop-local bearer cache", () => {
  const registration = {} as never;

  it("refreshes a secondary bearer before it expires", () => {
    const issuedAtEpochMs = 10_000;
    const refreshAtEpochMs = secondaryBearerRefreshAtEpochMs(issuedAtEpochMs, 60);
    const expiresAtEpochMs = secondaryBearerExpiresAtEpochMs(issuedAtEpochMs, 60);
    const cached = {
      expiresAtEpochMs,
      signature: "secondary-signature",
      registration,
      refreshAtEpochMs,
    };

    expect(refreshAtEpochMs).toBe(65_000);
    expect(canReuseCachedPlatformRegistration(cached, cached.signature, 64_999)).toBe(true);
    expect(canReuseCachedPlatformRegistration(cached, cached.signature, 65_000)).toBe(false);
    expect(
      canRetainCachedPlatformRegistrationAfterRefreshFailure(cached, cached.signature, 69_999),
    ).toBe(true);
    expect(
      canRetainCachedPlatformRegistrationAfterRefreshFailure(cached, cached.signature, 70_000),
    ).toBe(false);
  });

  it("does not cache credentials whose lifetime is shorter than the refresh skew", () => {
    const refreshAtEpochMs = secondaryBearerRefreshAtEpochMs(10_000, 3);
    const cached = {
      expiresAtEpochMs: secondaryBearerExpiresAtEpochMs(10_000, 3),
      signature: "secondary-signature",
      registration,
      refreshAtEpochMs,
    };

    expect(refreshAtEpochMs).toBe(10_000);
    expect(canReuseCachedPlatformRegistration(cached, cached.signature, 10_000)).toBe(false);
  });

  it("retains only unexpired secondaries after a topology read failure", () => {
    const valid = {
      expiresAtEpochMs: 20_000,
      signature: "valid-secondary",
      registration,
      refreshAtEpochMs: 15_000,
    };
    const previous = new Map([
      ["valid-secondary", valid],
      [
        "expired-secondary",
        {
          expiresAtEpochMs: 10_000,
          signature: "expired-secondary",
          registration,
          refreshAtEpochMs: 5_000,
        },
      ],
    ]);

    expect(
      secondaryRegistrationsToRetainAfterTopologyRead(
        previous,
        { _tag: "Failure", cause: new Error("IPC unavailable") },
        10_000,
      ),
    ).toEqual(new Map([["valid-secondary", valid]]));
  });

  it("treats a successful empty topology as authoritative removal", () => {
    const previous = new Map([
      [
        "secondary",
        {
          expiresAtEpochMs: 20_000,
          signature: "secondary",
          registration,
          refreshAtEpochMs: 15_000,
        },
      ],
    ]);

    expect(
      secondaryRegistrationsToRetainAfterTopologyRead(
        previous,
        { _tag: "Success", bootstraps: [] },
        10_000,
      ),
    ).toEqual(new Map());
  });
});

describe("primary topology cache", () => {
  const registration = {} as never;
  const cached = {
    signature: "primary|http://127.0.0.1:3773/|ws://127.0.0.1:3773/",
    registration,
  };
  const previous = new Map([[PRIMARY_LOCAL_ENVIRONMENT_ID, cached]]);

  it("captures synchronous primary target read failures", () => {
    const cause = new Error("invalid primary target");

    expect(
      readPrimaryEnvironmentTargetResult(() => {
        throw cause;
      }),
    ).toEqual({ _tag: "Failure", cause });
  });

  it("retains the cached primary after a transient topology read failure", () => {
    expect(
      primaryRegistrationToRetainAfterTopologyRead(previous, {
        _tag: "Failure",
        cause: new Error("IPC unavailable"),
      }),
    ).toBe(cached);
  });

  it("treats a successful primary absence as authoritative removal", () => {
    expect(
      primaryRegistrationToRetainAfterTopologyRead(previous, {
        _tag: "Success",
        target: null,
      }),
    ).toBeUndefined();
  });
});

describe("buildRoamingRegistration (M5.6)", () => {
  const INITIATOR_ID = EnvironmentId.make("env-initiator");
  const registration = {
    environmentId: INITIATOR_ID,
    label: "Laptop",
    baseUrls: ["http://10.0.0.5:14801", "http://127.0.0.1:14801"],
    token: "attach-token",
    expiresAt: null,
  };

  // Serves /.well-known/t3/environment per origin; other origins fail.
  const descriptorHttpLayer = (byOrigin: Record<string, string>) =>
    FetchHttpClient.layer.pipe(
      Layer.provide(
        Layer.succeed(FetchHttpClient.Fetch, ((input: RequestInfo | URL) => {
          const url = new URL(
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
          );
          const environmentId = byOrigin[url.origin];
          if (environmentId === undefined) {
            return Promise.reject(new Error("connection refused"));
          }
          return Promise.resolve(
            new Response(
              JSON.stringify({
                environmentId,
                label: "Laptop",
                platform: { os: "linux", arch: "x64" },
                serverVersion: "0.0.0-test",
                capabilities: { repositoryIdentity: true },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }) as typeof fetch),
      ),
    );

  it.effect("picks the first candidate whose descriptor matches the registered environment", () =>
    Effect.gen(function* () {
      const built = yield* buildRoamingRegistration(registration);
      expect(built?.verified).toBe(true);
      expect(built?.registration.profile.httpBaseUrl).toBe("http://127.0.0.1:14801/");
      expect(built?.registration.target.connectionId).toBe(`bearer:${INITIATOR_ID}`);
      expect(built?.registration.credential.token).toBe("attach-token");
    }).pipe(
      // First candidate answers as the WRONG environment (loopback echo of
      // another machine) — it must be skipped, not trusted.
      Effect.provide(
        descriptorHttpLayer({
          "http://10.0.0.5:14801": "env-someone-else",
          "http://127.0.0.1:14801": INITIATOR_ID,
        }),
      ),
    ),
  );

  it.effect("installs unverified on the first SILENT candidate when nothing answers", () =>
    Effect.gen(function* () {
      const built = yield* buildRoamingRegistration(registration);
      expect(built?.verified).toBe(false);
      expect(built?.registration.profile.httpBaseUrl).toBe("http://10.0.0.5:14801/");
    }).pipe(Effect.provide(descriptorHttpLayer({}))),
  );

  // The 2026-07-31 field bug: a loopback-only advertisement made the reader
  // probe its OWN backend, which answers as itself forever. Installing it
  // produced a permanently red "does not match" row.
  it.effect("skips the registration when every address answers as another environment", () =>
    Effect.gen(function* () {
      const built = yield* buildRoamingRegistration(registration);
      expect(built).toBeNull();
    }).pipe(
      Effect.provide(
        descriptorHttpLayer({
          "http://10.0.0.5:14801": "env-someone-else",
          "http://127.0.0.1:14801": "env-this-very-reader",
        }),
      ),
    ),
  );

  // A wrong-machine answer must not shadow a silent candidate that could
  // still be the peer coming back online.
  it.effect("prefers a silent candidate over one that answered as another environment", () =>
    Effect.gen(function* () {
      const built = yield* buildRoamingRegistration(registration);
      expect(built?.verified).toBe(false);
      expect(built?.registration.profile.httpBaseUrl).toBe("http://10.0.0.5:14801/");
    }).pipe(
      Effect.provide(descriptorHttpLayer({ "http://127.0.0.1:14801": "env-this-very-reader" })),
    ),
  );

  it("signature covers identity, label, urls, and token", () => {
    expect(roamingRegistrationSignature(registration)).toBe(
      `${INITIATOR_ID}|Laptop|http://10.0.0.5:14801,http://127.0.0.1:14801|attach-token`,
    );
  });
});
