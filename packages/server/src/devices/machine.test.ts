import { describe, expect, test } from "bun:test";
import { createMachineNames } from "./machine";

const NAMES: Record<string, string> = {
  "100.64.0.9": "my-phone",
  "100.127.255.254": "far-end",
  "fd7a:115c:a1e0::aa3b:cf80": "my-tablet",
};

function names(overrides: { whois?: (ip: string) => Promise<string | undefined> } = {}) {
  const asked: string[] = [];
  let clock = 1_000;
  const named = createMachineNames({
    whois:
      overrides.whois ??
      (async (ip) => {
        asked.push(ip);
        return NAMES[ip];
      }),
    hostname: () => "my-laptop",
    now: () => clock,
  });
  return {
    asked,
    advance: (ms: number) => {
      clock += ms;
    },
    from: (forwarded?: string) =>
      named(
        new Request("http://127.0.0.1/pair/machine", {
          method: "POST",
          ...(forwarded === undefined ? {} : { headers: { "x-forwarded-for": forwarded } }),
        }),
      ),
  };
}

describe("the computer a pairing page is on", () => {
  test("a Tailscale IPv4 or IPv6 address is named by Tailscale; only the address the proxy added last counts", async () => {
    const { from, asked } = names();
    expect(await from("100.64.0.9")).toBe("my-phone");
    expect(await from("100.127.255.254")).toBe("far-end");
    expect(await from("FD7A:115C:A1E0:0:0:0:AA3B:CF80")).toBe("my-tablet");
    expect(await from("203.0.113.5, 100.64.0.9")).toBe("my-phone");
    expect(await from("100.64.0.9, 203.0.113.5")).toBeNull();
    // The address Tailscale is asked about is the canonical one.
    expect(asked).toEqual(["100.64.0.9", "100.127.255.254", "fd7a:115c:a1e0::aa3b:cf80"]);
  });

  test("an address that is not Tailscale's has no name, and Tailscale is never asked", async () => {
    const { from, asked } = names();
    for (const address of [
      "203.0.113.5",
      "192.0.2.1",
      "100.63.255.255",
      "100.128.0.0",
      "100.64.0.256",
      "100.064.0.9",
      "10.0.0.1",
      "fd7a:115c:a1e1::1",
      "fd7a:115c::1",
      "2001:db8::1",
      "::1",
      "::ffff:100.64.0.9",
      "not an address",
      "100.64.0.9 --json",
      "-100.64.0.9",
      "",
    ]) {
      expect(await from(address)).toBeNull();
    }
    expect(asked).toEqual([]);
  });

  test("a page on the server's own computer, which no proxy marked, gets the server's name", async () => {
    const { from, asked } = names();
    expect(await from()).toBe("my-laptop");
    expect(asked).toEqual([]);
  });

  test("a failed or empty lookup, a name that is not a computer's name, and a failing hostname are null", async () => {
    expect(
      await names({
        whois: async () => {
          throw new Error("tailscale is not running");
        },
      }).from("100.64.0.9"),
    ).toBeNull();
    expect(await names({ whois: async () => undefined }).from("100.64.0.9")).toBeNull();
    for (const bad of [
      "",
      "-leading-dash",
      "has space",
      "has.dot",
      "semi;colon",
      "new\nline",
      "x".repeat(64),
      "naïve",
    ]) {
      expect(await names({ whois: async () => bad }).from("100.64.0.9")).toBeNull();
    }
    expect(await names({ whois: async () => "x".repeat(63) }).from("100.64.0.9")).toBe(
      "x".repeat(63),
    );
    const noHostname = createMachineNames({
      whois: async () => undefined,
      hostname: () => {
        throw new Error("no hostname");
      },
    });
    expect(await noHostname(new Request("http://127.0.0.1/"))).toBeNull();
    const dotted = createMachineNames({ whois: async () => undefined, hostname: () => "a.local" });
    expect(await dotted(new Request("http://127.0.0.1/"))).toBeNull();
  });

  test("two calls for one address ask Tailscale once, ten minutes at most, and a failed lookup is kept too", async () => {
    const { from, asked, advance } = names();
    expect(await from("100.64.0.9")).toBe("my-phone");
    advance(9 * 60_000);
    expect(await from("100.64.0.9")).toBe("my-phone");
    expect(asked).toEqual(["100.64.0.9"]);
    advance(60_000);
    expect(await from("100.64.0.9")).toBe("my-phone");
    expect(asked).toEqual(["100.64.0.9", "100.64.0.9"]);

    expect(await from("100.64.0.77")).toBeNull();
    expect(await from("100.64.0.77")).toBeNull();
    expect(asked.filter((ip) => ip === "100.64.0.77")).toHaveLength(1);
  });

  test("calls at the same moment for one address ask Tailscale once", async () => {
    const answer = Promise.withResolvers<string>();
    let calls = 0;
    const { from } = names({
      whois: () => {
        calls += 1;
        return answer.promise;
      },
    });
    const both = Promise.all([from("100.64.0.9"), from("100.64.0.9")]);
    answer.resolve("my-phone");
    expect(await both).toEqual(["my-phone", "my-phone"]);
    expect(calls).toBe(1);
  });

  test("at most 256 addresses are kept: the oldest is dropped first", async () => {
    const asked: string[] = [];
    const { from } = names({
      whois: async (ip) => {
        asked.push(ip);
        return "someone";
      },
    });
    for (let i = 0; i < 256; i += 1) await from(`100.64.0.${i}`);
    expect(asked).toHaveLength(256);
    await from("100.64.0.0");
    expect(asked).toHaveLength(256);
    // The 257th address pushes out the oldest, 100.64.0.0, which is asked about again; the next oldest is still kept.
    await from("100.65.0.0");
    expect(asked).toHaveLength(257);
    await from("100.64.0.1");
    expect(asked).toHaveLength(257);
    await from("100.64.0.0");
    expect(asked).toHaveLength(258);
    expect(asked.at(-1)).toBe("100.64.0.0");
  });
});
