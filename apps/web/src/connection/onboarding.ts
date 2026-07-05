import { ConnectionOnboarding } from "@t3tools/client-runtime/connection";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { DesktopSshEnvironmentTarget, EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "./runtime";

const onboardingScheduler = createAtomCommandScheduler();

export const connectPairing = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:connect-pairing",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "singleFlight",
    key: (input: { pairingUrl?: string; host?: string; pairingCode?: string }) =>
      JSON.stringify(input),
  },
  execute: (input: {
    readonly pairingUrl?: string;
    readonly host?: string;
    readonly pairingCode?: string;
  }) =>
    ConnectionOnboarding.pipe(Effect.flatMap((onboarding) => onboarding.registerPairing(input))),
});

export const registerBearerGrant = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:register-bearer-grant",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "singleFlight",
    key: (input: { readonly environmentId: EnvironmentId; readonly baseUrl: string }) =>
      `${input.environmentId}:${input.baseUrl}`,
  },
  execute: (input: {
    readonly environmentId: EnvironmentId;
    readonly baseUrl: string;
    readonly token: string;
  }) =>
    ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.registerBearerGrant(input)),
    ),
});

export const connectSshEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:connect-ssh",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "serial",
    key: (input: { readonly target: DesktopSshEnvironmentTarget }) => JSON.stringify(input.target),
  },
  execute: (input: { readonly target: DesktopSshEnvironmentTarget; readonly label?: string }) =>
    ConnectionOnboarding.pipe(Effect.flatMap((onboarding) => onboarding.registerSsh(input))),
});
