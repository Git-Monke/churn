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

  const checksRaw = requireObject(root.checks, "checks");
  const checks = {
    mullvadExit: requireBoolean(checksRaw.mullvadExit, "checks.mullvadExit"),
    killSwitch: requireBoolean(checksRaw.killSwitch, "checks.killSwitch"),
    dns: requireBoolean(checksRaw.dns, "checks.dns"),
    ipv6: requireBoolean(checksRaw.ipv6, "checks.ipv6"),
    firewallException: requireBoolean(
      checksRaw.firewallException,
      "checks.firewallException",
    ),
  };

  const mullvad = asObject(root.mullvad) ?? {};
  const exit: VpnExit = {
    ip: optionalString(mullvad.ip),
    country: optionalString(mullvad.country),
    city: optionalString(mullvad.city),
    hostname: optionalString(mullvad.mullvad_exit_ip_hostname),
    organization: optionalString(mullvad.organization),
    serverType: optionalString(mullvad.mullvad_server_type),
    mullvadExit: checks.mullvadExit,
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

  const checkDetails: Record<VpnCheckId, string> = {
    mullvad_exit: checks.mullvadExit
      ? exit.hostname
        ? `The public exit is ${exit.hostname}`
        : "The public exit is a Mullvad server"
      : "The public exit is not recognised as a Mullvad server",
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
    mullvad_exit: "Public exit is a Mullvad server",
    kill_switch: "Direct interface egress is blocked",
    dns: "DNS uses Gluetun's tunnel resolver",
    ipv6: "IPv6 is disabled in the shared namespace",
    firewall_exception: "Firewall exemption is a local address",
  };

  const checkOrder: VpnCheckId[] = [
    "mullvad_exit",
    "kill_switch",
    "dns",
    "ipv6",
    "firewall_exception",
  ];
  const checkPassed: Record<VpnCheckId, boolean> = {
    mullvad_exit: checks.mullvadExit,
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
