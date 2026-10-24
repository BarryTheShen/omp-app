import { describe, expect, test } from "bun:test";
import { parseRemoteOrigin } from "./remote-origin";

describe("parseRemoteOrigin", () => {
  test("is off when the variable is unset or blank", () => {
    expect(parseRemoteOrigin(undefined)).toBeUndefined();
    expect(parseRemoteOrigin("  ")).toBeUndefined();
  });

  test("takes a Tailscale name over HTTPS, with or without a trailing slash, in any case", () => {
    const expected = { origin: "https://devbox.tail1234.ts.net", host: "devbox.tail1234.ts.net" };
    expect(parseRemoteOrigin("https://devbox.tail1234.ts.net")).toEqual(expected);
    expect(parseRemoteOrigin("https://devbox.tail1234.ts.net/")).toEqual(expected);
    expect(parseRemoteOrigin(" https://DEVBOX.tail1234.TS.NET ")).toEqual(expected);
  });

  test("refuses anything that is not a bare https://<name>.ts.net address", () => {
    for (const value of [
      "http://devbox.tail1234.ts.net",
      "https://the test machine.example.com",
      "https://ts.net",
      "https://devbox.tail1234.ts.net:8443",
      "https://devbox.tail1234.ts.net/app",
      "https://devbox.tail1234.ts.net/?x=1",
      "https://user@devbox.tail1234.ts.net",
      "devbox.tail1234.ts.net",
    ]) {
      expect(() => parseRemoteOrigin(value)).toThrow("OMP_APP_REMOTE_ORIGIN must be");
    }
  });
});
