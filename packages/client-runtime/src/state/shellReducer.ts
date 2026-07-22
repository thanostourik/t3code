import * as Arr from "effect/Array";
import type { OrchestrationShellSnapshot, OrchestrationShellStreamEvent } from "@t3tools/contracts";

/** Keyed upsert for the roaming lists (S2): replace by workspaceProjectId, else append. */
const upsertByWsid = <T extends { readonly workspaceProjectId: string }>(
  entries: ReadonlyArray<T>,
  next: T,
): ReadonlyArray<T> =>
  entries.some((entry) => entry.workspaceProjectId === next.workspaceProjectId)
    ? Arr.map(entries, (entry) =>
        entry.workspaceProjectId === next.workspaceProjectId ? next : entry,
      )
    : Arr.append(entries, next);

/**
 * Reduce a single shell stream event into an existing snapshot, returning a new
 * snapshot with the event's changes applied. This is a pure reducer that both
 * web and mobile can use to keep their local shell snapshot in sync.
 *
 * Returns the original snapshot reference unchanged if the event is not
 * recognized (forward-compatible).
 */
export function applyShellStreamEvent(
  snapshot: OrchestrationShellSnapshot,
  event: OrchestrationShellStreamEvent,
): OrchestrationShellSnapshot {
  // Roaming events ride outside the event-log sequence (the server emits
  // them with sequence 0): apply by key and leave snapshotSequence alone.
  if (event.kind === "roaming-project-upserted") {
    return {
      ...snapshot,
      roamingProjects: upsertByWsid(snapshot.roamingProjects, event.roamingProject),
    };
  }
  if (event.kind === "roaming-materialization-updated") {
    return {
      ...snapshot,
      roamingMaterializations: upsertByWsid(
        snapshot.roamingMaterializations,
        event.materialization,
      ),
    };
  }
  if (event.kind === "roaming-wip-status-updated") {
    return {
      ...snapshot,
      roamingWipStatus: upsertByWsid(snapshot.roamingWipStatus, event.wipStatus),
    };
  }
  if (event.kind === "roaming-wip-status-replaced") {
    return { ...snapshot, roamingWipStatus: event.wipStatuses };
  }
  if (event.kind === "roaming-thread-upserted") {
    // A tombstoned transcript (author deleted/archived the thread) removes
    // the row; there is no separate removal event.
    const roamingThreads =
      event.roamingThread.deleted === true
        ? Arr.filter(
            snapshot.roamingThreads,
            (thread) => thread.threadId !== event.roamingThread.threadId,
          )
        : snapshot.roamingThreads.some((thread) => thread.threadId === event.roamingThread.threadId)
          ? Arr.map(snapshot.roamingThreads, (thread) =>
              thread.threadId === event.roamingThread.threadId ? event.roamingThread : thread,
            )
          : Arr.append(snapshot.roamingThreads, event.roamingThread);
    return { ...snapshot, roamingThreads };
  }

  if (event.sequence <= snapshot.snapshotSequence) return snapshot;

  switch (event.kind) {
    case "project-upserted": {
      const projects = snapshot.projects.some((p) => p.id === event.project.id)
        ? Arr.map(snapshot.projects, (p) => (p.id === event.project.id ? event.project : p))
        : Arr.append(snapshot.projects, event.project);
      return { ...snapshot, projects, snapshotSequence: event.sequence };
    }
    case "project-removed":
      return {
        ...snapshot,
        projects: Arr.filter(snapshot.projects, (p) => p.id !== event.projectId),
        snapshotSequence: event.sequence,
      };
    case "thread-upserted": {
      const threads = snapshot.threads.some((t) => t.id === event.thread.id)
        ? Arr.map(snapshot.threads, (t) => (t.id === event.thread.id ? event.thread : t))
        : Arr.append(snapshot.threads, event.thread);
      return { ...snapshot, threads, snapshotSequence: event.sequence };
    }
    case "thread-removed":
      return {
        ...snapshot,
        threads: Arr.filter(snapshot.threads, (t) => t.id !== event.threadId),
        snapshotSequence: event.sequence,
      };
    default:
      return snapshot;
  }
}
