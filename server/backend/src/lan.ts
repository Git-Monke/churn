import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

/**
 * LAN address detection, used to build browser-facing URLs (video streams)
 * that work from other devices instead of pointing at the client's own
 * loopback.
 *
 * This mirrors `envfile::host_ip()` in churn's Rust side: the host's LAN
 * address is the one thing the browser, the backend and the containers can all
 * reach on a single-machine install. `CHURN_HOST_IP` overrides detection.
 */

/** Interfaces that are usually virtual: VPN tunnels and container bridges. */
const VIRTUAL_INTERFACE =
  /^(docker|br[-_]?|veth|virbr|vmnet|tun|tap|tailscale|wg|zt|cni|flannel|kube|podman)/i;

/** Anywhere on the LAN is preferred over a public address, which is preferred over a tailnet/CGNAT one. */
const PREFERRED_SCORE = 3;
const PUBLIC_SCORE = 2;
const CGNAT_SCORE = 1;
const VIRTUAL_INTERFACE_PENALTY = 2;

/** Parse a dotted-quad IPv4 address into a number, or undefined. */
function ipv4ToInt(address: string): number | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return undefined;
  }
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return undefined;
    }
    const octet = Number(part);
    if (octet > 255) {
      return undefined;
    }
    value = value * 256 + octet;
  }
  return value;
}

/** True when `value` falls inside `base/bits`. */
function inRange(value: number, base: string, bits: number): boolean {
  const baseValue = ipv4ToInt(base);
  if (baseValue === undefined) {
    return false;
  }
  const mask = bits === 0 ? 0 : (0xffff_ffff << (32 - bits)) >>> 0;
  return ((value & mask) >>> 0) === ((baseValue & mask) >>> 0);
}

function scoreAddress(value: number, interfaceName: string): number {
  let score = CGNAT_SCORE;
  if (
    inRange(value, "10.0.0.0", 8) ||
    inRange(value, "172.16.0.0", 12) ||
    inRange(value, "192.168.0.0", 16)
  ) {
    score = PREFERRED_SCORE;
  } else if (!inRange(value, "100.64.0.0", 10)) {
    // Not CGNAT: a public address is still "reachable from the LAN".
    score = PUBLIC_SCORE;
  }
  if (VIRTUAL_INTERFACE.test(interfaceName)) {
    score -= VIRTUAL_INTERFACE_PENALTY;
  }
  return score;
}

/**
 * Choose the best LAN IPv4 address from a `networkInterfaces()` snapshot.
 *
 * Loopback, link-local and unspecified addresses are never candidates. Ties
 * break on interface name so the result is stable across runs.
 */
export function pickLanAddress(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
): string | undefined {
  const candidates: { address: string; name: string; score: number }[] = [];

  for (const [name, infos] of Object.entries(interfaces)) {
    for (const info of infos ?? []) {
      if (info.internal || info.family !== "IPv4") {
        continue;
      }
      const value = ipv4ToInt(info.address);
      if (value === undefined || value === 0) {
        continue;
      }
      if (inRange(value, "127.0.0.0", 8) || inRange(value, "169.254.0.0", 16)) {
        continue;
      }
      candidates.push({ address: info.address, name, score: scoreAddress(value, name) });
    }
  }

  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      a.name.localeCompare(b.name) ||
      a.address.localeCompare(b.address),
  );
  return candidates[0]?.address;
}

/** Best-effort LAN address of this host, or undefined when there is none. */
export function detectLanAddress(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env.CHURN_HOST_IP?.trim();
  if (override) {
    return override;
  }
  return pickLanAddress(networkInterfaces());
}
