/**
 * Continue-here (roaming M5.5): open an ordinary new-thread draft on THIS
 * machine, pre-filled from the mirrored copy of a conversation that lives
 * on another machine. Available whenever a mirrored copy exists —
 * INCLUDING while the source machine is live (2026-07-31 decision): peer
 * liveness gates row presentation, never the ability to continue locally.
 * Materializes the project first when needed (one action), reuses the
 * project's unsent draft session, defaults the picker to the source model
 * only when it is selectable locally, and never auto-starts a turn.
 */
import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ModelSelection, ThreadId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useMaterialize } from "../components/Sidebar";
import { toastManager } from "../components/ui/toast";
import { useComposerDraftStore } from "../composerDraftStore";
import {
  generateRoamingBrief,
  getRoamingThreadTranscript,
  markRoamingThreadResumed,
} from "../environments/primary/roaming";
import { resolveNewDraftStartFromOrigin } from "../lib/chatThreadActions";
import { newDraftId, newThreadId } from "../lib/utils";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { readThreadShell, useProjects, useRoamingProjects } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { primaryServerProvidersAtom, primaryServerSettingsAtom } from "../state/server";
import { useClientSettings } from "./useSettings";

export function useContinueHere(input: {
  threadId: ThreadId | null;
  workspaceProjectId: string | null;
}) {
  const { threadId, workspaceProjectId } = input;
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const roamingProjects = useRoamingProjects();
  const projects = useProjects();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const primaryServerSettings = useAtomValue(primaryServerSettingsAtom);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const { materialize, dialog } = useMaterialize();
  const [resuming, setResuming] = useState(false);
  const [pendingResumeProjectId, setPendingResumeProjectId] = useState<string | null>(null);

  const roamingProject = useMemo(
    () =>
      workspaceProjectId === null || primaryEnvironmentId === null
        ? null
        : (roamingProjects.find(
            (entry) =>
              entry.environmentId === primaryEnvironmentId &&
              entry.roamingProject.workspaceProjectId === workspaceProjectId,
          )?.roamingProject ?? null),
    [workspaceProjectId, roamingProjects, primaryEnvironmentId],
  );
  const localProject = useMemo(() => {
    const localProjectId = roamingProject?.localProjectId ?? null;
    if (localProjectId === null || primaryEnvironmentId === null) {
      return null;
    }
    return (
      projects.find(
        (project) =>
          project.environmentId === primaryEnvironmentId && project.id === localProjectId,
      ) ?? null
    );
  }, [roamingProject, projects, primaryEnvironmentId]);

  const runResume = useCallback(
    (project: NonNullable<typeof localProject>) => {
      if (threadId === null || primaryEnvironmentId === null || resuming) {
        return;
      }
      setResuming(true);
      void (async () => {
        try {
          const { transcript, brief } = await getRoamingThreadTranscript({ threadId });
          if (transcript === null) {
            toastManager.add({
              type: "error",
              title: "Could not continue here",
              description: "This conversation hasn't synced to this machine yet.",
            });
            return;
          }
          // A saved brief wins; otherwise the brief is generated HERE from
          // the local transcript copy — resume never requires preparation
          // on the source machine (M5.5).
          let seedText = brief?.markdown ?? null;
          if (seedText === null || seedText.length === 0) {
            const generated = await generateRoamingBrief({ threadId });
            seedText = generated.markdown;
            for (const notice of generated.notices) {
              toastManager.add({ type: "info", title: "Resume brief", description: notice });
            }
          }
          // The source thread's model is only ever the picker DEFAULT, and
          // only when it is selectable here: enabled provider instance AND
          // a model this machine knows (M5.5 b).
          const reduced = transcript.modelSelection;
          const provider =
            reduced === undefined
              ? undefined
              : providers.find((candidate) => candidate.instanceId === reduced.instanceId);
          const sourceModelSelection: ModelSelection | null =
            reduced !== undefined &&
            provider !== undefined &&
            provider.enabled &&
            provider.models.some((model) => model.slug === reduced.model)
              ? createModelSelection(provider.instanceId, reduced.model, reduced.options ?? null)
              : null;
          // An ordinary new-thread draft: prompt pre-filled, model picked by
          // the user in the composer, nothing auto-started.
          const {
            getComposerDraft,
            getDraftSessionByLogicalProjectKey,
            setLogicalProjectDraftThreadId,
            applyStickyState,
            setModelSelection,
            setPrompt,
          } = useComposerDraftStore.getState();
          const projectRef = scopeProjectRef(primaryEnvironmentId, project.id);
          const logicalProjectKey = deriveLogicalProjectKeyFromSettings(
            project,
            projectGroupingSettings,
          );
          // Installing a fresh draftId would DELETE the project's stored
          // unsent draft, prompt included — reuse its session instead and put
          // the brief above any unsent text so nothing is discarded.
          const stored = getDraftSessionByLogicalProjectKey(logicalProjectKey);
          const storedReusable =
            stored != null &&
            stored.promotedTo == null &&
            readThreadShell(scopeThreadRef(stored.environmentId, stored.threadId)) === null;
          const draftId = storedReusable ? stored.draftId : newDraftId();
          const draftThreadId = storedReusable ? stored.threadId : newThreadId();
          if (storedReusable) {
            // Re-point the session at the local member (a stored draft may
            // target a remote member of the logical project); same draftId, so
            // nothing is deleted and the composer text survives.
            setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, draftId, {
              threadId: draftThreadId,
            });
          } else {
            const envMode = primaryServerSettings.defaultThreadEnvMode;
            setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, draftId, {
              threadId: draftThreadId,
              createdAt: new Date().toISOString(),
              branch: null,
              worktreePath: null,
              envMode,
              startFromOrigin: resolveNewDraftStartFromOrigin({
                envMode,
                newWorktreesStartFromOrigin: primaryServerSettings.newWorktreesStartFromOrigin,
              }),
            });
            applyStickyState(draftId);
          }
          if (sourceModelSelection !== null) {
            // After sticky state so the source thread's selection wins as the
            // default; replaceOptions because it is a complete snapshot.
            setModelSelection(draftId, sourceModelSelection, { replaceOptions: true });
          }
          const existingPrompt = getComposerDraft(draftId)?.prompt ?? "";
          setPrompt(
            draftId,
            existingPrompt.trim().length > 0 ? `${seedText}\n\n${existingPrompt}` : seedText,
          );
          // Record the supersession link now: the draft already knows the
          // thread id it will promote to, and the fallback row only hides
          // once that thread actually exists (M5.5 d). Best-effort — a failed
          // write costs a duplicate fallback row, not the resume.
          void markRoamingThreadResumed({
            sourceThreadId: threadId,
            resumedThreadId: draftThreadId,
          }).catch(() => {});
          await navigate({ to: "/draft/$draftId", params: { draftId } });
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Could not continue here",
            description: error instanceof Error ? error.message : "Request failed.",
          });
        } finally {
          setResuming(false);
        }
      })();
    },
    [
      threadId,
      primaryEnvironmentId,
      resuming,
      providers,
      projectGroupingSettings,
      primaryServerSettings,
      navigate,
    ],
  );

  // Materialize-and-continue: on an unmaterialized project, continue runs
  // materialize (same confirm dialog as the project row) and chains into
  // the draft once the registered project lands in the shell.
  useEffect(() => {
    if (pendingResumeProjectId === null || primaryEnvironmentId === null) {
      return;
    }
    const project =
      projects.find(
        (candidate) =>
          candidate.environmentId === primaryEnvironmentId &&
          candidate.id === pendingResumeProjectId,
      ) ?? null;
    if (project !== null) {
      setPendingResumeProjectId(null);
      runResume(project);
    }
  }, [pendingResumeProjectId, projects, primaryEnvironmentId, runResume]);

  const continueHere = useCallback(() => {
    if (threadId === null || resuming || pendingResumeProjectId !== null) {
      return;
    }
    if (localProject !== null) {
      runResume(localProject);
      return;
    }
    if (roamingProject === null) {
      toastManager.add({
        type: "error",
        title: "Could not continue here",
        description: "This project is not available from the mirror copy yet.",
      });
      return;
    }
    materialize({
      title: roamingProject.title,
      dirName: roamingProject.repository.name ?? roamingProject.title,
      workspaceProjectId: roamingProject.workspaceProjectId,
      confirmLabel: "Materialize & continue",
      onSuccess: (localId) => {
        if (localId !== null) {
          setPendingResumeProjectId(localId);
        }
      },
    });
  }, [
    threadId,
    resuming,
    pendingResumeProjectId,
    localProject,
    runResume,
    roamingProject,
    materialize,
  ]);

  return {
    continueHere,
    busy: resuming || pendingResumeProjectId !== null,
    needsMaterialize: localProject === null,
    dialog,
  };
}
