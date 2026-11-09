import { describe, expect, test } from "bun:test";
import { parseRemoteOrigin } from "./remote-origin";

describe("parseRemoteOrigin", () => {
  test("is off when the variable is unset or blank", () => {
    expect(parseRemoteOrigin(undefined)).toBeUndefined();
    expect(parseRemoteOrigin("  ")).toBeUndefined();
  });

  test("takes an HTTPS address of any kind, with or without a trailing slash, in any case", () => {
    const expected = { origin: "https://omp.example.com", host: "omp.example.com" };
    expect(parseRemoteOrigin("https://omp.example.com")).toEqual(expected);
    expect(parseRemoteOrigin("https://omp.example.com/")).toEqual(expected);
    expect(parseRemoteOrigin(" https://OMP.Example.COM ")).toEqual(expected);
    expect(parseRemoteOrigin("https://devbox.tail1234.ts.net")).toEqual({
      origin: "https://devbox.tail1234.ts.net",
      host: "devbox.tail1234.ts.net",
    });
    expect(parseRemoteOrigin("https://10.1.2.3")).toEqual({
      origin: "https://10.1.2.3",
      host: "10.1.2.3",
    });
  });

  test("a port other than 443 stays in the Host the browser sends; 443 is left out, as browsers leave it", () => {
    expect(parseRemoteOrigin("https://omp.example.com:8443")).toEqual({
      origin: "https://omp.example.com:8443",
      host: "omp.example.com:8443",
    });
    expect(parseRemoteOrigin("https://omp.example.com:443")).toEqual({
      origin: "https://omp.example.com",
      host: "omp.example.com",
    });
  });

  test("refuses plain HTTP, wildcard hosts, anything after the address, and what is no address", () => {
    for (const value of [
      "http://omp.example.com",
      "https://*",
      "https://*.example.com",
      "http://127.0.0.1:4317",
      "https://the test machine.example.com",
      "https://omp.example.com/app",
      "https://omp.example.com/?x=1",
      "https://omp.example.com/#x",
      "https://user@omp.example.com",
      "omp.example.com",
      "ftp://omp.example.com",
    ]) {
      expect(() => parseRemoteOrigin(value)).toThrow("OMP_APP_REMOTE_ORIGIN must be");
    }
  });
});
