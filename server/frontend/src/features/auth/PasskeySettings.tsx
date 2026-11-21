import { useState, type FormEvent } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FingerprintIcon } from "lucide-react";

import {
  beginPasskeyRegistration,
  cancelPasskeyRegistration,
  fetchPasskeys,
  finishPasskeyRegistration,
  removePasskey,
} from "@/api/client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { canUsePasskeys, passkeyErrorMessage } from "./passkeys";

const QUERY_KEY = ["passkeys"];

export function PasskeySettings({
  onClose,
  initialPassword,
}: {
  onClose: () => void;
  initialPassword?: string;
}) {
  const queryClient = useQueryClient();
  const saved = useQuery({ queryKey: QUERY_KEY, queryFn: fetchPasskeys, retry: false });
  const [label, setLabel] = useState("");
  const [password, setPassword] = useState(initialPassword ?? "");
  const [pending, setPending] = useState(false);
  const [removing, setRemoving] = useState<string>();
  const [error, setError] = useState<string>();
  const busy = pending || !!removing;

  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    setPending(true);
    let started = false;
    try {
      const optionsJSON = await beginPasskeyRegistration(label, password);
      started = true;
      setPassword("");
      const credential = await startRegistration({ optionsJSON });
      await finishPasskeyRegistration(credential);
      setLabel("");
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    } catch (caught) {
      if (started) await cancelPasskeyRegistration().catch(() => undefined);
      setError(passkeyErrorMessage(caught, "Could not add the passkey."));
    } finally {
      setPassword("");
      setPending(false);
    }
  }

  async function remove(id: string) {
    setError(undefined);
    setRemoving(id);
    try {
      await removePasskey(id);
      await queryClient.invalidateQueries({ queryKey: ["auth-session"] });
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    } catch (caught) {
      setError(passkeyErrorMessage(caught, "Could not remove the passkey."));
    } finally {
      setRemoving(undefined);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Passkeys</DialogTitle>
          <DialogDescription>
            Sign in to Churn with your fingerprint, face, or device PIN.
          </DialogDescription>
        </DialogHeader>
        {saved.isLoading && <p role="status" className="text-sm">Loading passkeys…</p>}
        {saved.isError && <p role="alert" className="text-sm text-destructive">Could not load passkeys.</p>}
        {saved.data?.length ? (
          <ul className="divide-y border-y">
            {saved.data.map((key) => (
              <li key={key.id} className="flex min-w-0 items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{key.label}</p>
                  <p className="text-xs text-muted-foreground">
                    Added {new Date(key.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <Button type="button" size="sm" variant="outline" disabled={busy}
                  aria-label={`Remove ${key.label}`} onClick={() => void remove(key.id)}>
                  {removing === key.id ? "Removing…" : "Remove"}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {canUsePasskeys() ? (
          <form className="grid gap-3" onSubmit={(event) => void register(event)}>
            <div className="grid gap-1.5">
              <Label htmlFor="passkey-name">Passkey name</Label>
              <Input id="passkey-name" placeholder="e.g. iCloud Keychain" required maxLength={50}
                value={label} onChange={(event) => setLabel(event.target.value)} disabled={busy} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="passkey-password">Jellyfin password</Label>
              <Input id="passkey-password" type="password" autoComplete="current-password" required maxLength={1024}
                value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} />
            </div>
            <Button type="submit" disabled={busy || !label.trim() || !password}>
              <FingerprintIcon data-icon="inline-start" />
              {pending ? "Adding passkey…" : "Add passkey"}
            </Button>
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">This browser can manage your passkeys. Use a browser with passkey support to add one.</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
