import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2Icon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";

import { cancelJellyfinLibraryItem, cancelLibraryItem } from "@/api/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface DeleteTitleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Jellyfin item id when the title is playable from Jellyfin. */
  jellyfinId?: string;
  /** Sonarr/Radarr entry for titles that only exist as a request. */
  arrService?: "sonarr" | "radarr";
  arrId?: number;
  /** Called after a successful delete, e.g. to leave the page. */
  onDeleted?: () => void;
}

/**
 * "Delete from library": removes the title from Jellyfin (and the matching
 * Sonarr/Radarr entry plus its files), or removes the arr request when nothing
 * was downloaded yet.
 */
export function DeleteTitleDialog({
  open,
  onOpenChange,
  title,
  jellyfinId,
  arrService,
  arrId,
  onDeleted,
}: DeleteTitleDialogProps) {
  const queryClient = useQueryClient();

  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (jellyfinId !== undefined) {
        await cancelJellyfinLibraryItem(jellyfinId);
        return;
      }
      if (arrService !== undefined && arrId !== undefined) {
        await cancelLibraryItem(arrService, arrId);
        return;
      }
      throw new Error("Nothing to delete for this title");
    },
    onSuccess: () => {
      toast.success(`Deleted ${title}`, {
        description: "Its files and download queue entries were removed.",
      });
      for (const key of [
        "library",
        "requested-library",
        "activity",
        "movie",
        "show",
        "search",
        "status",
      ]) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
      onOpenChange(false);
      onDeleted?.();
    },
    onError: (error) => {
      toast.error("Could not delete that title", { description: error.message });
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!deleteMutation.isPending) {
          onOpenChange(next);
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete this title from the library?</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{title}</span> is removed
            from the library. Its files, queued downloads and request are deleted.
            You can request it again later.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={deleteMutation.isPending}>
              Keep it
            </Button>
          </DialogClose>
          <Button
            variant="destructive"
            onClick={() => deleteMutation.mutate()}
            disabled={deleteMutation.isPending}
          >
            {deleteMutation.isPending ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : (
              <Trash2Icon data-icon="inline-start" />
            )}
            {deleteMutation.isPending ? "Deleting…" : "Delete from library"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
