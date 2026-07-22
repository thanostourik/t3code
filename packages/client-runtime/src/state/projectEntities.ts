import type {
  EnvironmentId,
  OrchestrationProjectShell,
  OrchestrationShellSnapshot,
  ProjectId,
  RoamingMaterializationRecord,
  RoamingWipStatusEntry,
  RoamingProjectShell,
  RoamingThreadShell,
  ScopedProjectRef,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentProject } from "./models.ts";
import { scopeProject } from "./models.ts";
import type { EnvironmentCatalogState } from "./connections.ts";
import { arrayElementsEqual, parseProjectKey, projectKey, projectRefsEqual } from "./entities.ts";

const EMPTY_PROJECTS: ReadonlyArray<OrchestrationProjectShell> = Object.freeze([]);
const EMPTY_ROAMING_PROJECTS: ReadonlyArray<RoamingProjectShell> = Object.freeze([]);
const EMPTY_ROAMING_WIP_STATUS: ReadonlyArray<RoamingWipStatusEntry> = Object.freeze([]);
const EMPTY_ROAMING_THREADS: ReadonlyArray<RoamingThreadShell> = Object.freeze([]);
const EMPTY_ROAMING_MATERIALIZATIONS: ReadonlyArray<RoamingMaterializationRecord> = Object.freeze(
  [],
);
const EMPTY_PROJECT_INDEX: ReadonlyMap<ProjectId, OrchestrationProjectShell> = new Map();

export function createEnvironmentProjectAtoms(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly snapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<OrchestrationShellSnapshot | null>;
}) {
  const environmentProjectsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get): ReadonlyArray<OrchestrationProjectShell> =>
        get(input.snapshotAtom(environmentId))?.projects ?? EMPTY_PROJECTS,
    ).pipe(Atom.withLabel(`environment-projects:${environmentId}`)),
  );

  const environmentProjectIndexAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): ReadonlyMap<ProjectId, OrchestrationProjectShell> => {
      const projects = get(environmentProjectsAtom(environmentId));
      if (projects.length === 0) {
        return EMPTY_PROJECT_INDEX;
      }
      return new Map(projects.map((project) => [project.id, project] as const));
    }).pipe(Atom.withLabel(`environment-project-index:${environmentId}`)),
  );

  const environmentProjectRefsAtom = Atom.family((environmentId: EnvironmentId) => {
    let previous: ReadonlyArray<ScopedProjectRef> = [];
    return Atom.make((get) => {
      const next = get(environmentProjectsAtom(environmentId)).map((project) => ({
        environmentId,
        projectId: project.id,
      }));
      if (projectRefsEqual(previous, next)) {
        return previous;
      }
      previous = next;
      return next;
    }).pipe(Atom.withLabel(`environment-project-refs:${environmentId}`));
  });

  const projectAtomFamily = Atom.family((key: string) => {
    const ref = parseProjectKey(key);
    let previousSource: OrchestrationProjectShell | null = null;
    let previousValue: EnvironmentProject | null = null;
    return Atom.make((get) => {
      const source = get(environmentProjectIndexAtom(ref.environmentId)).get(ref.projectId) ?? null;
      if (source === previousSource) {
        return previousValue;
      }
      previousSource = source;
      previousValue = source === null ? null : scopeProject(ref.environmentId, source);
      return previousValue;
    }).pipe(Atom.withLabel(`environment-project:${key}`));
  });

  let previousProjectRefs: ReadonlyArray<ScopedProjectRef> = [];
  const projectRefsAtom = Atom.make((get) => {
    const refs: ScopedProjectRef[] = [];
    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      refs.push(...get(environmentProjectRefsAtom(environmentId)));
    }
    if (projectRefsEqual(previousProjectRefs, refs)) {
      return previousProjectRefs;
    }
    previousProjectRefs = refs;
    return refs;
  }).pipe(Atom.withLabel("environment-project-refs"));

  let previousProjects: ReadonlyArray<EnvironmentProject> = [];
  const projectsAtom = Atom.make((get) => {
    const next = get(projectRefsAtom).flatMap((ref) => {
      const project = get(projectAtomFamily(projectKey(ref)));
      return project === null ? [] : [project];
    });
    if (arrayElementsEqual(previousProjects, next)) {
      return previousProjects;
    }
    previousProjects = next;
    return previousProjects;
  }).pipe(Atom.withLabel("environment-project-list"));

  const environmentRoamingProjectsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get): ReadonlyArray<RoamingProjectShell> =>
        get(input.snapshotAtom(environmentId))?.roamingProjects ?? EMPTY_ROAMING_PROJECTS,
    ).pipe(Atom.withLabel(`environment-roaming-projects:${environmentId}`)),
  );

  let previousRoamingProjects: ReadonlyArray<EnvironmentRoamingProject> = [];
  const roamingProjectsAtom = Atom.make((get) => {
    const next: EnvironmentRoamingProject[] = [];
    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      for (const roamingProject of get(environmentRoamingProjectsAtom(environmentId))) {
        next.push({ environmentId, roamingProject });
      }
    }
    const unchanged =
      previousRoamingProjects.length === next.length &&
      next.every(
        (entry, index) =>
          previousRoamingProjects[index]?.environmentId === entry.environmentId &&
          previousRoamingProjects[index]?.roamingProject === entry.roamingProject,
      );
    if (unchanged) {
      return previousRoamingProjects;
    }
    previousRoamingProjects = next;
    return previousRoamingProjects;
  }).pipe(Atom.withLabel("environment-roaming-project-list"));

  const environmentRoamingMaterializationsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get): ReadonlyArray<RoamingMaterializationRecord> =>
        get(input.snapshotAtom(environmentId))?.roamingMaterializations ??
        EMPTY_ROAMING_MATERIALIZATIONS,
    ).pipe(Atom.withLabel(`environment-roaming-materializations:${environmentId}`)),
  );

  let previousRoamingMaterializations: ReadonlyArray<EnvironmentRoamingMaterialization> = [];
  const roamingMaterializationsAtom = Atom.make((get) => {
    const next: EnvironmentRoamingMaterialization[] = [];
    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      for (const materialization of get(environmentRoamingMaterializationsAtom(environmentId))) {
        next.push({ environmentId, materialization });
      }
    }
    const unchanged =
      previousRoamingMaterializations.length === next.length &&
      next.every(
        (entry, index) =>
          previousRoamingMaterializations[index]?.environmentId === entry.environmentId &&
          previousRoamingMaterializations[index]?.materialization === entry.materialization,
      );
    if (unchanged) {
      return previousRoamingMaterializations;
    }
    previousRoamingMaterializations = next;
    return previousRoamingMaterializations;
  }).pipe(Atom.withLabel("environment-roaming-materialization-list"));

  const environmentRoamingWipStatusAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get): ReadonlyArray<RoamingWipStatusEntry> =>
        get(input.snapshotAtom(environmentId))?.roamingWipStatus ?? EMPTY_ROAMING_WIP_STATUS,
    ).pipe(Atom.withLabel(`environment-roaming-wip-status:${environmentId}`)),
  );

  const environmentRoamingThreadsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get): ReadonlyArray<RoamingThreadShell> =>
        get(input.snapshotAtom(environmentId))?.roamingThreads ?? EMPTY_ROAMING_THREADS,
    ).pipe(Atom.withLabel(`environment-roaming-threads:${environmentId}`)),
  );

  return {
    environmentProjectsAtom,
    environmentProjectIndexAtom,
    environmentProjectRefsAtom,
    projectRefsAtom,
    projectsAtom,
    projectAtom: (ref: ScopedProjectRef) => projectAtomFamily(projectKey(ref)),
    environmentRoamingProjectsAtom,
    roamingProjectsAtom,
    environmentRoamingMaterializationsAtom,
    roamingMaterializationsAtom,
    environmentRoamingWipStatusAtom,
    environmentRoamingThreadsAtom,
  };
}

export interface EnvironmentRoamingProject {
  readonly environmentId: EnvironmentId;
  readonly roamingProject: RoamingProjectShell;
}

export interface EnvironmentRoamingMaterialization {
  readonly environmentId: EnvironmentId;
  readonly materialization: RoamingMaterializationRecord;
}
