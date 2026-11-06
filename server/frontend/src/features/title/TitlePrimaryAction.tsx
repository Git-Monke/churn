import { PlayIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  DownloadStats,
  type DownloadStatsSource,
} from "@/features/download/DownloadStats";

/**
 * The one primary affordance a title page has. Pages decide which variant
 * applies; this only renders it.
 */
export type TitleAction =
  /** Play, resume or rewatch: a link into the player. */
  | { kind: "play"; href: string; label: string; detail?: string }
  /** Nothing playable and nothing downloading. */
  | { kind: "not-downloaded" }
  /** A download is in flight or has just been grabbed. */
  | {
      kind: "downloading";
      eta?: string;
      progress: number;
      /** Live qBittorrent figures; absent for the first seconds after a grab. */
      download?: DownloadStatsSource;
    };

export function TitlePrimaryAction({ action }: { action: TitleAction }) {
  if (action.kind === "play") {
    return (
      <Button asChild className="h-12 gap-3 px-5 text-base">
        <a href={action.href}>
          <PlayIcon data-icon="inline-start" className="size-4" fill="currentColor" />
          {action.label}
          {action.detail ? (
            <span className="text-sm opacity-75">{action.detail}</span>
          ) : null}
        </a>
      </Button>
    );
  }

  if (action.kind === "downloading") {
    return (
      <div className="flex w-full max-w-md min-w-44 flex-col gap-2 border border-border px-4 py-2.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <span className="text-sm font-medium text-foreground">Downloading</span>
          {action.eta ? (
            <span className="text-xs text-muted-foreground tabular-nums">
              {action.eta}
            </span>
          ) : null}
        </div>
        <Progress
          value={action.progress}
          className="h-1.5 w-full"
          aria-label="Download progress"
        />
        {action.download ? (
          <DownloadStats
            download={action.download}
            percent={action.progress}
            showEta={false}
            compact
          />
        ) : null}
      </div>
    );
  }

  return (
    <span className="inline-flex min-h-12 items-center gap-2.5 border border-primary/45 px-4 text-sm font-medium text-foreground">
      <span aria-hidden="true" className="size-2 rounded-full bg-primary" />
      Not downloaded yet
    </span>
  );
}
