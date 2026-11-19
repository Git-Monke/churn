import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownIcon, ArrowUpIcon, CircleAlertIcon } from "lucide-react";

import { fetchStats } from "@/api/client";
import type { StatsTopItem } from "@/api/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StorageDonut } from "@/features/stats/StorageDonut";
import { formatBytes } from "@/lib/format";

const VISIBLE_ITEMS = 5;

export function StatsPanel() {
  const query = useQuery({
    queryKey: ["stats"],
    queryFn: fetchStats,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  if (query.isLoading && !query.data) {
    return (
      <section className="flex flex-col gap-4">
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-56 rounded-xl" />
      </section>
    );
  }

  if (query.isError && !query.data) {
    return (
      <Alert variant="destructive">
        <CircleAlertIcon />
        <AlertTitle>Could not load stats</AlertTitle>
        <AlertDescription>{query.error.message}</AlertDescription>
      </Alert>
    );
  }

  const stats = query.data;
  const messages = [
    ...(stats?.errors ?? []).map((error) => error.message),
    ...(query.isError ? [query.error.message] : []),
  ];
  const qbittorrent = stats?.qbittorrent;
  const disk = stats?.disk;

  return (
    <section className="flex flex-col gap-4">
      {messages.length > 0 ? (
        <Alert>
          <CircleAlertIcon />
          <AlertTitle>Some stats are unavailable</AlertTitle>
          <AlertDescription>{messages.join(" ")}</AlertDescription>
        </Alert>
      ) : null}

      <Card className="[--card-spacing:--spacing(6)]">
        <CardHeader>
          <CardTitle>Traffic</CardTitle>
          <CardDescription>All time · qBittorrent</CardDescription>
        </CardHeader>
        {qbittorrent ? (
          <CardContent className="grid gap-6 md:grid-cols-2">
            <TransferColumn
              icon={<ArrowDownIcon className="size-4" />}
              label="Downloaded"
              value={formatBytes(qbittorrent.totalDownloadedBytes)}
              items={stats?.topDownloads}
              empty="No download history yet."
            />
            <div className="border-t pt-6 md:border-l md:border-t-0 md:pl-6 md:pt-0">
              <TransferColumn
                icon={<ArrowUpIcon className="size-4" />}
                label="Uploaded"
                value={formatBytes(qbittorrent.totalUploadedBytes)}
                items={stats?.topUploads}
                empty="No upload history yet."
              />
            </div>
          </CardContent>
        ) : (
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Transfer totals are unavailable.
            </p>
          </CardContent>
        )}
      </Card>

      <Card className="[--card-spacing:--spacing(6)]">
        <CardHeader>
          <CardTitle>Storage</CardTitle>
          <CardDescription>Space on the downloads and media volume</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6 sm:flex-row sm:items-center">
          {disk ? (
            <div className="shrink-0 px-4 sm:px-8">
              <StorageDonut disk={disk} />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Disk usage is unavailable right now.
            </p>
          )}
          <div className="flex w-full flex-1 flex-col gap-4">
            {disk ? (
              <dl className="flex gap-10">
                <StorageFigure label="Used" value={formatBytes(disk.usedBytes)} />
                <StorageFigure label="Free" value={formatBytes(disk.freeBytes)} />
              </dl>
            ) : null}
            {stats?.topStorage ? (
              <div className="flex flex-col gap-2 border-t pt-4">
                <h3 className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Largest titles
                </h3>
                <StatsBars
                  items={stats.topStorage}
                  empty="No title sizes reported yet."
                />
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

function TransferColumn({
  icon,
  label,
  value,
  items,
  empty,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  items?: StatsTopItem[];
  empty: string;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
      </div>
      <span className="font-heading text-3xl font-semibold">{value}</span>
      {items ? <StatsBars items={items} empty={empty} /> : null}
    </div>
  );
}

function StatsBars({
  items,
  empty,
  limit = VISIBLE_ITEMS,
}: {
  items: StatsTopItem[];
  empty: string;
  limit?: number;
}) {
  const shown = items.slice(0, limit);
  if (shown.length === 0) {
    return <p className="text-xs text-muted-foreground">{empty}</p>;
  }
  const max = Math.max(...shown.map((item) => item.bytes));
  return (
    <ol className="flex flex-col gap-3">
      {shown.map((item, index) => (
        <li
          key={`${item.kind ?? "torrent"}:${item.name}:${item.detail ?? ""}:${index}`}
          className="grid grid-cols-2 items-center gap-4"
        >
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-sm" title={item.name}>
                {item.name}
              </span>
              {item.detail ? (
                <span
                  className="truncate text-xs text-muted-foreground"
                  title={item.detail}
                >
                  {item.detail}
                </span>
              ) : null}
            </div>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {formatBytes(item.bytes)}
            </span>
          </div>
          <div className="h-2 bg-muted" aria-hidden="true">
            <div
              className="h-full bg-muted-foreground/70"
              style={{ width: `${max > 0 ? (item.bytes / max) * 100 : 0}%` }}
            />
          </div>
        </li>
      ))}
    </ol>
  );
}

function StorageFigure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">{value}</dd>
    </div>
  );
}
