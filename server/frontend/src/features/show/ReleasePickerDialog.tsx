import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ReleaseChooser } from "@/features/releases/ReleaseChooser";

interface ReleasePickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  seriesId?: number;
  seasonNumber?: number;
  episodeNumber?: number;
  showTitle?: string;
}

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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Choose a release</DialogTitle>
          <DialogDescription>
            {showTitle ? `${showTitle} · ` : ""}
            Search every indexer for this episode and pick a release to send straight to
            qBittorrent.
          </DialogDescription>
        </DialogHeader>
        <ReleaseChooser
          kind="series"
          seriesId={seriesId}
          seasonNumber={seasonNumber}
          episodeNumber={episodeNumber}
          title={showTitle}
          onGrabbed={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
