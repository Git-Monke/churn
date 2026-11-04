import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CopyIcon,
  KeyRoundIcon,
  Loader2Icon,
  Trash2Icon,
  UserRoundPlusIcon,
} from "lucide-react";
import { toast } from "sonner";

import {
  createProfile,
  deleteProfile,
  fetchManagedProfiles,
  resetProfilePin,
} from "@/api/client";
import type { ManagedProfile } from "@/api/types";
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

const PROFILES_QUERY_KEY = ["managed-profiles"] as const;

export function PeoplePage() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ManagedProfile | null>(null);

  const profilesQuery = useQuery({
    queryKey: PROFILES_QUERY_KEY,
    queryFn: fetchManagedProfiles,
    retry: false,
  });

  const createMutation = useMutation({
    mutationFn: createProfile,
    onSuccess: (data) => {
      setName("");
      toast.success(`Added ${data.profile.name}`, {
        description: `PIN: ${data.pin}. Give it to ${data.profile.name} for their first sign-in.`,
      });
      void queryClient.invalidateQueries({ queryKey: PROFILES_QUERY_KEY });
    },
    onError: (error) => {
      toast.error("Could not add that person", { description: error.message });
    },
  });

  const resetMutation = useMutation({
    mutationFn: resetProfilePin,
    onSuccess: (data) => {
      toast.success(`New PIN for ${data.profile.name}`, {
        description: `PIN: ${data.pin}. Existing sessions for that person were signed out.`,
      });
      void queryClient.invalidateQueries({ queryKey: PROFILES_QUERY_KEY });
    },
    onError: (error) => {
      toast.error("Could not reset that PIN", { description: error.message });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (profile: ManagedProfile) => deleteProfile(profile.id),
    onSuccess: (_data, profile) => {
      toast.success(`Deleted ${profile.name}`, {
        description: "The Jellyfin account and its watch history were removed.",
      });
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: PROFILES_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: ["auth-profiles"] });
    },
    onError: (error) => {
      toast.error("Could not delete that person", { description: error.message });
    },
  });

  function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }
    createMutation.mutate(trimmed);
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>People</CardTitle>
          <CardDescription>
            Each person gets their own Jellyfin account, so watch progress stays
            separate. Give the PIN to the person; they will set their own password
            on first sign-in.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={onCreate}>
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="person-name">Name</Label>
              <Input
                id="person-name"
                name="name"
                placeholder="Jacob"
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={createMutation.isPending}
              />
            </div>
            <Button type="submit" disabled={createMutation.isPending || !name.trim()}>
              {createMutation.isPending ? (
                <Loader2Icon data-icon="inline-start" className="animate-spin" />
              ) : (
                <UserRoundPlusIcon data-icon="inline-start" />
              )}
              Add person
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Household</CardTitle>
          <CardDescription>
            PINs stay visible here until that person sets their own password.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {profilesQuery.isLoading ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-16 rounded-xl" />
              <Skeleton className="h-16 rounded-xl" />
            </div>
          ) : profilesQuery.isError ? (
            <p className="text-sm text-destructive">Could not load people.</p>
          ) : profilesQuery.data && profilesQuery.data.length > 0 ? (
            <ul className="flex flex-col divide-y">
              {profilesQuery.data.map((profile) => (
                <PersonRow
                  key={profile.id}
                  profile={profile}
                  resetting={
                    resetMutation.isPending && resetMutation.variables === profile.id
                  }
                  onReset={() => resetMutation.mutate(profile.id)}
                  onDelete={() => setDeleteTarget(profile)}
                />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              No people yet. Add the first person above.
            </p>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleteMutation.isPending) {
            setDeleteTarget(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {deleteTarget?.name}?</DialogTitle>
            <DialogDescription>
              This deletes their Jellyfin account, including its watch history and
              playlists, and signs out their active sessions. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={deleteMutation.isPending}>
                Keep person
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() =>
                deleteTarget ? deleteMutation.mutate(deleteTarget) : undefined
              }
            >
              {deleteMutation.isPending ? (
                <Loader2Icon data-icon="inline-start" className="animate-spin" />
              ) : (
                <Trash2Icon data-icon="inline-start" />
              )}
              Delete person
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PersonRow({
  profile,
  resetting,
  onReset,
  onDelete,
}: {
  profile: ManagedProfile;
  resetting: boolean;
  onReset: () => void;
  onDelete: () => void;
}) {
  async function copyPin() {
    if (!profile.initialPin) {
      return;
    }
    try {
      await navigator.clipboard.writeText(profile.initialPin);
      toast.success("PIN copied");
    } catch {
      toast.error("Could not copy the PIN");
    }
  }

  return (
    <li className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{profile.name}</span>
          {profile.initialPin ? (
            <span className="mt-1 font-mono text-sm tracking-widest text-muted-foreground">
              {profile.initialPin}
              <button
                type="button"
                onClick={() => void copyPin()}
                aria-label={`Copy PIN for ${profile.name}`}
                className="ml-2 inline-flex align-middle text-muted-foreground transition-colors hover:text-foreground"
              >
                <CopyIcon className="size-4" />
              </button>
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">Password set</span>
          )}
        </div>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onReset}
          disabled={resetting}
          className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors hover:bg-accent disabled:opacity-50"
        >
          {resetting ? (
            <Loader2Icon className="size-4 animate-spin" />
          ) : (
            <KeyRoundIcon className="size-4" />
          )}
          Reset PIN
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm text-destructive transition-colors hover:bg-destructive/10"
        >
          <Trash2Icon className="size-4" />
          Delete
        </button>
      </div>
    </li>
  );
}

