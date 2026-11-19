import { expect, test } from "bun:test";
import { reachOf } from "./reach";

test("reach sums up the routes per interface: the internet, named networks, counted machines; local entries left out (#20)", () => {
  // As `ip -j route show table all` prints them on a machine with a LAN, a VPN, docker and IPv6.
  const routes = [
    { dst: "default", gateway: "10.0.3.1", dev: "enp5s0", protocol: "dhcp" },
    { dst: "10.0.3.0/24", dev: "enp5s0", protocol: "kernel" },
    { dst: "10.0.3.1", dev: "enp5s0", protocol: "dhcp" },
    { dst: "100.64.0.10", dev: "tailscale0", table: "52" },
    { dst: "100.64.0.11", dev: "tailscale0", table: "52" },
    { dst: "192.168.1.0/24", dev: "tailscale0", table: "52" },
    { dst: "172.17.0.0/16", dev: "docker0", protocol: "kernel" },
    { dst: "fe80::/64", dev: "enp5s0", protocol: "kernel" },
    { type: "local", dst: "10.0.3.12", dev: "enp5s0", table: "local" },
    { type: "broadcast", dst: "10.0.3.255", dev: "enp5s0", table: "local" },
    { type: "multicast", dst: "ff00::/8", dev: "enp5s0", table: "local" },
    { dst: "127.0.0.0/8", dev: "lo", table: "local", type: "local" },
  ];
  expect(reachOf(routes)).toEqual([
    "the internet (via enp5s0)",
    "10.0.3.0/24, 1 machine (via enp5s0)",
    "192.168.1.0/24, 2 machines (via tailscale0)",
    "172.17.0.0/16 (via docker0)",
  ]);
});

test("many networks on one interface are counted past the first four", () => {
  const routes = Array.from({ length: 7 }, (_, at) => ({ dst: `10.${at}.0.0/16`, dev: "wg0" }));
  expect(reachOf(routes)).toEqual([
    "10.0.0.0/16, 10.1.0.0/16, 10.2.0.0/16, 10.3.0.0/16, 3 more networks (via wg0)",
  ]);
});
