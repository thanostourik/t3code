/**
 * MirroredThreadView — read-only rendering of a conversation mirrored from
 * another of the user's machines (roaming M5, resume corrected in M5.5).
 * Renders from the local transcript blob copy; never touches local thread
 * state, never mounts a composer. "Continue here" opens an ORDINARY new
 * -thread draft pre-filled with the brief — generated here from the local
 * copy when no hand-off brief exists — with the source thread's model as
 * the picker default when it is available locally. Nothing auto-starts.
 */
import {
  ThreadId,
  type EnvironmentId,
  type ModelSelection,
  type OrchestrationProposedPlan,
  type OrchestrationThreadActivity,
  type RoamingBriefPayload,
  type RoamingTranscriptPayload,
} from "@t3tools/contracts";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useTheme } from "../hooks/useTheme";
import { useClientSettings, usePrimarySettings } from "../hooks/useSettings";
import {
  generateRoamingBrief,
  getRoamingThreadTranscript,
  markRoamingThreadResumed,
  saveRoamingBrief,
} from "../environments/primary/roaming";
import { useComposerDraftStore } from "../composerDraftStore";
import { isElectron } from "../env";
import { cn, newDraftId, newThreadId } from "../lib/utils";
import { resolveNewDraftStartFromOrigin } from "../lib/chatThreadActions";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { deriveTimelineEntries, deriveWorkLogEntries } from "../session-logic";
import { readThreadShell, useEnvironmentRoamingThreads, useProjects } from "../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useRoamingProjects } from "../state/entities";
import { primaryServerProvidersAtom, primaryServerSettingsAtom } from "../state/server";
import type { ChatMessage } from "../types";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";
import type { LegendListRef } from "@legendapp/list/react";

import { MessagesTimeline } from "./chat/MessagesTimeline";
import { useMaterialize } from "./Sidebar";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { toastManager } from "./ui/toast";
import ChatMarkdown from "./ChatMarkdown";

interface TranscriptState {
  readonly status: "loading" | "missing" | "ready";
  readonly transcript: RoamingTranscriptPayload | null;
  readonly brief: RoamingBriefPayload | null;
  readonly authorEnvironmentId: EnvironmentId | null;
}

const INITIAL_STATE: TranscriptState = {
  status: "loading",
  transcript: null,
  brief: null,
  authorEnvironmentId: null,
};

export function MirroredThreadView() {
  const params = useParams({ strict: false }) as { threadId?: string };
  const threadId = params.threadId !== undefined ? ThreadId.make(params.threadId) : null;
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const roamingThreads = useEnvironmentRoamingThreads(primaryEnvironmentId);
  const roamingProjects = useRoamingProjects();
  const projects = useProjects();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const settings = usePrimarySettings();
  const primaryServerSettings = useAtomValue(primaryServerSettingsAtom);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const { resolvedTheme } = useTheme();
  const listRef = useRef<LegendListRef | null>(null);

  const [state, setState] = useState<TranscriptState>(INITIAL_STATE);
  const [briefDraft, setBriefDraft] = useState<string | null>(null);
  const [savingBrief, setSavingBrief] = useState(false);
  const [resuming, setResuming] = useState(false);

  const shell = roamingThreads.find((thread) => thread.threadId === threadId) ?? null;

  useEffect(() => {
    if (threadId === null) {
      return;
    }
    let cancelled = false;
    setState(INITIAL_STATE);
    void getRoamingThreadTranscript({ threadId })
      .then((response) => {
        if (cancelled) return;
        setState({
          status: response.transcript === null ? "missing" : "ready",
          transcript: response.transcript,
          brief: response.brief,
          authorEnvironmentId: response.authorEnvironmentId,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setState({ status: "missing", transcript: null, brief: null, authorEnvironmentId: null });
      });
    return () => {
      cancelled = true;
    };
    // Refetch when a newer transcript/brief version lands (shell row updates).
  }, [threadId, shell?.updatedAt, shell?.hasBrief]);

  const machineLabel = useMemo(() => {
    const environmentId = state.authorEnvironmentId ?? shell?.authorEnvironmentId;
    if (environmentId === undefined || environmentId === null) {
      return null;
    }
    return (
      environments.find((candidate) => candidate.environmentId === environmentId)?.label ?? null
    );
  }, [environments, state.authorEnvironmentId, shell?.authorEnvironmentId]);

  const timelineEntries = useMemo(() => {
    const transcript = state.transcript;
    if (transcript === null) {
      return [];
    }
    // Adapt the reduced transcript shapes back to the timeline's inputs.
    // Attachment bytes deliberately don't roam, so attachments are dropped
    // rather than rendered as broken previews.
    const messages: ChatMessage[] = transcript.messages.map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text,
      turnId: message.turnId,
      streaming: false,
      createdAt: message.createdAt,
      updatedAt: message.createdAt,
    }));
    const plans: OrchestrationProposedPlan[] = transcript.proposedPlans.map((plan) => ({
      id: plan.id,
      turnId: plan.turnId,
      planMarkdown: plan.planMarkdown,
      implementedAt: null,
      implementationThreadId: null,
      createdAt: plan.createdAt,
      updatedAt: plan.createdAt,
    }));
    const activities: OrchestrationThreadActivity[] = transcript.activities.map((activity) => {
      let payload: unknown = {};
      if (activity.payloadJson !== undefined) {
        try {
          payload = JSON.parse(activity.payloadJson);
        } catch {
          payload = {};
        }
      }
      return {
        id: activity.id,
        tone: activity.tone,
        kind: activity.kind,
        summary: activity.summary,
        payload,
        turnId: activity.turnId,
        createdAt: activity.createdAt,
      };
    });
    return deriveTimelineEntries(messages, plans, deriveWorkLogEntries(activities));
  }, [state.transcript]);

  // "Continue here" needs a local checkout of the same project.
  const localProjectId = useMemo(() => {
    if (shell === null || primaryEnvironmentId === null) {
      return null;
    }
    return (
      roamingProjects.find(
        (entry) =>
          entry.environmentId === primaryEnvironmentId &&
          entry.roamingProject.workspaceProjectId === shell.workspaceProjectId,
      )?.roamingProject.localProjectId ?? null
    );
  }, [shell, roamingProjects, primaryEnvironmentId]);

  const localProject = useMemo(
    () =>
      localProjectId === null
        ? null
        : (projects.find(
            (project) =>
              project.environmentId === primaryEnvironmentId && project.id === localProjectId,
          ) ?? null),
    [projects, localProjectId, primaryEnvironmentId],
  );

  // The source thread's model is only ever the resume draft's DEFAULT, and
  // only when it is actually selectable here: enabled provider instance AND
  // a model this machine knows — never a silent pick on a different or
  // unavailable provider (M5.5 b). Null = the composer's own default stands.
  const sourceModelSelection = useMemo((): ModelSelection | null => {
    const reduced = state.transcript?.modelSelection;
    if (reduced === undefined) {
      return null;
    }
    const provider = providers.find((candidate) => candidate.instanceId === reduced.instanceId);
    if (provider === undefined || !provider.enabled) {
      return null;
    }
    if (!provider.models.some((model) => model.slug === reduced.model)) {
      return null;
    }
    return createModelSelection(provider.instanceId, reduced.model, reduced.options ?? null);
  }, [state.transcript, providers]);

  const briefMarkdown = state.brief?.markdown ?? null;

  const handleSaveBrief = useCallback(() => {
    if (threadId === null || briefDraft === null || savingBrief) {
      return;
    }
    setSavingBrief(true);
    void saveRoamingBrief({ threadId, markdown: briefDraft })
      .then((response) => {
        setState((current) => ({ ...current, brief: response.brief }));
        setBriefDraft(null);
      })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not save the brief",
          description: error instanceof Error ? error.message : "Request failed.",
        });
      })
      .finally(() => setSavingBrief(false));
  }, [threadId, briefDraft, savingBrief]);

  const continueIntoDraft = useCallback(
    (project: NonNullable<typeof localProject>) => {
      if (
        threadId === null ||
        primaryEnvironmentId === null ||
        state.transcript === null ||
        resuming
      ) {
        return;
      }
      setResuming(true);
      void (async () => {
        try {
          // A hand-off brief is the pre-reviewed nicety and wins; otherwise
          // the brief is generated HERE from the local transcript copy —
          // resume never requires preparation on the source machine (M5.5).
          let seedText = state.brief?.markdown ?? null;
          if (seedText === null || seedText.length === 0) {
            const generated = await generateRoamingBrief({ threadId });
            seedText = generated.markdown;
            for (const notice of generated.notices) {
              toastManager.add({ type: "info", title: "Resume brief", description: notice });
            }
          }
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
      sourceModelSelection,
      state.transcript,
      state.brief,
      resuming,
      projectGroupingSettings,
      primaryServerSettings,
      navigate,
    ],
  );

  // Materialize-and-continue: on an unmaterialized project, Continue-here
  // runs materialize (same confirm dialog as the project row) and chains
  // into the draft once the registered project lands in the shell.
  const { materialize, dialog: materializeDialog } = useMaterialize();
  const [pendingResumeProjectId, setPendingResumeProjectId] = useState<string | null>(null);
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
      continueIntoDraft(project);
    }
  }, [pendingResumeProjectId, projects, primaryEnvironmentId, continueIntoDraft]);

  const handleContinueHere = useCallback(() => {
    if (shell === null || state.transcript === null || resuming) {
      return;
    }
    if (localProject !== null) {
      continueIntoDraft(localProject);
      return;
    }
    const roamingProject =
      roamingProjects.find(
        (entry) =>
          entry.environmentId === primaryEnvironmentId &&
          entry.roamingProject.workspaceProjectId === shell.workspaceProjectId,
      )?.roamingProject ?? null;
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
    shell,
    state.transcript,
    resuming,
    localProject,
    continueIntoDraft,
    roamingProjects,
    primaryEnvironmentId,
    materialize,
  ]);

  if (threadId === null || primaryEnvironmentId === null) {
    return null;
  }
  if (state.status === "loading") {
    return null;
  }
  if (state.status === "missing" || state.transcript === null) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        This conversation is no longer available from the other machine.
      </div>
    );
  }
  const transcript = state.transcript;

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div
        className={cn(
          "flex items-center gap-3 border-b border-border py-2.5",
          // Same title-bar treatment as the chat header: without it the
          // Continue-here button rendered under the window controls.
          isElectron
            ? "workspace-topbar drag-region relative px-3 sm:px-5 wco:pr-[var(--workspace-native-controls-inset)]"
            : "workspace-topbar pl-[calc(env(safe-area-inset-left)+1rem)] pr-[calc(env(safe-area-inset-right)+1rem)]",
          COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-sm font-medium text-foreground">{transcript.title}</h1>
            <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
              {machineLabel !== null ? `From ${machineLabel}` : "From another machine"}
            </span>
          </div>
          <p className="truncate text-[11px] text-muted-foreground">
            Read-only
            {transcript.branch !== null ? ` · ${transcript.branch}` : ""}
            {transcript.truncated === true ? " · older history trimmed" : ""}
          </p>
        </div>
        <Button
          size="sm"
          disabled={resuming || pendingResumeProjectId !== null}
          title={
            localProject === null
              ? "Clones this project onto this machine first, then opens the resume draft"
              : undefined
          }
          onClick={handleContinueHere}
        >
          {resuming || pendingResumeProjectId !== null
            ? "Preparing…"
            : localProject === null
              ? "Materialize & continue"
              : "Continue here"}
        </Button>
      </div>
      {briefMarkdown !== null || briefDraft !== null ? (
        <div className="border-b border-border bg-muted/20 px-4 py-3">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-medium text-foreground">Handoff brief</span>
            {briefDraft === null ? (
              <Button size="sm" variant="ghost" onClick={() => setBriefDraft(briefMarkdown ?? "")}>
                Edit
              </Button>
            ) : (
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => setBriefDraft(null)}>
                  Cancel
                </Button>
                <Button size="sm" disabled={savingBrief} onClick={handleSaveBrief}>
                  {savingBrief ? "Saving…" : "Save"}
                </Button>
              </div>
            )}
          </div>
          {briefDraft === null ? (
            <div className="max-h-56 overflow-y-auto text-sm">
              <ChatMarkdown text={briefMarkdown ?? ""} cwd={undefined} />
            </div>
          ) : (
            <Textarea
              value={briefDraft}
              rows={10}
              onChange={(event) => setBriefDraft(event.target.value)}
            />
          )}
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <MessagesTimeline
          isWorking={false}
          activeTurnInProgress={false}
          activeTurnStartedAt={null}
          listRef={listRef}
          timelineEntries={timelineEntries}
          latestTurn={null}
          runningTurnId={null}
          turnDiffSummaryByAssistantMessageId={EMPTY_DIFF_SUMMARIES}
          routeThreadKey={scopedThreadKey(scopeThreadRef(primaryEnvironmentId, threadId))}
          onOpenTurnDiff={noop}
          revertTurnCountByUserMessageId={EMPTY_REVERT_COUNTS}
          onRevertUserMessage={noop}
          isRevertingCheckpoint={false}
          onImageExpand={noop}
          activeThreadEnvironmentId={primaryEnvironmentId}
          markdownCwd={undefined}
          resolvedTheme={resolvedTheme}
          timestampFormat={settings.timestampFormat}
          workspaceRoot={undefined}
          anchorMessageId={null}
          onAnchorReady={noop}
          onAnchorSizeChanged={noop}
          contentInsetEndAdjustment={0}
          onIsAtEndChange={noop}
          onManualNavigation={noop}
        />
      </div>
      {materializeDialog}
    </div>
  );
}

const noop = () => {};
const EMPTY_DIFF_SUMMARIES = new Map<never, never>();
const EMPTY_REVERT_COUNTS = new Map<never, never>();
