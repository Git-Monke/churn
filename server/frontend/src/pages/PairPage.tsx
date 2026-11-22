import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, Loader2Icon, TvIcon, XIcon } from "lucide-react";
import { toast } from "sonner";

import {
  ApiClientError,
  approvePairing,
  denyPairing,
  fetchPairedDevices,
  fetchPairingDetails,
  revokePairedDevice,
} from "@/api/client";
import type { PairedDevice } from "@/api/types";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/features/auth/AuthProvider";

const DEVICES_QUERY_KEY = ["paired-devices"] as const;

/**
 * Pair a TV: the TV shows a code (and a QR code that opens this page with it
 * filled in); someone signed in here approves it. Below, every paired device,
 * each of which can be revoked.
 */
export function PairPage({ code }: { code?: string }) {
  return (
    <div className="flex flex-col gap-6">
      {code ? <ApproveCard key={code} code={code} /> : <EnterCodeCard />}
      <DevicesCard />
    </div>
  );
}

function EnterCodeCard() {
  const [value, setValue] = useState("");
  const cleaned = value.toUpperCase().replace(/[^A-Z0-9]/g, "");

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (cleaned.length === 6) {
      window.location.hash = `#/pair?code=${cleaned}`;
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pair a TV</CardTitle>
        <CardDescription>
          Start pairing on the TV, then type the six-character code it shows, or scan its QR
          code with your phone.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={onSubmit}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="pair-code">Code</Label>
            <Input
              id="pair-code"
              name="code"
              inputMode="text"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={9}
              className="w-40 font-mono text-lg tracking-[0.2em] uppercase"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </div>
          <Button type="submit" className="w-fit" disabled={cleaned.length !== 6}>
            Continue
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function ApproveCard({ code }: { code: string }) {
  const queryClient = useQueryClient();
  const [outcome, setOutcome] = useState<"approved" | "denied" | null>(null);
  const detailsQuery = useQuery({
    queryKey: ["pairing", code],
    queryFn: () => fetchPairingDetails(code),
    retry: false,
  });

  const approveMutation = useMutation({
    mutationFn: () => approvePairing(code),
    onSuccess: () => {
      setOutcome("approved");
      void queryClient.invalidateQueries({ queryKey: DEVICES_QUERY_KEY });
    },
    onError: (error) => toast.error("Could not pair that TV", { description: error.message }),
  });
  const denyMutation = useMutation({
    mutationFn: () => denyPairing(code),
    onSuccess: () => setOutcome("denied"),
    onError: (error) => toast.error("Could not refuse that TV", { description: error.message }),
  });
  const busy = approveMutation.isPending || denyMutation.isPending;
  const details = detailsQuery.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pair a TV</CardTitle>
        {details && !outcome ? (
          <CardDescription>
            It will be signed in as you, on its own, until you revoke it below. It can watch
            and request, but can't change settings or people.
          </CardDescription>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {detailsQuery.isLoading ? (
          <Skeleton className="h-16 rounded-xl" />
        ) : !details ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              {detailsQuery.error instanceof ApiClientError && detailsQuery.error.status === 404
                ? `Code ${code} has expired or doesn't exist. Start pairing again on the TV.`
                : "Could not look up that code."}
            </p>
            <Button variant="outline" className="w-fit" asChild>
              <a href="#/pair">Enter another code</a>
            </Button>
          </div>
        ) : outcome === "approved" ? (
          <p className="flex items-center gap-2 text-sm">
            <CheckIcon className="size-4 text-primary" />
            Paired. {details.deviceName} signs in on its own in a few seconds.
          </p>
        ) : outcome === "denied" ? (
          <p className="text-sm text-muted-foreground">Refused. {details.deviceName} wasn't paired.</p>
        ) : details.status !== "pending" ? (
          <p className="text-sm text-muted-foreground">This code has already been used.</p>
        ) : (
          <>
            <div className="flex items-center gap-4">
              <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-muted">
                <TvIcon className="size-6" />
              </span>
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-base font-medium">{details.deviceName}</span>
                <span className="font-mono text-sm tracking-[0.2em] text-muted-foreground">{details.code}</span>
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              Check that the TV shows this code before you pair it.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy} onClick={() => approveMutation.mutate()}>
                {approveMutation.isPending ? (
                  <Loader2Icon data-icon="inline-start" className="animate-spin" />
                ) : (
                  <CheckIcon data-icon="inline-start" />
                )}
                Pair this TV
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => denyMutation.mutate()}>
                <XIcon data-icon="inline-start" />
                Don't pair
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function DevicesCard() {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const isAdmin = session?.user?.isAdmin === true;
  const [revokeTarget, setRevokeTarget] = useState<PairedDevice | null>(null);
  const devicesQuery = useQuery({ queryKey: DEVICES_QUERY_KEY, queryFn: fetchPairedDevices, retry: false });
  const revokeMutation = useMutation({
    mutationFn: (device: PairedDevice) => revokePairedDevice(device.id),
    onSuccess: (_data, device) => {
      toast.success(`Revoked ${device.name}`, { description: "It has to be paired again to sign in." });
      setRevokeTarget(null);
      void queryClient.invalidateQueries({ queryKey: DEVICES_QUERY_KEY });
    },
    onError: (error) => toast.error("Could not revoke that device", { description: error.message }),
  });
  const devices = devicesQuery.data?.devices ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Paired devices</CardTitle>
        <CardDescription>
          {isAdmin ? "Every paired TV in the household." : "TVs paired as you."} A TV stays signed in
          while it's used at least every six months.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {devicesQuery.isLoading ? (
          <Skeleton className="h-16 rounded-xl" />
        ) : devicesQuery.isError ? (
          <p className="text-sm text-destructive">Could not load paired devices.</p>
        ) : devices.length === 0 ? (
          <p className="text-sm text-muted-foreground">No paired devices yet.</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {devices.map((device) => (
              <li key={device.id} className="flex items-center justify-between gap-4 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <TvIcon className="size-5 shrink-0 text-muted-foreground" />
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">{device.name}</span>
                    <span className="text-sm text-muted-foreground">
                      {isAdmin ? `${device.user.name} · ` : ""}Paired {formatDate(device.pairedAt)} · Last used{" "}
                      {formatDate(device.lastSeenAt)}
                    </span>
                  </div>
                </div>
                <Button variant="outline" size="sm" onClick={() => setRevokeTarget(device)}>
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <Dialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open && !revokeMutation.isPending) setRevokeTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke {revokeTarget?.name}?</DialogTitle>
            <DialogDescription>
              It's signed out right away and has to be paired again to use churn.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={revokeMutation.isPending}>
                Keep it
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              disabled={revokeMutation.isPending}
              onClick={() => revokeTarget && revokeMutation.mutate(revokeTarget)}
            >
              Revoke
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(date);
}
