import { useQuery } from "@tanstack/react-query";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleXIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
} from "lucide-react";

import { fetchVpnStatus } from "@/api/client";
import type { VpnCheck, VpnStatusResponse } from "@/api/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";

export function VpnStatusPanel() {
  const query = useQuery({
    queryKey: ["vpn"],
    queryFn: fetchVpnStatus,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  if (query.isLoading && !query.data) {
    return (
      <section className="flex flex-col gap-3">
        <SectionHeading
          title="VPN"
          description="Live proof that qBittorrent traffic is still confined to Mullvad"
        />
        <Skeleton className="h-40 rounded-xl" />
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-64 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
      </section>
    );
  }

  if (query.isError && !query.data) {
    return (
      <section className="flex flex-col gap-3">
        <SectionHeading
          title="VPN"
          description="Live proof that qBittorrent traffic is still confined to Mullvad"
        />
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Could not reach the VPN status agent</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-3">
            <p>{query.error.message}</p>
            <p>
              The check runs inside the torrent stack. Start its agent and try again:
            </p>
            <code className="rounded-md bg-muted px-2 py-1 font-mono text-xs">
              cd torrent && docker compose up -d vpn-status
            </code>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void query.refetch()}
              disabled={query.isFetching}
            >
              <RefreshCwIcon
                data-icon="inline-start"
                className={query.isFetching ? "animate-spin" : undefined}
              />
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      </section>
    );
  }

  const data = query.data;
  if (!data) {
    return null;
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <SectionHeading
          title="VPN"
          description="Live proof that qBittorrent traffic is still confined to Mullvad"
        />
        <Button
          variant="outline"
          size="sm"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
        >
          <RefreshCwIcon
            data-icon="inline-start"
            className={query.isFetching ? "animate-spin" : undefined}
          />
          {query.isFetching ? "Testing…" : "Run test again"}
        </Button>
      </div>

      {query.isError ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Could not refresh the VPN test</AlertTitle>
          <AlertDescription>
            Showing the last successful result from {formatCheckedAt(data.checkedAt)}.{" "}
            {query.error.message}
          </AlertDescription>
        </Alert>
      ) : null}

      {data.secure ? <ProtectedBanner data={data} /> : <LeakBanner data={data} />}
      {data.secure ? <CoverageWarning data={data} /> : null}

      <DataPoints data={data} />

      <Card>
        <CardHeader>
          <CardTitle>Boundary checks</CardTitle>
          <CardDescription>
            Every check runs inside the same network namespace as qBittorrent.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {data.checks.map((check) => (
            <CheckRow key={check.id} check={check} />
          ))}
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="font-heading text-base font-semibold">Container coverage</h3>
          <p className="text-sm text-muted-foreground">
            These loopback services answered from the protected namespace.
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {data.coverage.map((entry) => (
            <Card key={entry.id} size="sm">
              <CardContent className="flex items-center gap-3">
                <span
                  className={
                    entry.reachable
                      ? "size-2.5 shrink-0 rounded-full bg-emerald-500"
                      : "size-2.5 shrink-0 rounded-full bg-muted-foreground/40"
                  }
                />
                <div className="flex flex-col">
                  <span className="font-medium">{entry.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {entry.reachable ? "Shares the protected namespace" : "Not running"}
                  </span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Checked {formatCheckedAt(data.checkedAt)} · took {formatDuration(data.durationMs)}
      </p>
    </section>
  );
}

function ProtectedBanner({ data }: { data: VpnStatusResponse }) {
  return (
    <Card className="bg-emerald-500/5 ring-emerald-500/30">
      <CardContent className="flex items-start gap-3">
        <span className="rounded-full bg-emerald-500/15 p-2 text-emerald-500">
          <ShieldCheckIcon className="size-6" />
        </span>
        <div className="flex flex-col gap-1">
          <p className="font-heading text-lg font-semibold">
            Your torrents are protected by Mullvad
          </p>
          <p className="text-sm text-muted-foreground">
            All boundary checks passed. No direct route, DNS resolver or IPv6 path
            was found outside the tunnel.
          </p>
          <p className="text-xs text-muted-foreground">
            Public exit {data.exit.ip ?? "unknown"}
            {formatLocation(data.exit) ? ` · ${formatLocation(data.exit)}` : ""}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function CoverageWarning({ data }: { data: VpnStatusResponse }) {
  const unreachable = data.coverage.filter((entry) => !entry.reachable);
  if (unreachable.length === 0) {
    return null;
  }
  return (
    <Alert>
      <CircleAlertIcon />
      <AlertTitle>VPN is secure, but the torrent apps are not reachable</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        <p>
          The tunnel is healthy, but {unreachable.map((entry) => entry.name).join(", ")}{" "}
          did not answer inside the protected namespace. They may be stopped or
          stuck in an older network namespace.
        </p>
        <p>
          Recreate the whole torrent stack so every app joins Gluetun&apos;s current
          namespace:
        </p>
        <code className="rounded-md bg-muted px-2 py-1 font-mono text-xs">
          cd torrent && docker compose down && docker compose up -d
        </code>
      </AlertDescription>
    </Alert>
  );
}

function LeakBanner({ data }: { data: VpnStatusResponse }) {
  const failed = data.checks.filter((check) => !check.passed);
  return (
    <Alert variant="destructive">
      <ShieldAlertIcon />
      <AlertTitle>A VPN leak was detected</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        <p>
          qBittorrent&apos;s network namespace did not pass every boundary check.
          Traffic may be able to leave outside the VPN.
        </p>
        <ul className="list-disc pl-5">
          {failed.map((check) => (
            <li key={check.id}>{check.label}</li>
          ))}
        </ul>
        <p>
          Check <code className="font-mono text-xs">docker logs gluetun</code> and{" "}
          <code className="font-mono text-xs">docker logs vpn-check</code>.
        </p>
      </AlertDescription>
    </Alert>
  );
}

function DataPoints({ data }: { data: VpnStatusResponse }) {
  const ipv6 = data.checks.find((check) => check.id === "ipv6");
  const provider = [data.exit.organization, data.exit.serverType]
    .filter(Boolean)
    .join(" · ");

  return (
    <Card>
      <CardHeader>
        <CardTitle>What was tested</CardTitle>
        <CardDescription>
          This snapshot describes the live path qBittorrent uses right now.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <DataPoint label="Public exit IP" value={data.exit.ip ?? "Unknown"} mono />
          <DataPoint label="Exit location" value={formatLocation(data.exit) || "Unknown"} />
          <DataPoint
            label="Mullvad server"
            value={data.exit.hostname ?? "Not reported"}
            mono
          />
          <DataPoint label="Provider" value={provider || "Mullvad VPN"} />
          <DataPoint
            label="DNS resolver"
            value={data.dnsNameservers.join(", ") || "Not configured"}
            mono
          />
          <DataPoint
            label="Firewall exemption"
            value={data.firewallException ?? "Loopback only"}
            mono
          />
          <DataPoint label="IPv6" value={ipv6?.passed ? "Disabled" : "Enabled"} />
          <DataPoint label="Test duration" value={formatDuration(data.durationMs)} />
        </dl>
      </CardContent>
    </Card>
  );
}

function DataPoint({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={mono ? "truncate font-mono text-sm" : "truncate text-sm font-medium"}>
        {value}
      </dd>
    </div>
  );
}

function CheckRow({ check }: { check: VpnCheck }) {
  return (
    <>
      <div className="flex items-start gap-3">
        {check.passed ? (
          <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-emerald-500" />
        ) : (
          <CircleXIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="font-medium">{check.label}</p>
          <p className="text-xs text-muted-foreground">{check.detail}</p>
        </div>
        <Badge variant={check.passed ? "secondary" : "destructive"}>
          {check.passed ? "Passed" : "Failed"}
        </Badge>
      </div>
      <Separator className="last:hidden" />
    </>
  );
}

function SectionHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-col gap-1">
      <h2 className="font-heading text-xl font-semibold tracking-tight">{title}</h2>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function formatLocation(exit: VpnStatusResponse["exit"]): string {
  return [exit.city, exit.country].filter(Boolean).join(", ");
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${Math.round(durationMs)} ms`;
  }
  return `${(durationMs / 1000).toFixed(1)} s`;
}

function formatCheckedAt(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}
