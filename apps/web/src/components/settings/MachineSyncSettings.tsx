/**
 * Machine sync (roaming) settings: pair another of the user's machines for
 * project sync, with the JetBrains-style sync-options step (2026-07-05
 * product model). Projects always sync once paired; secret files are an
 * explicit, pre-checked consent. There is no user-visible "roaming"
 * concept, no settings-file editing, and no CLI: the switch turns the
 * subsystem on, "Generate pairing code" mints the admin credential the
 * other machine pastes into its own "Pair machine" dialog.
 */
import { useState } from "react";
import { AuthAdministrativeScopes } from "@t3tools/contracts";
import { CopyIcon, LaptopIcon, Loader2Icon } from "lucide-react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { addRoamingPeer } from "../../environments/primary/roaming";
import { createServerPairingCredential } from "~/environments/primary";
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
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);
  const [isGeneratingCode, setIsGeneratingCode] = useState(false);

  const handleGenerateCode = () => {
    if (isGeneratingCode) return;
    setIsGeneratingCode(true);
    void (async () => {
      try {
        const { credential } = await createServerPairingCredential({
          label: "Machine sync",
          scopes: AuthAdministrativeScopes,
        });
        setGeneratedCode(credential);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not generate a pairing code",
          description: error instanceof Error ? error.message : "Request failed.",
        });
      } finally {
        setIsGeneratingCode(false);
      }
    })();
  };

  return (
    <SettingsSection title="Machine sync">
      <SettingsRow
        title="Sync between your machines"
        description="Your project list appears on every machine you pair, ready to open or materialize. Data travels directly between your machines — no cloud service."
        control={
          <Switch
            aria-label="Machine sync"
            checked={roamingEnabled}
            onCheckedChange={(checked) => updateSettings({ roaming: checked })}
          />
        }
      />
      {roamingEnabled ? (
        <>
          <SettingsRow
            title="Secret files"
            description="Sync gitignored secret files (.env, local certs) from this machine to your other machines."
            control={
              <Switch
                aria-label="Sync secret files"
                checked={secretsSyncEnabled}
                onCheckedChange={(checked) => updateSettings({ roamingSecretsSync: checked })}
              />
            }
          />
          <SettingsRow
            title="Pair a machine"
            description="Generate a code here and paste it on the other machine — or paste a code from the other machine here."
            control={
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={handleGenerateCode}>
                  {isGeneratingCode ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
                  Generate pairing code
                </Button>
                <Button variant="outline" size="sm" onClick={() => setIsPairDialogOpen(true)}>
                  <LaptopIcon className="size-3.5" />
                  Pair machine
                </Button>
              </div>
            }
          />
        </>
      ) : null}
      <PairMachineDialog
        open={isPairDialogOpen}
        onOpenChange={setIsPairDialogOpen}
        initialSecretsChecked={roamingEnabled ? secretsSyncEnabled : true}
      />
      <GeneratedCodeDialog code={generatedCode} onClose={() => setGeneratedCode(null)} />
    </SettingsSection>
  );
}

function GeneratedCodeDialog(props: { code: string | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (props.code === null) return;
    void navigator.clipboard.writeText(props.code).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };

  return (
    <Dialog
      open={props.code !== null}
      onOpenChange={(open) => {
        if (!open) {
          setCopied(false);
          props.onClose();
        }
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Pairing code</DialogTitle>
          <DialogDescription>
            On your other machine, open Settings → Connections → Machine sync, choose{" "}
            <span className="font-medium">Pair machine</span>, and paste this code along with a URL
            that machine can reach this one at (shown under Network access above).
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 px-6 py-4">
          <Input readOnly value={props.code ?? ""} className="font-mono text-xs" />
          <Button variant="outline" size="sm" onClick={handleCopy}>
            <CopyIcon className="size-3.5" />
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <DialogFooter>
          <Button onClick={() => props.onClose()}>Done</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
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
            On the other machine, turn on Machine sync and choose{" "}
            <span className="font-medium">Generate pairing code</span>. Paste the code here along
            with a URL this machine can reach it at.
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
            <span className="text-xs font-medium text-muted-foreground">Pairing code</span>
            <Input
              value={pairingCredential}
              onChange={(event) => setPairingCredential(event.target.value)}
              placeholder="Paste the code from the other machine"
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
