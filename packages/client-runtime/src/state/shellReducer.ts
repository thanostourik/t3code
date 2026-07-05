import * as Arr from "effect/Array";
import type { OrchestrationShellSnapshot, OrchestrationShellStreamEvent } from "@t3tools/contracts";

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
    const exists = snapshot.roamingProjects.some(
      (entry) => entry.workspaceProjectId === event.roamingProject.workspaceProjectId,
    );
    return {
      ...snapshot,
      roamingProjects: exists
        ? Arr.map(snapshot.roamingProjects, (entry) =>
            entry.workspaceProjectId === event.roamingProject.workspaceProjectId
              ? event.roamingProject
              : entry,
          )
        : Arr.append(snapshot.roamingProjects, event.roamingProject),
    };
  }
  if (event.kind === "roaming-project-removed") {
    return {
      ...snapshot,
      roamingProjects: Arr.filter(
        snapshot.roamingProjects,
        (entry) => entry.workspaceProjectId !== event.workspaceProjectId,
      ),
    };
  }
  if (event.kind === "roaming-materialization-updated") {
    const exists = snapshot.roamingMaterializations.some(
      (entry) => entry.workspaceProjectId === event.materialization.workspaceProjectId,
    );
    return {
      ...snapshot,
      roamingMaterializations: exists
        ? Arr.map(snapshot.roamingMaterializations, (entry) =>
            entry.workspaceProjectId === event.materialization.workspaceProjectId
              ? event.materialization
              : entry,
          )
        : Arr.append(snapshot.roamingMaterializations, event.materialization),
    };
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
