import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2Icon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";

import { cancelEpisodeDownload } from "@/api/client";
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

interface CancelEpisodeDownloadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  seriesId: number;
  seasonNumber: number;
  episodeNumber: number;
  episodeTitle: string;
  seasonPack: boolean;
}

export function CancelEpisodeDownloadDialog({
  open,
  onOpenChange,
  seriesId,
  seasonNumber,
  episodeNumber,
  episodeTitle,
  seasonPack,
}: CancelEpisodeDownloadDialogProps) {
  const queryClient = useQueryClient();

  const cancelMutation = useMutation({
    mutationFn: () => cancelEpisodeDownload(seriesId, seasonNumber, episodeNumber),
    onSuccess: (data) => {
      toast.success(`Cancelled ${episodeTitle}`, {
        description:
          data.queueRemoved > 0
            ? `Removed ${data.queueRemoved} queue ${data.queueRemoved === 1 ? "item" : "items"} and blocklisted the release.`
            : (data.downloadClientRemoved ?? 0) > 0
              ? `Removed ${data.downloadClientRemoved} qBittorrent ${
                  data.downloadClientRemoved === 1 ? "torrent" : "torrents"
                }.`
              : "The download was already gone.",
      });
      void queryClient.invalidateQueries({ queryKey: ["show"] });
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
          <DialogTitle>Cancel this episode download?</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{episodeTitle}</span> stops
            downloading and is removed from the download client. If Sonarr is tracking it,
            Sonarr blocklists the release so it is not grabbed again; files that already
            finished importing are kept.
            {seasonPack
              ? " This is a season pack, so cancelling it stops the download for every episode it covers."
              : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={cancelMutation.isPending}>
              Keep downloading
            </Button>
          </DialogClose>
          <Button
            variant="destructive"
            disabled={cancelMutation.isPending}
            onClick={() => cancelMutation.mutate()}
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
