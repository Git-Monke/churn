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

export interface CancelTarget {
  service: "sonarr" | "radarr";
  id: number;
}

interface CancelDownloadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: CancelTarget;
  title: string;
}

export function CancelDownloadDialog({
  open,
  onOpenChange,
  target,
  title,
}: CancelDownloadDialogProps) {
  const queryClient = useQueryClient();
  const serviceName = target.service === "sonarr" ? "Sonarr" : "Radarr";

  const cancelMutation = useMutation({
    mutationFn: () => cancelLibraryItem(target.service, target.id),
    onSuccess: (data) => {
      const queueDetail =
        data.queueRemoved > 0
          ? ` Removed ${data.queueRemoved} queue ${data.queueRemoved === 1 ? "item" : "items"}.`
          : "";
      toast.success(`Removed ${title}`, {
        description: `${serviceName} deleted the title and its files.${queueDetail}`,
      });
      void queryClient.invalidateQueries({ queryKey: ["requested-library"] });
      void queryClient.invalidateQueries({ queryKey: ["activity"] });
      void queryClient.invalidateQueries({ queryKey: ["library"] });
      void queryClient.invalidateQueries({ queryKey: ["search"] });
      void queryClient.invalidateQueries({ queryKey: ["show"] });
      void queryClient.invalidateQueries({ queryKey: ["status"] });
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error("Could not cancel that title", { description: error.message });
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
          <DialogTitle>Cancel and remove this title?</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{title}</span> will be removed from{" "}
            {serviceName}. Its download stops and is removed from the download client, and any
            downloaded files are deleted. You can request it again with a smaller quality profile
            afterwards.
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
            {cancelMutation.isPending ? "Removing…" : "Cancel & remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
