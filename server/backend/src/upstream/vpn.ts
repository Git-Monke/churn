import type { VpnConfig } from "../config.js";
import { UpstreamError } from "../errors.js";
import { fetchJson } from "../http.js";
import type {
  VpnCheck,
  VpnCheckId,
  VpnCoverageEntry,
  VpnCoverageId,
  VpnExit,
  VpnStatusResponse,
} from "../types.js";

type JsonObject = Record<string, unknown>;

const COVERAGE: Array<{ id: VpnCoverageId; name: string }> = [
  { id: "qbittorrent", name: "qBittorrent" },
  { id: "prowlarr", name: "Prowlarr" },
  { id: "flaresolverr", name: "FlareSolverr" },
];

/**
 * Read-only client for the torrent stack's `vpn-status` agent. The agent runs
 * inside Gluetun's namespace, so its result describes qBittorrent's network
 * path rather than the host's.
 */
export function createVpnClient(config: VpnConfig) {
  return {
    async getStatus(): Promise<VpnStatusResponse> {
      const payload = await fetchJson<unknown>("vpn", `${config.statusUrl}/status`, {
        timeoutMs: config.timeoutMs,
      });
      return mapVpnStatus(payload);
    },
  };
}

/** Validate the agent payload and turn it into the browser-safe response. */
export function mapVpnStatus(payload: unknown): VpnStatusResponse {
  const root = requireObject(payload, "status");
  const checkedAt = requireString(root.checkedAt, "checkedAt");
  if (Number.isNaN(Date.parse(checkedAt))) {
    throw invalidResponse();
  }
  const durationMs = requireNumber(root.durationMs, "durationMs");
  const secure = requireBoolean(root.secure, "secure");

  const provider = requireString(root.provider, "provider");
  const protocol = requireString(root.protocol, "protocol");

  const checksRaw = requireObject(root.checks, "checks");
  const checks = {
    tunnelExit: requireBoolean(checksRaw.tunnelExit, "checks.tunnelExit"),
    killSwitch: requireBoolean(checksRaw.killSwitch, "checks.killSwitch"),
    dns: requireBoolean(checksRaw.dns, "checks.dns"),
    ipv6: requireBoolean(checksRaw.ipv6, "checks.ipv6"),
    firewallException: requireBoolean(
      checksRaw.firewallException,
      "checks.firewallException",
    ),
  };

  // The exit identity is whatever ipinfo reports through the tunnel, so it is
  // provider-neutral: an IP, a country and an organisation. There is no
  // provider-specific server name or server type to read.
  const exitRaw = requireObject(root.exit, "exit");
  const exit: VpnExit = {
    ip: optionalString(exitRaw.ip),
    country: optionalString(exitRaw.country),
    organization: optionalString(exitRaw.organization),
    matchesGluetun: requireBoolean(exitRaw.matchesGluetun, "exit.matchesGluetun"),
  };

  const dns = requireObject(root.dns, "dns");
  const dnsNameservers = requireStringArray(dns.nameservers, "dns.nameservers");

  const firewall = requireObject(root.firewall, "firewall");
  requireBoolean(firewall.directEgressBlocked, "firewall.directEgressBlocked");
  const firewallException = optionalString(firewall.exception) || undefined;

  const ipv6 = requireObject(root.ipv6, "ipv6");
  requireBoolean(ipv6.disabled, "ipv6.disabled");

  const coverageRaw = requireArray(root.coverage, "coverage");
  const reachable = new Map<string, boolean>();
  for (const entry of coverageRaw) {
    const item = requireObject(entry, "coverage entry");
    const id = requireString(item.id, "coverage.id");
    reachable.set(id, requireBoolean(item.reachable, "coverage.reachable"));
  }
  const coverage: VpnCoverageEntry[] = COVERAGE.map(({ id, name }) => ({
    id,
    name,
    reachable: reachable.get(id) ?? false,
  }));

  const exitDescription =
    `${exit.ip ?? "unknown"}${exit.country ? ` in ${exit.country}` : ""}`;

  const checkDetails: Record<VpnCheckId, string> = {
    tunnel_exit: checks.tunnelExit
      ? `The public exit matches Gluetun's tunnel address (${exitDescription})`
      : `The public exit (${exitDescription}) does not match Gluetun's tunnel address`,
    kill_switch: checks.killSwitch
      ? "Direct traffic through eth0 cannot reach the internet"
      : "Traffic through eth0 reached the internet; the kill switch is not effective",
    dns: checks.dns
      ? dnsNameservers.length > 0
        ? `Only Gluetun's resolver is configured (${dnsNameservers.join(", ")})`
        : "Gluetun's resolver is configured"
      : dnsNameservers.length > 0
        ? `Unexpected nameservers: ${dnsNameservers.join(", ")}`
        : "No Gluetun resolver is configured",
    ipv6: checks.ipv6
      ? "IPv6 is disabled in the shared namespace"
      : "IPv6 is enabled in the shared namespace",
    firewall_exception: checks.firewallException
      ? firewallException
        ? `Only the local address ${firewallException} is exempt`
        : "Only loopback is exempt"
      : "The firewall exception is not a local address",
  };

  const checkLabels: Record<VpnCheckId, string> = {
    tunnel_exit: "Public exit is the tunnel's exit",
    kill_switch: "Direct interface egress is blocked",
    dns: "DNS uses Gluetun's tunnel resolver",
    ipv6: "IPv6 is disabled in the shared namespace",
    firewall_exception: "Firewall exemption is a local address",
  };

  const checkOrder: VpnCheckId[] = [
    "tunnel_exit",
    "kill_switch",
    "dns",
    "ipv6",
    "firewall_exception",
  ];
  const checkPassed: Record<VpnCheckId, boolean> = {
    tunnel_exit: checks.tunnelExit,
    kill_switch: checks.killSwitch,
    dns: checks.dns,
    ipv6: checks.ipv6,
    firewall_exception: checks.firewallException,
  };
  const checkList: VpnCheck[] = checkOrder.map((id) => ({
    id,
    label: checkLabels[id],
    passed: checkPassed[id],
    detail: checkDetails[id],
  }));

  return {
    checkedAt,
    durationMs,
    secure,
    provider,
    protocol,
    exit,
    checks: checkList,
    coverage,
    dnsNameservers,
    ...(firewallException ? { firewallException } : {}),
  };
}

function invalidResponse(): UpstreamError {
  return new UpstreamError(
    "vpn",
    "invalid_response",
    "The VPN status agent returned an invalid response",
  );
}

function asObject(value: unknown): JsonObject | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as JsonObject;
}

function requireObject(value: unknown, _field: string): JsonObject {
  const object = asObject(value);
  if (!object) {
    throw invalidResponse();
  }
  return object;
}

function requireString(value: unknown, _field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw invalidResponse();
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requireNumber(value: unknown, _field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw invalidResponse();
  }
  return value;
}

function requireBoolean(value: unknown, _field: string): boolean {
  if (typeof value !== "boolean") {
    throw invalidResponse();
  }
  return value;
}

function requireArray(value: unknown, _field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw invalidResponse();
  }
  return value;
}

function requireStringArray(value: unknown, _field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw invalidResponse();
  }
  return value as string[];
}
