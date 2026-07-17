/**
 * Diff-and-choose divergence resolution (M4): the same branch moved on both
 * machines. Shows each machine's full working state as a patch from the
 * common ancestor; the user keeps a whole side, never a merge, and the
 * losing side stays recoverable as a git ref. Concept-free copy — this
 * screen is the trust story of the sync feature.
 */
import { WorkspaceProjectId, type RoamingWipDivergence } from "@t3tools/contracts";
import { FileDiff } from "@pierre/diffs/react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  getRoamingWipDivergence,
  resolveRoamingWipDivergence,
} from "../environments/primary/roaming";
import { useTheme } from "../hooks/useTheme";
import { useEnvironments } from "../state/environments";
import {
  buildFileDiffRenderKey,
  getRenderablePatch,
  resolveDiffThemeName,
} from "../lib/diffRendering";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { toastManager } from "./ui/toast";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { LoaderIcon } from "lucide-react";

function DivergenceSidePatch(props: {
  patch: string;
  truncated?: boolean | undefined;
  cacheScope: string;
}) {
  const { resolvedTheme } = useTheme();
  const renderable = useMemo(
    () => getRenderablePatch(props.patch, props.cacheScope),
    [props.patch, props.cacheScope],
  );
  if (renderable === null) {
    return <p className="p-3 text-sm text-muted-foreground">No changes on this side.</p>;
  }
  return (
    <div className="space-y-2">
      {props.truncated && (
        <p className="text-xs text-amber-600">
          This diff is very large and was cut off — the full state still applies when you pick a
          side.
        </p>
      )}
      {renderable.kind === "files" ? (
        renderable.files.map((fileDiff) => (
          <FileDiff
            key={buildFileDiffRenderKey(fileDiff)}
            fileDiff={fileDiff}
            options={{
              collapsed: false,
              diffStyle: "unified",
              theme: resolveDiffThemeName(resolvedTheme),
            }}
          />
        ))
      ) : (
        <pre className="overflow-x-auto rounded-md bg-muted/40 p-2 text-xs">{renderable.text}</pre>
      )}
    </div>
  );
}

export function RoamingDivergenceDialog(props: {
  workspaceProjectId: string;
  projectTitle?: string | undefined;
  peerLabel: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [divergence, setDivergence] = useState<RoamingWipDivergence | null>(null);
  const [loading, setLoading] = useState(false);
  const [resolving, setResolving] = useState<"local" | "peer" | null>(null);
  const [side, setSide] = useState<"local" | "peer">("peer");
  const { environments } = useEnvironments();
  // Prefer the fetched divergence's authoritative peer environment; the
  // prop (from the blocked status) only bridges until the data arrives.
  const fetchedLabel =
    divergence !== null
      ? (environments.find((candidate) => candidate.environmentId === divergence.peer.environmentId)
          ?.label ?? null)
      : null;
  const otherMachine = fetchedLabel ?? props.peerLabel ?? "the other machine";

  useEffect(() => {
    if (!props.open) return;
    let cancelled = false;
    setLoading(true);
    setDivergence(null);
    setSide("peer");
    getRoamingWipDivergence({
      workspaceProjectId: WorkspaceProjectId.make(props.workspaceProjectId),
    })
      .then((response) => {
        if (cancelled) return;
        setDivergence(response.divergence);
        if (response.divergence === null) {
          // Resolved elsewhere between the pill render and this open.
          toastManager.add({
            type: "success",
            title: "Already settled",
            description: "The two machines no longer disagree on this project.",
          });
          props.onOpenChange(false);
        }
      })
      .catch(() => {
        if (cancelled) return;
        toastManager.add({
          type: "error",
          title: "Could not load the two versions",
          description: "Try again in a moment.",
        });
        props.onOpenChange(false);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch only on open
  }, [props.open, props.workspaceProjectId]);

  const resolve = useCallback(
    (pick: "local" | "peer") => {
      if (divergence === null || resolving !== null) return;
      setResolving(pick);
      resolveRoamingWipDivergence({
        workspaceProjectId: WorkspaceProjectId.make(props.workspaceProjectId),
        pick,
        peerSnapshotOid: divergence.peer.snapshotOid,
      })
        .then((result) => {
          if (!result.resolved) {
            throw new Error(result.reason ?? "Try again in a moment.");
          }
          toastManager.add({
            type: "success",
            title:
              pick === "local"
                ? "Kept this machine's version"
                : `Switched to ${otherMachine}'s version`,
            description:
              pick === "local"
                ? `${otherMachine}'s version stays recoverable on this machine.`
                : "This machine's version was parked and stays recoverable.",
          });
          props.onOpenChange(false);
        })
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: "Could not settle the difference",
            description: error instanceof Error ? error.message : "Try again in a moment.",
          });
        })
        .finally(() => setResolving(null));
    },
    [divergence, resolving, props, otherMachine],
  );

  const branchName = divergence?.local.branchRef.replace(/^refs\/heads\//, "");

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Changed on both machines</DialogTitle>
          <DialogDescription>
            {branchName !== undefined
              ? `${props.projectTitle ?? "This project"} moved ahead separately on ${branchName} here and on ${otherMachine}. Pick which version this machine should keep — the other stays recoverable.`
              : "Comparing the two machines' versions…"}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <LoaderIcon className="size-4 animate-spin" />
              Comparing versions…
            </div>
          )}
          {divergence !== null && (
            <>
              {/* Plain toggle buttons rather than a partial ARIA tabs
                  implementation — Tab/Enter/Space work, aria-pressed carries
                  the state. */}
              <div className="flex gap-1 rounded-md bg-muted/40 p-1 text-sm">
                <button
                  type="button"
                  aria-pressed={side === "peer"}
                  className={`flex-1 rounded px-3 py-1.5 ${side === "peer" ? "bg-background shadow-sm" : "text-muted-foreground"}`}
                  onClick={() => setSide("peer")}
                >
                  On {otherMachine} · {formatRelativeTimeLabel(divergence.peer.capturedAt)}
                </button>
                <button
                  type="button"
                  aria-pressed={side === "local"}
                  className={`flex-1 rounded px-3 py-1.5 ${side === "local" ? "bg-background shadow-sm" : "text-muted-foreground"}`}
                  onClick={() => setSide("local")}
                >
                  On this machine · now
                </button>
              </div>
              <div className="max-h-[55vh] overflow-y-auto">
                {side === "peer" ? (
                  <DivergenceSidePatch
                    patch={divergence.peer.patch}
                    truncated={divergence.peer.truncated}
                    cacheScope={`divergence-peer:${divergence.peer.snapshotOid}`}
                  />
                ) : (
                  <DivergenceSidePatch
                    patch={divergence.local.patch}
                    truncated={divergence.local.truncated}
                    cacheScope={`divergence-local:${divergence.local.snapshotOid}`}
                  />
                )}
              </div>
            </>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={() => props.onOpenChange(false)}>
            Not now
          </Button>
          <Button
            variant="outline"
            disabled={divergence === null || resolving !== null}
            onClick={() => resolve("local")}
          >
            {resolving === "local" && <LoaderIcon className="size-3.5 animate-spin" />}
            Keep this machine's version
          </Button>
          <Button
            disabled={divergence === null || resolving !== null}
            onClick={() => resolve("peer")}
          >
            {resolving === "peer" && <LoaderIcon className="size-3.5 animate-spin" />}
            Take {otherMachine}'s version
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
