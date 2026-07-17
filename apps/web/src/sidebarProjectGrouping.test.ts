import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, ProjectId, WorkspaceProjectId } from "@t3tools/contracts";
import type { EnvironmentRoamingProject } from "@t3tools/client-runtime/state/projects";

import { selectOfflineRoamingProjects } from "./sidebarProjectGrouping";
import type { Project } from "./types";

const environmentId = EnvironmentId.make("env-laptop");

function makeRoamingEntry(input: {
  workspaceProjectId: string;
  title: string;
  canonicalKey: string;
  localProjectId?: string;
}): EnvironmentRoamingProject {
  return {
    environmentId,
    roamingProject: {
      workspaceProjectId: WorkspaceProjectId.make(input.workspaceProjectId),
      title: input.title,
      repository: {
        canonicalKey: input.canonicalKey,
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: `git@github.com:acme/${input.title}.git`,
        },
      },
      localProjectId: input.localProjectId ? ProjectId.make(input.localProjectId) : null,
      authorEnvironmentId: EnvironmentId.make("env-desktop"),
      perMachineRoots: {},
      lastMirrorContactAt: null,
      updatedAt: "2026-04-01T00:00:00.000Z",
      conflicts: [],
      activity: [],
    },
  };
}

function makeLiveProject(input: { id: string; canonicalKey: string | null }): Project {
  return {
    environmentId,
    id: ProjectId.make(input.id),
    title: input.id,
    workspaceRoot: `/workspace/${input.id}`,
    repositoryIdentity:
      input.canonicalKey === null
        ? null
        : {
            canonicalKey: input.canonicalKey,
            locator: {
              source: "git-remote",
              remoteName: "origin",
              remoteUrl: `git@github.com:acme/${input.id}.git`,
            },
          },
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
  } as Project;
}

describe("selectOfflineRoamingProjects", () => {
  it("keeps only unmaterialized entries whose repository has no live row, sorted by title", () => {
    const offline = selectOfflineRoamingProjects({
      roamingProjects: [
        makeRoamingEntry({
          workspaceProjectId: "wp-zeta",
          title: "zeta",
          canonicalKey: "github.com/acme/zeta",
        }),
        makeRoamingEntry({
          workspaceProjectId: "wp-alpha",
          title: "alpha",
          canonicalKey: "github.com/acme/alpha",
        }),
        // Materialized locally: linked local project id.
        makeRoamingEntry({
          workspaceProjectId: "wp-local",
          title: "local",
          canonicalKey: "github.com/acme/local",
          localProjectId: "project-local",
        }),
        // Live row exists for this repository (e.g. attached remote project).
        makeRoamingEntry({
          workspaceProjectId: "wp-live",
          title: "live",
          canonicalKey: "github.com/acme/live",
        }),
      ],
      liveProjects: [
        makeLiveProject({ id: "live", canonicalKey: "github.com/acme/live" }),
        // The materialized entry's link must point at a project that still
        // exists to count as materialized.
        makeLiveProject({ id: "project-local", canonicalKey: "github.com/acme/local" }),
      ],
    });

    expect(offline.map((entry) => entry.roamingProject.title)).toEqual(["alpha", "zeta"]);
  });

  it("treats a dangling localProjectId as unmaterialized", () => {
    const offline = selectOfflineRoamingProjects({
      roamingProjects: [
        makeRoamingEntry({
          workspaceProjectId: "wp-stale",
          title: "stale-link",
          canonicalKey: "github.com/acme/stale",
          localProjectId: "project-deleted-long-ago",
        }),
      ],
      liveProjects: [],
    });
    expect(offline.map((entry) => entry.roamingProject.title)).toEqual(["stale-link"]);
  });

  it("dedupes the same workspace project mirrored from several environments", () => {
    const first = makeRoamingEntry({
      workspaceProjectId: "wp-1",
      title: "app",
      canonicalKey: "github.com/acme/app",
    });
    const second = {
      environmentId: EnvironmentId.make("env-other"),
      roamingProject: first.roamingProject,
    };

    const offline = selectOfflineRoamingProjects({
      roamingProjects: [first, second],
      liveProjects: [],
    });

    expect(offline).toHaveLength(1);
    expect(offline[0]?.environmentId).toBe(environmentId);
  });
});
