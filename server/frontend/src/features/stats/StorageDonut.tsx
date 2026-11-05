import type { StatsDiskUsage } from "@/api/types";
import { formatBytes } from "@/lib/format";

const RADIUS = 48;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function StorageDonut({ disk }: { disk: StatsDiskUsage }) {
  const usedFraction =
    disk.totalBytes > 0
      ? Math.min(1, Math.max(0, disk.usedBytes / disk.totalBytes))
      : 0;
  const highUsage = disk.usedPercent >= 85;
  const label = `Storage ${formatPercent(disk.usedPercent)}% used: ${formatBytes(
    disk.usedBytes,
  )} used of ${formatBytes(disk.totalBytes)}, ${formatBytes(disk.freeBytes)} free`;

  return (
    <div className="relative size-40 shrink-0" role="img" aria-label={label}>
      <svg viewBox="0 0 120 120" className="size-full -rotate-90">
        <circle
          cx="60"
          cy="60"
          r={RADIUS}
          fill="none"
          stroke="var(--muted)"
          strokeWidth="14"
        />
        <circle
          cx="60"
          cy="60"
          r={RADIUS}
          fill="none"
          stroke={highUsage ? "var(--destructive)" : "var(--primary)"}
          strokeWidth="14"
          strokeDasharray={`${usedFraction * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-heading text-3xl font-semibold">
          {formatPercent(disk.usedPercent)}%
        </span>
        <span className="text-xs text-muted-foreground">used</span>
      </div>
    </div>
  );
}

function formatPercent(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
