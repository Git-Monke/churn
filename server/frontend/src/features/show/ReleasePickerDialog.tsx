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
}: ReleasePickerDialogProps) {
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
          onGrabbed={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
