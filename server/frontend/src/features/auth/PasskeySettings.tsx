import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { fetchPasskeys, removePasskey } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

import { passkeyErrorMessage } from "./passkeys";

const QUERY_KEY = ["passkeys"];

export function PasskeySettings({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const saved = useQuery({ queryKey: QUERY_KEY, queryFn: fetchPasskeys, retry: false });
  const [removing, setRemoving] = useState<string>();
  const [error, setError] = useState<string>();

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
    <Dialog open onOpenChange={(open) => { if (!open && !removing) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto" showCloseButton={!removing}>
        <DialogHeader>
          <DialogTitle>Passkeys</DialogTitle>
          <DialogDescription>
            Each passkey signs in as the person who set it up. Add another from the sign-in screen.
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
                <Button type="button" size="sm" variant="outline" disabled={!!removing}
                  aria-label={`Remove ${key.label}`} onClick={() => void remove(key.id)}>
                  {removing === key.id ? "Removing…" : "Remove"}
                </Button>
              </li>
            ))}
          </ul>
        ) : saved.data ? (
          <p className="text-sm text-muted-foreground">
            No passkeys yet. Add one from the sign-in screen.
          </p>
        ) : null}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  );
}
