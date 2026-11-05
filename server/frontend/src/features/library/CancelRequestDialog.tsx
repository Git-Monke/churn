import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2Icon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";

import { cancelLibraryItem } from "@/api/client";
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

export interface CancelRequestTarget {
  service: "sonarr" | "radarr";
  id: number;
}

interface CancelRequestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: CancelRequestTarget;
  title: string;
  /** Called after the arr delete succeeds, so callers can drop stale state. */
  onCancelled?: () => void;
}

/**
 * Removes a request from Sonarr/Radarr along with its queue entries and files.
 * Browse view cancellation: picking a version is the happy path, this is the
 * "I changed my mind" exit.
 */
export function CancelRequestDialog({
  open,
  onOpenChange,
  target,
  title,
  onCancelled,
}: CancelRequestDialogProps) {
  const queryClient = useQueryClient();
  const serviceName = target.service === "sonarr" ? "Sonarr" : "Radarr";

  const cancelMutation = useMutation({
    mutationFn: () => cancelLibraryItem(target.service, target.id),
    onSuccess: (data) => {
      const queueDetail =
        data.queueRemoved > 0
          ? ` Removed ${data.queueRemoved} queue ${data.queueRemoved === 1 ? "item" : "items"}.`
          : "";
      toast.success(`Cancelled ${title}`, {
        description: `${serviceName} removed the request and its files.${queueDetail}`,
      });
      for (const key of [
        "requested-library",
        "activity",
        "library",
        "search",
        "show",
        "movie",
        "movie-releases",
        "status",
      ]) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
      onCancelled?.();
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error("Could not cancel that request", { description: error.message });
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!cancelMutation.isPending) {
          onOpenChange(next);
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel this request?</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{title}</span> is removed
            from {serviceName}. Its download stops, queued items are cleared, and any
            downloaded files are deleted. You can request it again later.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={cancelMutation.isPending}>
              Keep it
            </Button>
          </DialogClose>
          <Button
            variant="destructive"
            onClick={() => cancelMutation.mutate()}
            disabled={cancelMutation.isPending}
          >
            {cancelMutation.isPending ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : (
              <Trash2Icon data-icon="inline-start" />
            )}
            {cancelMutation.isPending ? "Cancelling…" : "Cancel request"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
