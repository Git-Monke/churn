import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2Icon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";

import { cancelMovieDownload } from "@/api/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface CancelMovieDownloadProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: "jellyfin" | "radarr";
  id: string;
  title: string;
}

export function CancelMovieDownloadDialog({
  open,
  onOpenChange,
  source,
  id,
  title,
}: CancelMovieDownloadProps) {
  const queryClient = useQueryClient();

  const cancelMutation = useMutation({
    mutationFn: () => cancelMovieDownload(source, id),
    onSuccess: (data) => {
      toast.success(`Cancelled ${title}`, {
        description:
          data.queueRemoved > 0
            ? `Removed ${data.queueRemoved} queue ${data.queueRemoved === 1 ? "item" : "items"} and blocklisted the release.`
            : `Removed ${data.downloadClientRemoved ?? 0} qBittorrent ${
                data.downloadClientRemoved === 1 ? "torrent" : "torrents"
              }.`,
      });
      void queryClient.invalidateQueries({ queryKey: ["movie"] });
      void queryClient.invalidateQueries({ queryKey: ["movie-releases"] });
      void queryClient.invalidateQueries({ queryKey: ["activity"] });
      void queryClient.invalidateQueries({ queryKey: ["requested-library"] });
      void queryClient.invalidateQueries({ queryKey: ["search"] });
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error("Could not cancel that download", { description: error.message });
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
          <DialogTitle>Cancel this movie download?</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{title}</span> stops downloading
            and is removed from the download client. If Radarr is tracking it, Radarr
            blocklists the download so it is not grabbed again. Any file that already
            finished importing is kept.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={cancelMutation.isPending}
          >
            Keep downloading
          </Button>
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
            {cancelMutation.isPending ? "Cancelling…" : "Cancel download"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
