import { useEffect, useState } from "react";
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

/**
 * The probe list the agent runs, in order. Only used while a test is in flight,
 * to name what the run is doing before its payload exists.
 */
const PENDING_CHECKS = [
  { label: "Exit route", proof: "Traffic leaves through the tunnel's public address" },
  { label: "Kill switch", proof: "Direct egress on eth0 is refused" },
  { label: "DNS", proof: "Queries resolve through Gluetun, not your ISP" },
  { label: "IPv6", proof: "No IPv6 path bypasses the tunnel" },
  { label: "Firewall", proof: "Only local addresses are exempt from the firewall" },
];

export function VpnStatusPanel() {
  const query = useQuery({
    queryKey: ["vpn"],
    queryFn: fetchVpnStatus,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const run = () => void query.refetch();

  if (query.isFetching) {
    return (
      <section className="flex flex-col gap-3">
        <PanelHeading running />
        <RunningReport />
      </section>
    );
  }

  if (query.isError && !query.data) {
    return (
      <section className="flex flex-col gap-3">
        <PanelHeading onRun={run} />
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Could not run the VPN test</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-3">
            <p>{query.error.message}</p>
            <p>The test runs inside the torrent stack. Start its agent and run it again:</p>
            <code className="rounded-md bg-muted px-2 py-1 font-mono text-xs">
              cd torrent && docker compose up -d vpn-status
            </code>
            <Button variant="outline" size="sm" onClick={run}>
              <RefreshCwIcon data-icon="inline-start" />
              Run test
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
    <section className="flex flex-col gap-3">
      <PanelHeading onRun={run} />
      {query.isError ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Could not refresh the VPN test</AlertTitle>
          <AlertDescription>
            Showing the result from {formatCheckedAt(data.checkedAt)}. {query.error.message}
          </AlertDescription>
        </Alert>
      ) : null}
      <Report data={data} />
    </section>
  );
}

function PanelHeading({ running, onRun }: { running?: boolean; onRun?: () => void }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex flex-col gap-1">
        <h2 className="font-heading text-xl font-semibold tracking-tight">VPN</h2>
        <p className="text-sm text-muted-foreground">
          A live leak test, run inside the same network namespace as qBittorrent.
        </p>
      </div>
      {onRun || running ? (
        <Button
          variant="outline"
          size="sm"
          className="self-start sm:self-auto"
          onClick={onRun}
          disabled={running}
        >
          <RefreshCwIcon
            data-icon="inline-start"
            className={running ? "animate-spin motion-reduce:animate-none" : undefined}
          />
          {running ? "Testing…" : "Run test"}
        </Button>
      ) : null}
    </div>
  );
}

function Report({ data }: { data: VpnStatusResponse }) {
  const failed = data.checks.filter((check) => !check.passed);
  const unreachable = data.coverage.filter((entry) => !entry.reachable);

  return (
    <div className="overflow-hidden rounded-xl bg-card text-sm ring-1 ring-foreground/10">
      <div
        className={
          data.secure
            ? "flex items-start gap-4 border-b border-emerald-500/20 bg-emerald-500/[0.06] px-5 py-5"
            : "flex items-start gap-4 border-b border-destructive/25 bg-destructive/[0.06] px-5 py-5"
        }
      >
        <span
          className={
            data.secure
              ? "rounded-full bg-emerald-500/15 p-2 text-emerald-500"
              : "rounded-full bg-destructive/15 p-2 text-destructive"
          }
        >
          {data.secure ? (
            <ShieldCheckIcon className="size-6" aria-hidden="true" />
          ) : (
            <ShieldAlertIcon className="size-6" aria-hidden="true" />
          )}
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="font-heading text-lg font-semibold">
            {data.secure
              ? `Torrents are protected by ${providerLabel(data)}`
              : "A VPN leak was detected"}
          </h3>
          <p className={data.secure ? "text-foreground/70" : "text-foreground/80"}>
            {data.secure
              ? "Traffic can only leave through the tunnel."
              : "qBittorrent traffic can leave the tunnel. Fix the failing probes before you download anything."}
          </p>
          <p className="font-mono text-xs text-foreground/60">
            {[
              data.exit.ip,
              data.exit.country,
              data.exit.organization,
              formatProtocol(data.protocol),
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
      </div>

      <div className="flex items-baseline justify-between gap-4 px-5 pt-4 pb-1">
        <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Boundary checks
        </h4>
        <span
          className={
            failed.length > 0 ? "text-xs font-medium text-destructive" : "text-xs text-muted-foreground"
          }
        >
          {data.checks.length - failed.length} of {data.checks.length} passed
        </span>
      </div>
      <ul className="divide-y divide-border">
        {data.checks.map((check) => (
          <CheckRow key={check.id} check={check} />
        ))}
      </ul>

      {failed.length > 0 ? (
        <div className="border-t px-5 py-4">
          <p>
            Find the failing probe in the tunnel logs:{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">docker logs gluetun</code>{" "}
            and{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">docker logs vpn-check</code>.
          </p>
        </div>
      ) : null}

      <div className="grid gap-1 border-t px-5 py-4 sm:grid-cols-[minmax(0,22rem)_1fr] sm:gap-4">
        <span className="font-medium">Tunnel coverage</span>
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-x-5 gap-y-1.5">
            {data.coverage.map((entry) => (
              <span key={entry.id} className="inline-flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className={
                    entry.reachable
                      ? "size-1.5 rounded-full bg-emerald-500"
                      : "size-1.5 rounded-full bg-destructive"
                  }
                />
                <span className={entry.reachable ? undefined : "text-destructive"}>
                  {entry.name}
                </span>
                <span className="sr-only">
                  {entry.reachable ? "is reachable inside the tunnel" : "is not reachable"}
                </span>
              </span>
            ))}
          </div>
          {unreachable.length > 0 ? (
            <p className="text-muted-foreground">
              {unreachable.map((entry) => entry.name).join(", ")} did not answer inside the
              tunnel. They may be stopped or stuck in an older namespace. Recreate the stack so
              every app joins Gluetun&apos;s current one:
              <code className="mt-1 block w-fit rounded-md bg-muted px-2 py-1 font-mono text-xs">
                cd torrent && docker compose down && docker compose up -d
              </code>
            </p>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-5 py-3 text-xs text-muted-foreground">
        <span>Checked {formatCheckedAt(data.checkedAt)}</span>
        <span className="tabular-nums">Took {formatDuration(data.durationMs)}</span>
      </div>
    </div>
  );
}

function CheckRow({ check }: { check: VpnCheck }) {
  return (
    <li className="grid items-start gap-x-4 gap-y-1 px-5 py-3.5 sm:grid-cols-[minmax(0,22rem)_1fr]">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
        {check.passed ? (
          <CircleCheckIcon
            className="size-4 shrink-0 text-emerald-500"
            role="img"
            aria-label="Passed"
          />
        ) : (
          <CircleXIcon className="size-4 shrink-0 text-destructive" role="img" aria-label="Failed" />
        )}
        {check.label}
        {check.passed ? null : (
          <Badge variant="destructive" className="ml-1">
            Failed
          </Badge>
        )}
      </span>
      <span className="text-muted-foreground">{check.detail === check.label ? "" : check.detail}</span>
    </li>
  );
}

function RunningReport() {
  const elapsed = useElapsedSeconds();

  return (
    <div className="overflow-hidden rounded-xl bg-card text-sm ring-1 ring-foreground/10">
      <div className="flex flex-col gap-4 border-b bg-muted/40 px-5 py-5">
        <div className="flex items-start gap-4">
          <span className="rounded-full bg-primary/10 p-2 text-primary">
            <ShieldCheckIcon className="size-6" aria-hidden="true" />
          </span>
          <div className="flex flex-col gap-1">
            <h3 className="font-heading text-lg font-semibold" role="status">
              Running the leak test
            </h3>
            <p className="text-muted-foreground">
              A real probe inside qBittorrent&apos;s namespace, not a cached read. It takes a
              few seconds.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 pl-12">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
            <div className="h-full w-1/3 rounded-full bg-primary animate-test-sweep motion-reduce:w-full motion-reduce:animate-none" />
          </div>
          <span
            className="w-14 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground"
            aria-hidden="true"
          >
            {elapsed.toFixed(1)} s
          </span>
        </div>
      </div>

      <div className="flex items-baseline justify-between gap-4 px-5 pt-4 pb-1">
        <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Boundary checks
        </h4>
      </div>
      <ul className="divide-y divide-border">
        {PENDING_CHECKS.map((check) => (
          <li
            key={check.label}
            className="grid items-start gap-x-4 gap-y-1 px-5 py-3.5 sm:grid-cols-[minmax(0,22rem)_1fr]"
          >
            <span className="flex items-center gap-2 font-medium">
              <span
                aria-hidden="true"
                className="size-4 shrink-0 rounded-full border border-muted-foreground/40 animate-pulse motion-reduce:animate-none"
              />
              {check.label}
            </span>
            <span className="text-muted-foreground">{check.proof}</span>
          </li>
        ))}
      </ul>
      <div className="border-t px-5 py-3 text-xs text-muted-foreground">
        Each probe runs in the same network namespace as qBittorrent.
      </div>
    </div>
  );
}

/** Seconds since mount, shown while the probe is in flight. */
function useElapsedSeconds() {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const started = performance.now();
    const id = window.setInterval(() => setElapsed((performance.now() - started) / 1000), 100);
    return () => window.clearInterval(id);
  }, []);

  return elapsed;
}

/** Gluetun ids are lowercase, so "private internet access" reads badly as-is. */
function providerLabel(data: VpnStatusResponse): string {
  const known: Record<string, string> = {
    mullvad: "Mullvad",
    ivpn: "IVPN",
    protonvpn: "Proton VPN",
    nordvpn: "NordVPN",
    surfshark: "Surfshark",
    "private internet access": "Private Internet Access",
  };
  return known[data.provider] ?? data.provider;
}

function formatProtocol(protocol: string): string {
  if (protocol === "wireguard") {
    return "WireGuard";
  }
  if (protocol === "openvpn") {
    return "OpenVPN";
  }
  return protocol;
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
