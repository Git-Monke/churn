import { useState } from "react";
import type { ShowDownload } from "@/api/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { VersionPicker } from "@/features/releases/VersionPicker";

interface ReleasePickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  seriesId?: number;
  seasonNumber?: number;
  episodeNumber?: number;
  showTitle?: string;
  download?: ShowDownload;
  ready?: boolean;
  onGrabbed?: () => void;
}

/**
 * Per-episode variant of the release picker, used when picking episodes one at
 * a time instead of grabbing the whole season at once.
 */
export function ReleasePickerDialog({
  open,
  onOpenChange,
  seriesId,
  seasonNumber,
  episodeNumber,
  showTitle,
  download,
  ready,
  onGrabbed,
}: ReleasePickerDialogProps) {
  const [requested, setRequested] = useState(false);
  if (seriesId === undefined || seasonNumber === undefined || episodeNumber === undefined) {
    return null;
  }

  const episodeLabel = `S${String(seasonNumber).padStart(2, "0")}E${String(episodeNumber).padStart(2, "0")}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Download one episode</DialogTitle>
          <DialogDescription>
            {showTitle ? `${showTitle} · ` : ""}
            {episodeLabel} only. Every indexer is searched for this episode.
          </DialogDescription>
        </DialogHeader>
        <VersionPicker
          scope="season"
          seriesId={seriesId}
          seasonNumber={seasonNumber}
          episodeNumber={episodeNumber}
          primaryLabel="Download episode"
          downloadStatus={requested ? {
            kind: "downloading",
            progress: download?.progress ?? 0,
            ready,
            status: download?.status ?? "queued",
          } : undefined}
          onGrabbed={() => {
            setRequested(true);
            onGrabbed?.();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
