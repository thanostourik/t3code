/**
 * Machine sync (roaming) settings: pair another of the user's machines for
 * project sync, with the JetBrains-style sync-options step (2026-07-05
 * product model). Projects always sync once paired; secret files are an
 * explicit, pre-checked consent. There is no user-visible "roaming"
 * concept — confirming the first machine turns the subsystem on.
 */
import { useState } from "react";
import { LaptopIcon, Loader2Icon } from "lucide-react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { addRoamingPeer } from "../../environments/primary/roaming";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function MachineSyncSection() {
  const roamingEnabled = usePrimarySettings((settings) => settings.roaming);
  const secretsSyncEnabled = usePrimarySettings((settings) => settings.roamingSecretsSync);
  const updateSettings = useUpdatePrimarySettings();
  const [isPairDialogOpen, setIsPairDialogOpen] = useState(false);

  return (
    <SettingsSection
      title="Machine sync"
      headerAction={
        <Button variant="outline" size="sm" onClick={() => setIsPairDialogOpen(true)}>
          <LaptopIcon className="size-3.5" />
          Pair machine
        </Button>
      }
    >
      {roamingEnabled ? (
        <>
          <SettingsRow
            title="Project sync"
            description="Your project list syncs between paired machines whenever both are online. Projects from other machines appear in the sidebar, ready to materialize."
            control={<Switch aria-label="Project sync" checked disabled />}
          />
          <SettingsRow
            title="Secret files"
            description="Sync gitignored secret files (.env, local certs) from this machine to your other machines. They travel only over the direct connection between your machines."
            control={
              <Switch
                aria-label="Sync secret files"
                checked={secretsSyncEnabled}
                onCheckedChange={(checked) => updateSettings({ roamingSecretsSync: checked })}
              />
            }
          />
        </>
      ) : (
        <SettingsRow
          title="Not set up"
          description="Pair another of your machines to sync your project list — and optionally secret files — directly between them. No cloud service involved."
        />
      )}
      <PairMachineDialog
        open={isPairDialogOpen}
        onOpenChange={setIsPairDialogOpen}
        initialSecretsChecked={roamingEnabled ? secretsSyncEnabled : true}
      />
    </SettingsSection>
  );
}

function PairMachineDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialSecretsChecked: boolean;
}) {
  const updateSettings = useUpdatePrimarySettings();
  const [baseUrl, setBaseUrl] = useState("");
  const [pairingCredential, setPairingCredential] = useState("");
  // Pre-checked per the product decision: secrets sync is the default,
  // consented at pairing time, not buried in settings after the fact.
  const [secretsChecked, setSecretsChecked] = useState(props.initialSecretsChecked);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const canSubmit = baseUrl.trim().length > 0 && pairingCredential.trim().length > 0;

  const handleOpenChange = (open: boolean) => {
    if (isSubmitting) return;
    if (!open) {
      setBaseUrl("");
      setPairingCredential("");
      setErrorMessage(null);
    }
    props.onOpenChange(open);
  };

  const handleSubmit = () => {
    if (!canSubmit || isSubmitting) return;
    setIsSubmitting(true);
    setErrorMessage(null);
    void (async () => {
      try {
        await addRoamingPeer({
          baseUrls: [baseUrl.trim()],
          pairingCredential: pairingCredential.trim(),
        });
        updateSettings({ roaming: true, roamingSecretsSync: secretsChecked });
        toastManager.add({
          type: "success",
          title: "Machine paired",
          description: "Now syncing projects with your other machine.",
        });
        setIsSubmitting(false);
        handleOpenChange(false);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "Pairing failed.");
        setIsSubmitting(false);
      }
    })();
  };

  return (
    <Dialog open={props.open} onOpenChange={handleOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Pair a machine for sync</DialogTitle>
          <DialogDescription>
            On the other machine, run{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              t3 auth pairing create --admin
            </code>{" "}
            and paste the credential here along with a URL this machine can reach it at.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 px-6 py-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Machine URL</span>
            <Input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="http://desktop.tail1234.ts.net:3773"
              autoFocus
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Pairing credential</span>
            <Input
              value={pairingCredential}
              onChange={(event) => setPairingCredential(event.target.value)}
              placeholder="Paste the credential from the other machine"
            />
          </label>
          <div className="flex flex-col gap-2 rounded-md border border-border/70 p-3">
            <span className="text-xs font-medium text-muted-foreground">What syncs</span>
            <label className="flex items-start gap-2">
              <Checkbox checked disabled className="mt-0.5" />
              <span className="text-sm">
                Projects
                <span className="block text-xs text-muted-foreground">
                  Your project list, on every paired machine. Always on.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2">
              <Checkbox
                checked={secretsChecked}
                onCheckedChange={(checked) => setSecretsChecked(checked === true)}
                className="mt-0.5"
              />
              <span className="text-sm">
                Secret files
                <span className="block text-xs text-muted-foreground">
                  Gitignored files like .env and local certs, directly between your machines only.
                </span>
              </span>
            </label>
          </div>
          {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit || isSubmitting}>
            {isSubmitting ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
            Pair and sync
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
