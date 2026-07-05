import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId, WorkspaceProjectId } from "@t3tools/contracts";
import type { OrchestrationShellSnapshot, OrchestrationShellStreamEvent } from "@t3tools/contracts";

import { applyShellStreamEvent } from "./shellReducer.ts";

const baseSnapshot: OrchestrationShellSnapshot = {
  snapshotSequence: 0,
  projects: [],
  threads: [],
  roamingProjects: [],
  roamingMaterializations: [],
  updatedAt: "2026-04-01T00:00:00.000Z",
};

const stubProject = {
  id: ProjectId.make("project-1"),
  title: "Test Project",
  workspaceRoot: "/workspace/test",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
} as const;

const stubThread = {
  id: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Test Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  pullRequests: [],
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  session: null,
} as const;

const stubRoamingProject = {
  workspaceProjectId: WorkspaceProjectId.make("wp-1"),
  title: "Roaming Project",
  repository: {
    canonicalKey: "github.com/acme/app",
    locator: {
      source: "git-remote" as const,
      remoteName: "origin",
      remoteUrl: "git@github.com:acme/app.git",
    },
  },
  localProjectId: null,
  authorEnvironmentId: EnvironmentId.make("env-desktop"),
  perMachineRoots: {},
  lastMirrorContactAt: null,
  updatedAt: "2026-04-01T00:00:00.000Z",
  conflicts: [],
} as const;

describe("applyShellStreamEvent", () => {
  it("applies roaming upserts and removals by key without touching snapshotSequence", () => {
    const withHighSequence: OrchestrationShellSnapshot = {
      ...baseSnapshot,
      snapshotSequence: 10,
    };

    // Roaming events carry sequence 0 and must not be dropped by the guard.
    const upserted = applyShellStreamEvent(withHighSequence, {
      kind: "roaming-project-upserted",
      sequence: 0,
      roamingProject: stubRoamingProject,
    });
    expect(upserted.roamingProjects).toEqual([stubRoamingProject]);
    expect(upserted.snapshotSequence).toBe(10);

    const replaced = applyShellStreamEvent(upserted, {
      kind: "roaming-project-upserted",
      sequence: 0,
      roamingProject: { ...stubRoamingProject, title: "Renamed" },
    });
    expect(replaced.roamingProjects).toHaveLength(1);
    expect(replaced.roamingProjects[0]?.title).toBe("Renamed");

    const removed = applyShellStreamEvent(replaced, {
      kind: "roaming-project-removed",
      sequence: 0,
      workspaceProjectId: stubRoamingProject.workspaceProjectId,
    });
    expect(removed.roamingProjects).toEqual([]);
    expect(removed.snapshotSequence).toBe(10);
  });


  it("applies materialization updates by workspaceProjectId despite sequence 0", () => {
    const materialization = {
      workspaceProjectId: WorkspaceProjectId.make("wp-1"),
      status: "running" as const,
      steps: [{ step: "clone" as const, status: "running" as const }],
      notices: [],
      targetPath: null,
      localProjectId: null,
      error: null,
      startedAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
    };
    const withHighSequence: OrchestrationShellSnapshot = {
      ...baseSnapshot,
      snapshotSequence: 10,
    };

    const upserted = applyShellStreamEvent(withHighSequence, {
      kind: "roaming-materialization-updated",
      sequence: 0,
      materialization,
    });
    expect(upserted.roamingMaterializations).toEqual([materialization]);
    expect(upserted.snapshotSequence).toBe(10);

    const completed = applyShellStreamEvent(upserted, {
      kind: "roaming-materialization-updated",
      sequence: 0,
      materialization: { ...materialization, status: "completed" as const },
    });
    expect(completed.roamingMaterializations).toHaveLength(1);
    expect(completed.roamingMaterializations[0]?.status).toBe("completed");
  });

  it("ignores stale project upserts without mutating the snapshot", () => {
    const snapshotWithProject: OrchestrationShellSnapshot = {
      ...baseSnapshot,
      snapshotSequence: 4,
      projects: [stubProject],
    };

    for (const sequence of [3, 4]) {
      const next = applyShellStreamEvent(snapshotWithProject, {
        kind: "project-upserted",
        sequence,
        project: { ...stubProject, title: "Stale Title" },
      });

      expect(next).toBe(snapshotWithProject);
      expect(next.snapshotSequence).toBe(4);
      expect(next.projects[0]?.title).toBe("Test Project");
    }
  });

  describe("project-upserted", () => {
    it("adds a new project", () => {
      const event: OrchestrationShellStreamEvent = {
        kind: "project-upserted",
        sequence: 1,
        project: stubProject,
      };

      const next = applyShellStreamEvent(baseSnapshot, event);

      expect(next.projects).toHaveLength(1);
      expect(next.projects[0]?.id).toBe("project-1");
      expect(next.snapshotSequence).toBe(1);
    });

    it("updates an existing project", () => {
      const snapshotWithProject: OrchestrationShellSnapshot = {
        ...baseSnapshot,
        projects: [stubProject],
      };

      const updatedProject = { ...stubProject, title: "Updated Title" };
      const event: OrchestrationShellStreamEvent = {
        kind: "project-upserted",
        sequence: 2,
        project: updatedProject,
      };

      const next = applyShellStreamEvent(snapshotWithProject, event);

      expect(next.projects).toHaveLength(1);
      expect(next.projects[0]?.title).toBe("Updated Title");
      expect(next.snapshotSequence).toBe(2);
    });
  });

  describe("project-removed", () => {
    it("removes a project by id", () => {
      const snapshotWithProject: OrchestrationShellSnapshot = {
        ...baseSnapshot,
        projects: [stubProject],
      };

      const event: OrchestrationShellStreamEvent = {
        kind: "project-removed",
        sequence: 3,
        projectId: ProjectId.make("project-1"),
      };

      const next = applyShellStreamEvent(snapshotWithProject, event);

      expect(next.projects).toHaveLength(0);
      expect(next.snapshotSequence).toBe(3);
    });
  });

  describe("thread-upserted", () => {
    it("adds a new thread", () => {
      const event: OrchestrationShellStreamEvent = {
        kind: "thread-upserted",
        sequence: 4,
        thread: stubThread,
      };

      const next = applyShellStreamEvent(baseSnapshot, event);

      expect(next.threads).toHaveLength(1);
      expect(next.threads[0]?.id).toBe("thread-1");
      expect(next.snapshotSequence).toBe(4);
    });

    it("updates an existing thread", () => {
      const snapshotWithThread: OrchestrationShellSnapshot = {
        ...baseSnapshot,
        threads: [stubThread],
      };

      const updatedThread = { ...stubThread, title: "Updated Thread" };
      const event: OrchestrationShellStreamEvent = {
        kind: "thread-upserted",
        sequence: 5,
        thread: updatedThread,
      };

      const next = applyShellStreamEvent(snapshotWithThread, event);

      expect(next.threads).toHaveLength(1);
      expect(next.threads[0]?.title).toBe("Updated Thread");
    });
  });

  describe("thread-removed", () => {
    it("removes a thread by id", () => {
      const snapshotWithThread: OrchestrationShellSnapshot = {
        ...baseSnapshot,
        threads: [stubThread],
      };

      const event: OrchestrationShellStreamEvent = {
        kind: "thread-removed",
        sequence: 6,
        threadId: ThreadId.make("thread-1"),
      };

      const next = applyShellStreamEvent(snapshotWithThread, event);

      expect(next.threads).toHaveLength(0);
      expect(next.snapshotSequence).toBe(6);
    });
  });

  it("returns original snapshot for unrecognized event kinds", () => {
    const unknownEvent = { kind: "unknown-future-event", sequence: 99 } as any;
    const next = applyShellStreamEvent(baseSnapshot, unknownEvent);
    expect(next).toBe(baseSnapshot);
  });
});
