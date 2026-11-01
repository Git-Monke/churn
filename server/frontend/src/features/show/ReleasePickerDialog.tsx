import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ReleasePicker } from "@/features/show/ReleasePicker";

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
  if (seriesId === undefined || seasonNumber === undefined) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Choose a release</DialogTitle>
          <DialogDescription>
            {showTitle ? `${showTitle} · ` : ""}
            Pick a release to start the download right away. Sonarr's automatic search may still be
            running in the background.
          </DialogDescription>
        </DialogHeader>
        <ReleasePicker
          seriesId={seriesId}
          seasonNumber={seasonNumber}
          episodeNumber={episodeNumber}
          onGrabbed={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
