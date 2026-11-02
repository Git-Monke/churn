import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

import { describe, expect, it } from "vitest";

import { detectLanAddress, pickLanAddress } from "../src/lan.js";

function iface(address: string, family: "IPv4" | "IPv6" = "IPv4"): NetworkInterfaceInfo {
  return {
    address,
    netmask: "255.255.255.0",
    family,
    mac: "00:00:00:00:00:00",
    internal: false,
    cidr: `${address}/24`,
  } as NetworkInterfaceInfo;
}

describe("LAN address detection", () => {
  it("prefers a real LAN address over container bridges and tunnels", () => {
    expect(
      pickLanAddress({
        docker0: [iface("172.17.0.1")],
        "br-544f31f6e069": [iface("172.18.0.1")],
        tailscale0: [iface("100.117.4.8")],
        wlp10s0: [iface("192.168.0.97")],
      }),
    ).toBe("192.168.0.97");
  });

  it("ignores loopback, link-local, IPv6 and internal entries", () => {
    expect(
      pickLanAddress({
        lo: [{ ...iface("127.0.0.1"), internal: true }],
        eth0: [iface("169.254.10.20"), iface("fe80::1", "IPv6"), iface("0.0.0.0")],
      }),
    ).toBeUndefined();
  });

  it("falls back to a tailnet or public address when that is all there is", () => {
    expect(pickLanAddress({ tailscale0: [iface("100.117.4.8")] })).toBe("100.117.4.8");
    expect(pickLanAddress({ eth0: [iface("203.0.113.5")] })).toBe("203.0.113.5");
    // A real LAN address still outranks a public one on the same host.
    expect(
      pickLanAddress({ eth0: [iface("203.0.113.5")], wlp10s0: [iface("10.1.2.3")] }),
    ).toBe("10.1.2.3");
  });

  it("breaks ties on interface name so the result is stable", () => {
    expect(
      pickLanAddress({ enp5s0: [iface("192.168.0.20")], wlp10s0: [iface("192.168.0.97")] }),
    ).toBe("192.168.0.20");
  });

  it("honours the CHURN_HOST_IP override", () => {
    expect(detectLanAddress({ CHURN_HOST_IP: " 192.168.1.50 " })).toBe("192.168.1.50");
    expect(detectLanAddress({ CHURN_HOST_IP: "" })).toBe(
      pickLanAddress(networkInterfaces()),
    );
  });
});
