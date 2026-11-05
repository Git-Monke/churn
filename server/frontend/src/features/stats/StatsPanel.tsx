import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownIcon, ArrowUpIcon, CircleAlertIcon } from "lucide-react";

import { fetchStats } from "@/api/client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StorageDonut } from "@/features/stats/StorageDonut";
import { formatBytes } from "@/lib/format";

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
        <SectionHeading />
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-32 rounded-xl" />
          <Skeleton className="h-32 rounded-xl" />
        </div>
        <Skeleton className="h-64 rounded-xl" />
      </section>
    );
  }

  if (query.isError && !query.data) {
    return (
      <section className="flex flex-col gap-4">
        <SectionHeading />
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Could not load stats</AlertTitle>
          <AlertDescription>{query.error.message}</AlertDescription>
        </Alert>
      </section>
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
      <SectionHeading />

      {messages.length > 0 ? (
        <Alert>
          <CircleAlertIcon />
          <AlertTitle>Some stats are unavailable</AlertTitle>
          <AlertDescription>{messages.join(" ")}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <MetricCard
          icon={<ArrowDownIcon className="size-5" />}
          label="Downloaded"
          value={
            qbittorrent ? formatBytes(qbittorrent.totalDownloadedBytes) : "Unavailable"
          }
          detail="All time · qBittorrent"
        />
        <MetricCard
          icon={<ArrowUpIcon className="size-5" />}
          label="Uploaded"
          value={qbittorrent ? formatBytes(qbittorrent.totalUploadedBytes) : "Unavailable"}
          detail="All time · qBittorrent"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Storage</CardTitle>
          <CardDescription>Space on the downloads and media volume</CardDescription>
        </CardHeader>
        <CardContent>
          {disk ? (
            <div className="flex flex-col items-center gap-8 sm:flex-row">
              <StorageDonut disk={disk} />
              <dl className="grid w-full grid-cols-3 gap-4">
                <StorageFigure label="Used" value={formatBytes(disk.usedBytes)} />
                <StorageFigure label="Free" value={formatBytes(disk.freeBytes)} />
                <StorageFigure label="Total" value={formatBytes(disk.totalBytes)} />
              </dl>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Disk usage is unavailable right now.
            </p>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function SectionHeading() {
  return (
    <div className="flex flex-col gap-1">
      <h2 className="font-heading text-xl font-semibold">Usage</h2>
      <p className="text-sm text-muted-foreground">
        qBittorrent transfer totals and storage on the media volume
      </p>
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
  detail,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <Card size="sm">
      <CardContent className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
            {label}
          </span>
          <span className="font-heading text-2xl font-semibold">{value}</span>
          <span className="text-xs text-muted-foreground">{detail}</span>
        </div>
        <div className="rounded-lg bg-muted p-3 text-muted-foreground">{icon}</div>
      </CardContent>
    </Card>
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
