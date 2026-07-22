/**
 * HandOffDialog — parks a conversation for continuation on another of the
 * user's machines (roaming M5): a final snapshot is captured server-side and
 * a resumption brief is generated, shown here for editing before the user
 * walks away.
 */
import type { ThreadId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { parkRoamingThread, saveRoamingBrief } from "../environments/primary/roaming";
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
import { Textarea } from "./ui/textarea";
import { toastManager } from "./ui/toast";

export function HandOffDialog(props: {
  threadId: ThreadId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { threadId, open, onOpenChange } = props;
  const [phase, setPhase] = useState<"parking" | "editing" | "error">("parking");
  const [markdown, setMarkdown] = useState("");
  const [notices, setNotices] = useState<ReadonlyArray<string>>([]);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    setPhase("parking");
    setNotices([]);
    setErrorText(null);
    void parkRoamingThread({ threadId })
      .then((response) => {
        if (cancelled) return;
        setMarkdown(response.brief.markdown);
        setNotices(response.notices);
        setPhase("editing");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setErrorText(error instanceof Error ? error.message : "Request failed.");
        setPhase("error");
      });
    return () => {
      cancelled = true;
    };
  }, [open, threadId]);

  const handleSave = () => {
    if (saving) return;
    setSaving(true);
    void saveRoamingBrief({ threadId, markdown })
      .then(() => {
        toastManager.add({
          type: "success",
          title: "Ready to continue elsewhere",
          description: "The conversation and its brief will appear on your other machine.",
        });
        onOpenChange(false);
      })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not save the brief",
          description: error instanceof Error ? error.message : "Request failed.",
        });
      })
      .finally(() => setSaving(false));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Hand off this conversation</DialogTitle>
          <DialogDescription>
            A snapshot of this conversation travels to your other machine with a short brief for
            picking the work back up. Edit the brief before you go.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {phase === "parking" ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Writing the handoff brief…
            </p>
          ) : phase === "error" ? (
            <p className="py-4 text-sm text-destructive">{errorText}</p>
          ) : (
            <div className="space-y-2">
              <Textarea
                value={markdown}
                rows={14}
                className="font-mono text-xs"
                onChange={(event) => setMarkdown(event.target.value)}
              />
              {notices.map((notice) => (
                <p key={notice} className="text-xs text-muted-foreground">
                  {notice}
                </p>
              ))}
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={phase !== "editing" || saving} onClick={handleSave}>
            {saving ? "Saving…" : "Save brief"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
