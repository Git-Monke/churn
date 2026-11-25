import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { useDiskShareSummary } from "@/features/disk-share/use-disk-share";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Compact storage-share reading in the header, absent when no limit applies. */
export function ShareMeter() {
  const query = useDiskShareSummary();
  const summary = query.data;
  if (!summary || !summary.enabled || summary.state !== "ok" || summary.limitBytes === null) {
    return null;
  }

  const used = formatBytes(summary.usedBytes);
  const limit = formatBytes(summary.limitBytes);
  const usedPercent = Math.min(100, Math.max(0, summary.usedPercent ?? 0));

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Storage share: ${used} of ${limit} used`}
          className="flex w-52 flex-col gap-1.5 rounded-md px-1.5 py-1.5 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <span className="flex items-baseline justify-between gap-2 text-xs tabular-nums">
            <span className="whitespace-nowrap text-muted-foreground">
              {used} / {limit}
            </span>
            {summary.nearLimit ? (
              <span className="whitespace-nowrap text-destructive">Running low</span>
            ) : null}
          </span>
          <Progress
            value={usedPercent}
            className={cn(
              "h-0.5",
              summary.nearLimit && "[&_[data-slot=progress-indicator]]:bg-destructive",
            )}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end">
        <PopoverHeader>
          <PopoverTitle>Storage share</PopoverTitle>
          <PopoverDescription>
            {used} of {limit} used
          </PopoverDescription>
        </PopoverHeader>
        <dl className="flex flex-col gap-1 text-sm">
          <ShareRow label="Library" bytes={summary.libraryBytes} />
          <ShareRow label="Downloading" bytes={summary.downloadBytes} />
          <ShareRow label="Free" bytes={summary.remainingBytes ?? 0} />
        </dl>
        {summary.nearLimit ? (
          <p className="text-sm text-destructive">
            You're close to your limit. Remove something you've finished with to
            free space.
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function ShareRow({ label, bytes }: { label: string; bytes: number }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{formatBytes(bytes)}</dd>
    </div>
  );
}