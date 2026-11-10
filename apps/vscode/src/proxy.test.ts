import { describe, expect, test } from "vitest";
import { type ProxySettings, proxyFor } from "./proxy";

const APP = "https://laptop.example-tailnet.ts.net";
const settings = (overrides: Partial<ProxySettings>): ProxySettings => ({
  proxy: "",
  noProxy: [],
  env: {},
  ...overrides,
});

describe("proxyFor", () => {
  test("no proxy set in VS Code: connections go directly, whatever the system's settings", () => {
    expect(proxyFor(APP, settings({}))).toBeNull();
    expect(proxyFor(APP, settings({ env: { https_proxy: "  " } }))).toBeNull();
  });

  test("the http.proxy setting wins over the environment, which VS Code reads in its own order", () => {
    expect(
      proxyFor(
        APP,
        settings({ proxy: "http://127.0.0.1:10808", env: { https_proxy: "http://10.0.0.9:3128" } }),
      ),
    ).toEqual({ proxy: "http://127.0.0.1:10808", from: "VS Code's http.proxy setting" });
    expect(
      proxyFor(
        APP,
        settings({
          env: { HTTP_PROXY: "http://10.0.0.9:3128", https_proxy: "socks5://127.0.0.1:1080" },
        }),
      ),
    ).toEqual({ proxy: "socks5://127.0.0.1:1080", from: "the https_proxy environment variable" });
  });

  test("a user name and password in the proxy's address never reach the panel's text", () => {
    expect(
      proxyFor(APP, settings({ proxy: "http://me:secret@proxy.example.com:8080" }))?.proxy,
    ).toBe("http://proxy.example.com:8080");
  });

  test("http.noProxy covers the address by name, wildcard, leading dot, port or *", () => {
    for (const rule of [
      "laptop.example-tailnet.ts.net",
      "LAPTOP.example-tailnet.TS.net",
      "*.ts.net",
      ".example-tailnet.ts.net",
      "laptop.example-tailnet.ts.net:443",
      "https://laptop.example-tailnet.ts.net",
      "*",
    ])
      expect(
        proxyFor(APP, settings({ proxy: "http://127.0.0.1:10808", noProxy: [rule] })),
        rule,
      ).toBeNull();
  });

  test("rules that cover another name, port or scheme leave the address on the proxy, as Chromium does", () => {
    for (const rule of [
      "ts.net",
      "other.example-tailnet.ts.net",
      "laptop.example-tailnet.ts.net:8443",
      "http://*.ts.net",
    ])
      expect(
        proxyFor(APP, settings({ proxy: "http://127.0.0.1:10808", noProxy: [rule] })),
        rule,
      ).not.toBeNull();
  });

  test("the environment's no_proxy counts only while http.noProxy is empty, as in VS Code", () => {
    const env = { https_proxy: "http://127.0.0.1:10808", no_proxy: "localhost,.ts.net" };
    expect(proxyFor(APP, settings({ env }))).toBeNull();
    expect(proxyFor(APP, settings({ env, noProxy: ["intranet.example.com"] }))).not.toBeNull();
  });

  test("this computer's own addresses, link-local ones and dotless names always go directly", () => {
    const proxy = "http://127.0.0.1:10808";
    for (const address of [
      "http://127.0.0.1:4317",
      "http://localhost:4317",
      "http://[::1]:4317",
      "http://169.254.10.1",
      "https://omp-box",
    ])
      expect(proxyFor(address, settings({ proxy })), address).toBeNull();
  });

  test("an address given by IP is covered by a range that holds it", () => {
    const proxy = "http://127.0.0.1:10808";
    expect(
      proxyFor("https://100.101.102.103", settings({ proxy, noProxy: ["100.64.0.0/10"] })),
    ).toBeNull();
    expect(
      proxyFor("https://100.128.0.1", settings({ proxy, noProxy: ["100.64.0.0/10"] })),
    ).not.toBeNull();
  });
});
