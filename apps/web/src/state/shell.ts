import {
  AVAILABLE_CONNECTION_STATE,
  connectionProjectionPhase,
} from "@t3tools/client-runtime/connection";
import {
  createEnvironmentShellAtoms,
  createEnvironmentShellSummaryAtom,
  createEnvironmentSnapshotAtom,
  createShellEnvironmentAtoms,
  type EnvironmentShellStatus,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { isDesktopLocalConnectionTarget } from "../connection/desktopLocal";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentPresentations } from "./presentation";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";

export const shellEnvironment = createShellEnvironmentAtoms(connectionAtomRuntime);
export const environmentShell = createEnvironmentShellAtoms(connectionAtomRuntime);
export const environmentSnapshotAtom = createEnvironmentSnapshotAtom(environmentShell.stateAtom);
export const environmentShellSummaryAtom = createEnvironmentShellSummaryAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  shellStateValueAtom: environmentShell.stateValueAtom,
});

export const allEnvironmentShellsBootstrappedAtom = Atom.make((get) => {
  const catalog = AsyncResult.value(get(environmentCatalog.catalogAtom));
  if (Option.isNone(catalog)) {
    return false;
  }
  for (const environmentId of catalog.value.entries.keys()) {
    if (Option.isSome(get(environmentShell.stateValueAtom(environmentId)).snapshot)) {
      continue;
    }
    const connection = Option.getOrElse(
      AsyncResult.value(get(environmentCatalog.stateAtom(environmentId))),
      () => AVAILABLE_CONNECTION_STATE,
    );
    if (connectionProjectionPhase(connection) !== "disconnected") {
      return false;
    }
    // A retrying environment is only transiently disconnected; give it its
    // first retries before letting the landing settle without its snapshot.
    if (connection.phase === "backoff" && connection.desired && connection.attempt <= 2) {
      return false;
    }
  }
  return true;
}).pipe(Atom.withLabel("web-all-environment-shells-bootstrapped"));

/**
 * Shell status per catalog environment. Lets the sidebar treat a
 * disconnected remote's cached snapshot as not-live, so its rows can flip
 * to the mirrored offline presentation instead of lingering as dead
 * live-looking entries.
 */
export const environmentShellStatusesAtom = Atom.make((get) => {
  const statuses = new Map<EnvironmentId, EnvironmentShellStatus>();
  for (const environmentId of get(environmentCatalog.catalogValueAtom).entries.keys()) {
    statuses.set(environmentId, get(environmentShell.stateValueAtom(environmentId)).status);
  }
  return statuses;
}).pipe(Atom.withLabel("environment-shell-statuses"));

/**
 * Environments whose rows are trustworthy as LIVE rows (roaming M5.5 a):
 * the primary and desktop-local sandboxes always; a remote only while its
 * shell is `live` — an active, synchronized connection. A thread must
 * render as exactly one row, ever: a normal row while its environment is
 * reachable, the greyed mirrored fallback when it is not — never both.
 *
 * Deliberately STRICTER than the project rows' rule (which counts
 * `synchronizing` as live to avoid reconnect flapping): a dead peer's
 * retry loop flaps cached ↔ synchronizing forever, so any rule that
 * accepts `synchronizing` oscillates — and components that render at
 * different instants latch different verdicts, committing a thread as a
 * live row AND a fallback row at once (observed). `live` is stable: a
 * dead peer can never reach it, and a genuine reconnect converges in one
 * flip. ONE derived atom so every consumer decides from the same
 * snapshot.
 */
export const reachableEnvironmentIdsAtom = Atom.make((get) => {
  const reachable = new Set<EnvironmentId>();
  const primaryEnvironmentId = get(primaryEnvironmentIdAtom);
  if (primaryEnvironmentId !== null) {
    reachable.add(primaryEnvironmentId);
  }
  const statuses = get(environmentShellStatusesAtom);
  for (const [environmentId, presentation] of get(environmentPresentations.presentationsAtom)) {
    if (isDesktopLocalConnectionTarget(presentation.entry.target)) {
      reachable.add(environmentId);
      continue;
    }
    if (statuses.get(environmentId) === "live") {
      reachable.add(environmentId);
    }
  }
  return reachable;
}).pipe(Atom.withLabel("reachable-environment-ids"));
