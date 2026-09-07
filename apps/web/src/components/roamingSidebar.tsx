/**
 * Roaming's contribution to the sidebar, extracted behind one seam so
 * Sidebar.tsx (hot upstream code) keeps only call sites — fork discipline.
 * Contains the offline-project row family: peer sync state, the materialize
 * dialog/hook, the per-project sync indicator, and the M5.5 mirrored
 * thread-row helpers.
 */
import {
  CloudIcon,
  FileClockIcon,
  FolderPlusIcon,
  LoaderIcon,
  TriangleAlertIcon,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ProjectId,
  ROAMING_LEASE_ACTIVE_WINDOW_MS,
  WorkspaceProjectId,
  type RoamingThreadShell,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import {
  useEnvironmentRoamingThreads,
  useEnvironmentRoamingWipStatus,
  useRoamingMaterializations,
  useRoamingProjects,
  useThreadShells,
} from "../state/entities";
import type { EnvironmentRoamingProject } from "@t3tools/client-runtime/state/projects";
import {
  listRoamingPeers,
  materializeRoamingProject,
  takeoverRoamingWip,
} from "../environments/primary/roaming";

import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { RoamingDivergenceDialog } from "./RoamingDivergenceDialog";
import { toastManager } from "./ui/toast";
import { formatElapsedDurationLabel, formatRelativeTimeLabel } from "../timestampFormat";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "./ui/sidebar";
import { usePrimarySettings } from "~/hooks/useSettings";

/**
 * "Offline — available" rows of the single project list: registry entries
 * mirrored from other machines whose repository has no live row here. Same
 * list as local/attached projects (no separate section — 2026-07-05 product
 * model), greyed, with an honest staleness label and a Materialize action.
 */
// Peer sync state, lightly cached across rows. Standard-scoped sessions
// cannot read it (403) — they get null and the button stays enabled with
// click-time resolution.
let roamingPeersCache: { at: number; map: ReadonlyMap<string, boolean> } | null = null;
export function useRoamingPeerSyncEnabled(environmentId: string | null): boolean | null {
  const [map, setMap] = useState<ReadonlyMap<string, boolean> | null>(
    roamingPeersCache?.map ?? null,
  );
  useEffect(() => {
    if (environmentId === null) return;
    if (roamingPeersCache !== null && Date.now() - roamingPeersCache.at < 15_000) {
      setMap(roamingPeersCache.map);
      return;
    }
    let alive = true;
    listRoamingPeers().then(
      (result) => {
        const next = new Map(result.peers.map((peer) => [peer.environmentId, peer.syncEnabled]));
        roamingPeersCache = { at: Date.now(), map: next };
        if (alive) setMap(next);
      },
      () => {
        if (alive) setMap(null);
      },
    );
    return () => {
      alive = false;
    };
  }, [environmentId]);
  if (environmentId === null || map === null) return null;
  return map.get(environmentId) ?? null;
}

export type MaterializeTarget = {
  readonly title: string;
  readonly dirName: string;
  readonly workspaceProjectId: EnvironmentRoamingProject["roamingProject"]["workspaceProjectId"];
  /** Confirm-button label override ("Materialize & continue" on resume). */
  readonly confirmLabel?: string;
  /** Called after a completed materialization (resume chains the draft here). */
  readonly onSuccess?: (localProjectId: ProjectId | null) => void;
};

const joinTargetPath = (baseDirectory: string, dirName: string): string => {
  const base = baseDirectory.trim().replace(/[/\\]+$/, "");
  return base.length === 0 ? dirName : `${base}/${dirName}`;
};

/**
 * Materialize always asks where to clone: a dialog prefilled with
 * <default folder>/<project> when a default exists (2026-07-06). The chosen
 * path is a one-off `targetPath` for THIS materialize — the default folder
 * setting is never modified from here.
 */
/**
 * Per-project sync health: a persistent state for enabled, completed,
 * blocked, and failed sync. Data is the wip status the server already
 * streams; no new concepts, no "roaming" wording.
 */
export function ProjectSyncIndicator(props: {
  workspaceProjectId: string | null | undefined;
  projectTitle?: string;
}) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const wipStatus = useEnvironmentRoamingWipStatus(primaryEnvironmentId);
  const roamingWipSync = usePrimarySettings((settings) => settings.roamingWipSync);
  const roamingProjects = useRoamingProjects();
  const { environments } = useEnvironments();
  const entry = props.workspaceProjectId
    ? wipStatus.find((candidate) => candidate.workspaceProjectId === props.workspaceProjectId)
    : undefined;
  const [takingOver, setTakingOver] = useState(false);
  const [divergenceOpen, setDivergenceOpen] = useState(false);
  const machineLabel = useCallback(
    (environmentId: string | undefined) =>
      environmentId !== undefined
        ? (environments.find((candidate) => candidate.environmentId === environmentId)?.label ??
          null)
        : null,
    [environments],
  );
  // Advisory activity (M4): the machine with the newest lease record is
  // where work is live; only a FRESH record on another machine renders.
  const activity =
    props.workspaceProjectId && primaryEnvironmentId
      ? roamingProjects.find(
          (candidate) =>
            candidate.environmentId === primaryEnvironmentId &&
            candidate.roamingProject.workspaceProjectId === props.workspaceProjectId,
        )?.roamingProject.activity?.[0]
      : undefined;
  const blockedSnapshotOid = entry?.blockedSnapshotOid;
  const takeOver = useCallback(() => {
    if (!props.workspaceProjectId || takingOver) return;
    setTakingOver(true);
    void takeoverRoamingWip({
      workspaceProjectId: WorkspaceProjectId.make(props.workspaceProjectId),
      // Pin the snapshot the pill described — a newer arrival refuses
      // instead of silently applying work the user never saw.
      ...(blockedSnapshotOid !== undefined ? { snapshotOid: blockedSnapshotOid } : {}),
    })
      .then(({ applied, reason }) => {
        if (!applied)
          throw new Error(reason ?? "The other machine's state is no longer available.");
        toastManager.add({ type: "success", title: "Switched to the other machine's work" });
      })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not switch project state",
          description: error instanceof Error ? error.message : "Try again in a moment.",
        });
      })
      .finally(() => setTakingOver(false));
  }, [props.workspaceProjectId, takingOver, blockedSnapshotOid]);

  // Re-render on a clock so "Synced 3m" stays fresh even when no new status
  // arrives. Capture/apply timestamps record completed operations; they must
  // never be presented as work still in progress.
  const lastActivityIso = entry?.lastAppliedAt ?? entry?.lastPushedAt;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 20_000);
    return () => window.clearInterval(interval);
  }, []);

  // This pill reports WIP sync, which only exists for a local checkout — a
  // remote-only (unmaterialized) row shows no pill instead of an idle
  // "Synced" (M5.5 field fix).
  const roamingEntry =
    props.workspaceProjectId && primaryEnvironmentId
      ? roamingProjects.find(
          (candidate) =>
            candidate.environmentId === primaryEnvironmentId &&
            candidate.roamingProject.workspaceProjectId === props.workspaceProjectId,
        )?.roamingProject
      : undefined;
  if (roamingEntry !== undefined && roamingEntry.localProjectId === null) {
    return null;
  }

  if (!entry) {
    // Enrolled + WIP sync on, but no status row in the shell snapshot yet
    // (warm-cache resume used to skip roamingWipStatus until the next pass).
    if (props.workspaceProjectId && roamingWipSync) {
      return (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label="Sync is on for this project"
                className="inline-flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground/70"
              >
                <span className="size-2 shrink-0 rounded-full bg-muted-foreground/50" />
                <span className="whitespace-nowrap">Synced</span>
              </span>
            }
          />
          <TooltipPopup side="top">Sync is on for this project</TooltipPopup>
        </Tooltip>
      );
    }
    return null;
  }

  // A persistent pill so "sync is on and healthy" is always visible — not a
  // dot that vanishes after two minutes. States, most-urgent first:
  //   error → red · blocked → amber · completed activity → green · idle.
  // M5.5 (f): every non-error, non-blocked state reads "Synced" — the label
  // must be identical on both machines, and activity timestamps are
  // machine-local (one side captures, the other applies, an untouched
  // project records nothing). Freshness and degradation detail live in the
  // tooltip and the dot color.
  type Pill = { icon: "spinner" | "dot"; dotClass: string; text: string; tip: string };
  let pill: Pill;
  if (entry.lastError) {
    pill = {
      icon: "dot",
      dotClass: "bg-destructive",
      text: "Sync error",
      tip: `Sync problem: ${entry.lastError}`,
    };
  } else if (entry.blockedReason) {
    if (entry.divergenceAvailable) {
      // Two-sided divergence: the pill opens diff-and-choose, never a
      // blind takeover — this screen is the trust story of the feature.
      pill = {
        icon: "dot",
        dotClass: "bg-amber-500",
        text: "Review changes",
        tip: `${entry.blockedReason}. Review both versions and pick which one to keep.`,
      };
    } else if (entry.takeoverAvailable) {
      pill = {
        icon: takingOver ? "spinner" : "dot",
        dotClass: "bg-amber-500",
        text: takingOver ? "Switching…" : "Take over",
        tip: `${entry.blockedReason}. Take over to park this machine's work and switch to the other machine's state.`,
      };
    } else {
      // Blocked but not actionable right now (e.g. an agent turn is in
      // flight) — honest waiting state instead of a button that refuses.
      pill = {
        icon: "dot",
        dotClass: "bg-amber-500",
        text: "Waiting",
        tip: entry.blockedReason,
      };
    }
  } else if (entry.notice) {
    // Degraded but working (e.g. file watching unavailable): sync still
    // runs on a short sweep — advisory amber, not an error.
    pill = {
      icon: "dot",
      dotClass: "bg-amber-500",
      text: "Synced",
      tip: entry.notice,
    };
  } else if (
    activity !== undefined &&
    activity.environmentId !== primaryEnvironmentId &&
    now - Date.parse(activity.renewedAt) < ROAMING_LEASE_ACTIVE_WINDOW_MS
  ) {
    // Advisory lease chip (M4): work is live on the other machine right now.
    const label = machineLabel(activity.environmentId);
    pill = {
      icon: "dot",
      dotClass: "bg-sky-500",
      text: label !== null ? `Active on ${label}` : "Active elsewhere",
      tip: `Being worked on ${label ?? "the other machine"} right now${
        activity.lastSnapshotAt !== undefined
          ? ` — last snapshot ${formatElapsedDurationLabel(activity.lastSnapshotAt, now)} ago`
          : ""
      }.`,
    };
  } else if (lastActivityIso !== undefined) {
    pill = {
      icon: "dot",
      dotClass: "bg-emerald-500",
      text: "Synced",
      tip: entry.lastAppliedAt
        ? `Synced — received ${formatRelativeTimeLabel(entry.lastAppliedAt)}`
        : `Synced — sent ${formatRelativeTimeLabel(entry.lastPushedAt ?? "")}`,
    };
  } else {
    pill = {
      icon: "dot",
      dotClass: "bg-muted-foreground/50",
      text: "Synced",
      tip: "Sync is on for this project — no changes yet",
    };
  }

  // Divergence takes precedence over blind takeover; takeover remains
  // reachable inside the dialog as "Take the other machine's version".
  // A red "Sync error" pill must never carry a hidden action — the label
  // and the click have to agree.
  const pillAction = entry.lastError
    ? null
    : entry.divergenceAvailable
      ? () => setDivergenceOpen(true)
      : entry.takeoverAvailable
        ? takeOver
        : null;

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              role={pillAction !== null ? "button" : undefined}
              tabIndex={pillAction !== null ? 0 : undefined}
              aria-label={pill.tip}
              aria-disabled={takingOver || undefined}
              onPointerDown={(event) => pillAction !== null && event.stopPropagation()}
              onClick={(event) => {
                if (pillAction === null) return;
                event.stopPropagation();
                pillAction();
              }}
              onKeyDown={(event) => {
                if (pillAction === null || (event.key !== "Enter" && event.key !== " ")) return;
                event.preventDefault();
                event.stopPropagation();
                pillAction();
              }}
              className="inline-flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground/70"
            >
              {pill.icon === "spinner" ? (
                <LoaderIcon className="size-2.5 shrink-0 animate-spin" />
              ) : (
                <span className={`size-2 shrink-0 rounded-full ${pill.dotClass}`} />
              )}
              <span className="whitespace-nowrap">{pill.text}</span>
            </span>
          }
        />
        <TooltipPopup side="top">{pill.tip}</TooltipPopup>
      </Tooltip>
      {divergenceOpen &&
        props.workspaceProjectId !== null &&
        props.workspaceProjectId !== undefined && (
          <RoamingDivergenceDialog
            workspaceProjectId={props.workspaceProjectId}
            projectTitle={props.projectTitle}
            peerLabel={machineLabel(entry.blockedFrom)}
            open={divergenceOpen}
            onOpenChange={setDivergenceOpen}
          />
        )}
    </>
  );
}

export function useMaterialize() {
  const defaultBaseDirectory = usePrimarySettings((settings) => settings.addProjectBaseDirectory);
  const [pending, setPending] = useState<MaterializeTarget | null>(null);
  const [targetPath, setTargetPath] = useState("");
  const [restoreWip, setRestoreWip] = useState(true);
  const [busy, setBusy] = useState(false);

  const materialize = useCallback(
    (target: MaterializeTarget) => {
      setTargetPath(joinTargetPath(defaultBaseDirectory, target.dirName));
      setRestoreWip(true);
      setPending(target);
    },
    [defaultBaseDirectory],
  );

  const submit = useCallback(() => {
    const target = pending;
    const chosen = targetPath.trim();
    if (target === null || chosen === "") return;
    setBusy(true);
    void (async () => {
      try {
        const { materialization: result } = await materializeRoamingProject({
          workspaceProjectId: target.workspaceProjectId,
          targetPath: chosen,
          restoreWip,
        });
        if (result.status === "failed") {
          toastManager.add({
            type: "error",
            title: `Materialize failed: ${target.title}`,
            description: result.error ?? "See the server log for details.",
          });
          return;
        }
        toastManager.add({
          type: "success",
          title: `${target.title} is ready`,
          description: result.notices.length > 0 ? result.notices.join(" · ") : undefined,
        });
        setPending(null);
        target.onSuccess?.(result.localProjectId ?? null);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: `Materialize failed: ${target.title}`,
          description: error instanceof Error ? error.message : "Request failed.",
        });
      } finally {
        setBusy(false);
      }
    })();
  }, [pending, targetPath, restoreWip]);

  const dialog = (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open && !busy) setPending(null);
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Materialize {pending?.title ?? "project"}</DialogTitle>
          <DialogDescription>
            Choose the folder to clone into. Prefilled from your default projects folder; edit it
            for this project only — your default is not changed.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Input
            value={targetPath}
            onChange={(event) => setTargetPath(event.target.value)}
            placeholder="~/projects/my-app"
            spellCheck={false}
            disabled={busy}
          />
          <label className="mt-3 flex cursor-pointer items-center gap-2">
            <Checkbox
              checked={restoreWip}
              disabled={busy}
              onCheckedChange={(checked) => setRestoreWip(checked === true)}
            />
            <span className="text-xs text-muted-foreground">
              Include work in progress (uncommitted changes from the other machine)
            </span>
          </label>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => setPending(null)}>
            Cancel
          </Button>
          <Button disabled={busy || targetPath.trim() === ""} onClick={submit}>
            {busy ? "Materializing…" : (pending?.confirmLabel ?? "Materialize")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );

  return { materialize, dialog };
}

/**
 * The greyed fallback rows for a project's mirrored conversations whose
 * author machine is UNREACHABLE (M5.5): author-reachability gate plus a
 * structural belt — no fallback while ANY reachable environment holds a
 * live shell for the same thread. Shared by the thread list (which also
 * needs the count to suppress its empty state) and the offline project
 * row; `reachableEnvironmentIds` comes from a single read in the projects
 * content so live rows and fallback rows always share a vintage.
 */
export function useMirroredFallbackRows(
  workspaceProjectId: string | null,
  reachableEnvironmentIds: ReadonlySet<string>,
): ReadonlyArray<RoamingThreadShell> {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const roamingThreads = useEnvironmentRoamingThreads(primaryEnvironmentId);
  const allThreadShells = useThreadShells();
  return useMemo(() => {
    const liveRowThreadIds = new Set<string>();
    for (const shell of allThreadShells) {
      if (reachableEnvironmentIds.has(shell.environmentId)) {
        liveRowThreadIds.add(shell.id);
      }
    }
    return roamingThreads.filter(
      (thread) =>
        (workspaceProjectId === null || thread.workspaceProjectId === workspaceProjectId) &&
        !reachableEnvironmentIds.has(thread.authorEnvironmentId) &&
        !liveRowThreadIds.has(thread.threadId),
    );
  }, [workspaceProjectId, roamingThreads, allThreadShells, reachableEnvironmentIds]);
}

/**
 * Mirrored-conversation rows (M5, surfacing corrected in M5.5): the greyed
 * fallback for a peer that is UNREACHABLE. While the author machine is live,
 * its threads are already in the list as thin-client rows and the mirror
 * stays invisible behind them — one row per thread, ever (the
 * offline-project-row model applied to threads). Opening a fallback row
 * shows the read-only transcript from the local copy.
 */
export function SidebarMirroredThreadRows(props: { rows: ReadonlyArray<RoamingThreadShell> }) {
  const router = useRouter();
  const { environments } = useEnvironments();
  const { rows } = props;
  if (rows.length === 0) {
    return null;
  }
  return (
    <>
      {rows.map((thread) => {
        const machineLabel =
          environments.find((candidate) => candidate.environmentId === thread.authorEnvironmentId)
            ?.label ?? "another machine";
        return (
          <SidebarMenuSubItem key={`mirrored:${thread.threadId}`} className="w-full">
            <SidebarMenuSubButton
              render={<div role="button" tabIndex={0} />}
              size="sm"
              className="h-6 w-full translate-x-0 cursor-pointer justify-start gap-1.5 px-2 text-left text-xs text-muted-foreground/80 opacity-60 hover:bg-accent hover:opacity-100"
              title={`From ${machineLabel} (offline) — read-only copy`}
              onClick={() => {
                void router.navigate({
                  to: "/mirrored/$threadId",
                  params: { threadId: thread.threadId },
                });
              }}
              onKeyDown={(event: React.KeyboardEvent) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  void router.navigate({
                    to: "/mirrored/$threadId",
                    params: { threadId: thread.threadId },
                  });
                }
              }}
            >
              <FileClockIcon className="size-3 shrink-0 text-muted-foreground/50" />
              <span className="min-w-0 flex-1 truncate">{thread.title}</span>
              <span className="shrink-0 text-[10px] text-muted-foreground/50">{machineLabel}</span>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
        );
      })}
    </>
  );
}

export function SidebarOfflineProjectRow(props: {
  entry: EnvironmentRoamingProject;
  reachableEnvironmentIds: ReadonlySet<string>;
}) {
  const { environmentId, roamingProject } = props.entry;
  const offlineMirroredRows = useMirroredFallbackRows(
    roamingProject.workspaceProjectId,
    props.reachableEnvironmentIds,
  );
  const materializations = useRoamingMaterializations();
  const materialization =
    materializations.find(
      (candidate) =>
        candidate.materialization.workspaceProjectId === roamingProject.workspaceProjectId,
    )?.materialization ?? null;
  const isMaterializing = materialization?.status === "running";
  const { materialize, dialog: materializeDialog } = useMaterialize();

  const runningStep = isMaterializing
    ? (materialization.steps.find((step) => step.status === "running")?.step ?? "starting")
    : null;
  const repository =
    roamingProject.repository.displayName ??
    roamingProject.repository.name ??
    roamingProject.repository.locator.remoteUrl;
  const staleness =
    roamingProject.lastMirrorContactAt === null
      ? "never synced"
      : `synced ${formatRelativeTimeLabel(roamingProject.lastMirrorContactAt)}`;
  // Conflicts auto-resolve newest-wins (D1); the record that remains is a
  // notice, dismissible per detection — a fresh conflict re-shows it.
  const latestConflictAt = roamingProject.conflicts.reduce(
    (latest, conflict) => (conflict.detectedAt > latest ? conflict.detectedAt : latest),
    "",
  );
  const conflictDismissKey = `t3code:roaming-conflict-dismissed:${roamingProject.workspaceProjectId}`;
  const [dismissedConflictAt, setDismissedConflictAt] = useState(() =>
    localStorage.getItem(conflictDismissKey),
  );
  const showConflictNotice = latestConflictAt !== "" && dismissedConflictAt !== latestConflictAt;

  const handleMaterialize = useCallback(() => {
    materialize({
      title: roamingProject.title,
      dirName: roamingProject.repository.name ?? roamingProject.title,
      workspaceProjectId: roamingProject.workspaceProjectId,
    });
  }, [materialize, roamingProject]);

  return (
    <SidebarMenuItem key={`${environmentId}:${roamingProject.workspaceProjectId}`}>
      <Tooltip>
        <TooltipTrigger
          render={<div className="group/offline flex items-center gap-2 rounded-md px-2 py-1.5" />}
        >
          <CloudIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
          <div className="min-w-0 flex-1 opacity-60">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm text-muted-foreground">{roamingProject.title}</span>
              {showConflictNotice ? (
                <Tooltip>
                  <TooltipTrigger
                    render={<button type="button" className="shrink-0" />}
                    aria-label="Dismiss resolved sync conflict"
                    onClick={(event) => {
                      event.stopPropagation();
                      localStorage.setItem(conflictDismissKey, latestConflictAt);
                      setDismissedConflictAt(latestConflictAt);
                    }}
                  >
                    <TriangleAlertIcon className="size-3 shrink-0 text-warning" />
                  </TooltipTrigger>
                  <TooltipPopup>
                    Sync conflict auto-resolved — both machines changed this project's synced
                    settings while apart, and the newest change won. Click to dismiss.
                  </TooltipPopup>
                </Tooltip>
              ) : null}
            </div>
            <div className="truncate text-[10px] text-muted-foreground/60">
              {isMaterializing ? `materializing: ${runningStep}…` : `${repository} · ${staleness}`}
            </div>
          </div>
          {isMaterializing ? (
            <LoaderIcon className="size-3.5 shrink-0 animate-spin text-muted-foreground/60" />
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className="hidden shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground group-hover/offline:flex"
                  />
                }
                onClick={handleMaterialize}
              >
                <FolderPlusIcon className="size-3" />
                Materialize
              </TooltipTrigger>
              <TooltipPopup>
                Clone this project here, apply synced secret files, and open it
              </TooltipPopup>
            </Tooltip>
          )}
        </TooltipTrigger>
        <TooltipPopup>{`${roamingProject.title} — offline, available from its mirror copy (${staleness})`}</TooltipPopup>
      </Tooltip>
      <SidebarMenuSub className="mx-0.5 my-0 w-full translate-x-0 gap-0.5 overflow-hidden px-1 py-0 sm:mx-1 sm:px-1.5">
        <SidebarMirroredThreadRows rows={offlineMirroredRows} />
      </SidebarMenuSub>
      {materializeDialog}
    </SidebarMenuItem>
  );
}
