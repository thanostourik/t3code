import type { DesktopUpdateChannel } from "@t3tools/contracts";

const NIGHTLY_VERSION_PATTERN = /-nightly\.\d{8}\.\d+$/;

// Self-built fork test builds (e.g. 0.0.28-fork.1). They carry their own
// identity, user-data dir, and server state dir so they can never collide
// with a stable install on the same machine, and they never auto-update.
const FORK_VERSION_PATTERN = /-fork\./;

export function isNightlyDesktopVersion(version: string): boolean {
  return NIGHTLY_VERSION_PATTERN.test(version);
}

export function isForkDesktopVersion(version: string): boolean {
  return FORK_VERSION_PATTERN.test(version);
}

export function resolveDefaultDesktopUpdateChannel(appVersion: string): DesktopUpdateChannel {
  return isNightlyDesktopVersion(appVersion) ? "nightly" : "latest";
}
