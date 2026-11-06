import { formatDownloaded, formatEta, formatSpeed } from "@/lib/format";

export interface DownloadStatsSource {
  sizeBytes?: number;
  sizeLeftBytes?: number;
  downloadSpeedBytes?: number;
  connectedSeeders?: number;
  swarmSeeders?: number;
  timeLeft?: string;
  estimatedCompletionTime?: string;
}

interface StatItem {
  label: string;
  value: string;
}

/**
 * Shared live-torrent stats for movie and episode download cards. Both
 * ActivityItem and ShowDownload are structurally compatible with this shape.
 */
export function DownloadStats({
  download,
  compact = false,
  percent,
  showEta = true,
}: {
  download: DownloadStatsSource;
  compact?: boolean;
  /** Whole-number progress, appended to the transferred size when known. */
  percent?: number;
  /** Callers that print the ETA themselves turn this off. */
  showEta?: boolean;
}) {
  const items: StatItem[] = [];

  if (download.downloadSpeedBytes !== undefined) {
    items.push({ label: "Speed", value: formatSpeed(download.downloadSpeedBytes) });
  }
  const downloaded = formatDownloaded(download.sizeBytes, download.sizeLeftBytes);
  if (downloaded !== undefined) {
    items.push({
      label: "Downloaded",
      value:
        percent === undefined || percent <= 0
          ? downloaded
          : `${downloaded} (${Math.round(percent)}%)`,
    });
  }
  const seeders = seederLabel(download);
  if (seeders !== undefined) {
    items.push({ label: "Seeders", value: seeders });
  }
  if (showEta) {
    items.push({ label: "ETA", value: downloadEta(download) ?? "—" });
  }

  if (compact) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {items.map((item) => (
          <span key={item.label}>
            <span className="text-muted-foreground/70">{item.label} </span>
            <span className="font-medium text-foreground">{item.value}</span>
          </span>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {items.map((item) => (
        <div key={item.label} className="flex flex-col gap-0.5">
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
            {item.label}
          </span>
          <span className="text-sm font-medium">{item.value}</span>
        </div>
      ))}
    </div>
  );
}

function seederLabel(download: DownloadStatsSource): string | undefined {
  const connected = download.connectedSeeders;
  const swarm = download.swarmSeeders;
  if (connected !== undefined && swarm !== undefined) {
    return `${connected} connected · ${swarm} in swarm`;
  }
  if (connected !== undefined) {
    return `${connected} connected`;
  }
  if (swarm !== undefined) {
    return `${swarm} in swarm`;
  }
  return undefined;
}

function downloadEta(download: DownloadStatsSource): string | undefined {
  if (download.timeLeft) {
    return download.timeLeft;
  }
  if (download.estimatedCompletionTime) {
    return formatEta(download.estimatedCompletionTime);
  }
  return undefined;
}
