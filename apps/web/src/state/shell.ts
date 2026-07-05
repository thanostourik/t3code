import {
  createEnvironmentShellAtoms,
  createEnvironmentShellSummaryAtom,
  createEnvironmentSnapshotAtom,
  createShellEnvironmentAtoms,
  type EnvironmentShellStatus,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";

export const shellEnvironment = createShellEnvironmentAtoms(connectionAtomRuntime);
export const environmentShell = createEnvironmentShellAtoms(connectionAtomRuntime);
export const environmentSnapshotAtom = createEnvironmentSnapshotAtom(environmentShell.stateAtom);
export const environmentShellSummaryAtom = createEnvironmentShellSummaryAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  shellStateValueAtom: environmentShell.stateValueAtom,
});

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
