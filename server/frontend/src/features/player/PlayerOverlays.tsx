import {
  CircleAlertIcon,
  RotateCcwIcon,
  SkipForwardIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Overlays never cover the native control bar, whose buttons sit in the last
 * 76px of the frame.
 */
const CONTROL_BAR_INSET = "bottom-19";

export function EndedOverlay({
  onWatchAgain,
  backHref,
  backLabel,
}: {
  onWatchAgain: () => void;
  backHref: string;
  backLabel: string;
}) {
  return (
    <div
      className={`pointer-events-none absolute inset-x-0 top-0 ${CONTROL_BAR_INSET} flex items-center justify-center bg-background/75 px-6`}
    >
      <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-2.5">
        <Button type="button" className="h-12 gap-2 px-5" onClick={onWatchAgain}>
          <RotateCcwIcon className="size-4" />
          Watch again
        </Button>
        <Button asChild variant="outline" className="h-12 px-5">
          <a href={backHref}>{backLabel}</a>
        </Button>
      </div>
    </div>
  );
}

export function PlaybackErrorOverlay({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      className={`pointer-events-none absolute inset-x-0 top-0 ${CONTROL_BAR_INSET} flex items-center justify-center bg-background/75 px-6`}
    >
      <div
        role="alert"
        className="pointer-events-auto flex max-w-md flex-col items-center gap-3 text-center"
      >
        <CircleAlertIcon className="size-7 text-destructive" aria-hidden />
        <p className="text-lg font-medium">This video won&apos;t play</p>
        <p className="text-sm text-muted-foreground">
          The file may be damaged or in a format the browser can&apos;t handle.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2.5">
          <Button type="button" className="h-11 px-4" onClick={onRetry}>
            Try again
          </Button>
          <Button asChild variant="outline" className="h-11 px-4">
            <a href="/api/services/jellyfin/open" target="_blank" rel="noreferrer">
              Open Jellyfin
            </a>
          </Button>
        </div>
      </div>
    </div>
  );
}

export function SkipIntroButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="outline"
      className={`absolute right-5 ${CONTROL_BAR_INSET} h-11 px-4 shadow-lg`}
      onClick={onClick}
    >
      <SkipForwardIcon className="size-4" />
      Skip intro
    </Button>
  );
}
