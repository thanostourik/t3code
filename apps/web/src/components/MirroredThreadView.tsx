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
  type OrchestrationProposedPlan,
  type OrchestrationThreadActivity,
  type RoamingBriefPayload,
  type RoamingTranscriptPayload,
} from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useTheme } from "../hooks/useTheme";
import { usePrimarySettings } from "../hooks/useSettings";
import { useContinueHere } from "../hooks/useContinueHere";
import { getRoamingThreadTranscript, saveRoamingBrief } from "../environments/primary/roaming";
import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { deriveTimelineEntries, deriveWorkLogEntries } from "../session-logic";
import { useEnvironmentRoamingThreads } from "../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import type { ChatMessage } from "../types";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";
import type { LegendListRef } from "@legendapp/list/react";

import { MessagesTimeline } from "./chat/MessagesTimeline";
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
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const roamingThreads = useEnvironmentRoamingThreads(primaryEnvironmentId);
  const settings = usePrimarySettings();
  const { resolvedTheme } = useTheme();
  const listRef = useRef<LegendListRef | null>(null);

  const [state, setState] = useState<TranscriptState>(INITIAL_STATE);
  const [briefDraft, setBriefDraft] = useState<string | null>(null);
  const [savingBrief, setSavingBrief] = useState(false);

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

  const workspaceProjectIdForResume =
    state.transcript?.workspaceProjectId ?? shell?.workspaceProjectId ?? null;
  const {
    continueHere: handleContinueHere,
    busy: continueBusy,
    needsMaterialize,
    dialog: materializeDialog,
  } = useContinueHere({ threadId, workspaceProjectId: workspaceProjectIdForResume });

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
          disabled={continueBusy}
          title={
            needsMaterialize
              ? "Clones this project onto this machine first, then opens the resume draft"
              : undefined
          }
          onClick={handleContinueHere}
        >
          {continueBusy
            ? "Preparing…"
            : needsMaterialize
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
          activeTurnStartedAt={null}
          listRef={listRef}
          timelineEntries={timelineEntries}
          latestTurn={null}
          runningTurnId={null}
          turnDiffSummaries={EMPTY_DIFF_SUMMARIES}
          routeThreadKey={scopedThreadKey(scopeThreadRef(primaryEnvironmentId, threadId))}
          onOpenTurnDiff={noop}
          supportsConversationRollback={false}
          onRevertToTurnCount={noop}
          isRevertingCheckpoint={false}
          onImageExpand={noop}
          activeThreadEnvironmentId={primaryEnvironmentId}
          markdownCwd={undefined}
          resolvedTheme={resolvedTheme}
          timestampFormat={settings.timestampFormat}
          workspaceRoot={undefined}
          anchorMessageId={null}
          onAnchorReady={noop}
          contentInsetEndAdjustment={0}
          liveFollowEnabled={false}
          onIsAtEndChange={noop}
          onManualNavigation={noop}
        />
      </div>
      {materializeDialog}
    </div>
  );
}

const noop = () => {};
const EMPTY_DIFF_SUMMARIES: [] = [];
