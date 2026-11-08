import { describe, expect, test } from "bun:test";
import { chromeUserAgent, devToolsAddress } from "./server-browser";

describe("devToolsAddress: where Chrome's DevTools listen, from its output", () => {
  test("a fixed port, for which Chrome writes no DevToolsActivePort file, among its other lines", () => {
    const output = [
      "",
      "DevTools listening on ws://127.0.0.1:9333/devtools/browser/340aecf5-905f-466a-ad67-f826d18ea967",
      "[180653:180653:1103/124530.523379:ERROR:dbus/object_proxy.cc:572] Failed to call method",
      "Created TensorFlow Lite XNNPACK delegate for CPU.",
    ].join("\n");
    expect(devToolsAddress(output)).toEqual({
      port: 9333,
      path: "/devtools/browser/340aecf5-905f-466a-ad67-f826d18ea967",
    });
  });

  test("nothing said yet, or the line cut before its address ends: none", () => {
    expect(devToolsAddress("[1:1:ERROR:dbus] Failed to call method")).toBeNull();
    expect(devToolsAddress("DevTools listening on ws://127.0.0.1:9333")).toBeNull();
  });
});

describe("chromeUserAgent: what the app's browser tells websites it is", () => {
  test("plain Chrome of the browser's own major version, never HeadlessChrome", () => {
    expect(chromeUserAgent("Google Chrome 156.0.8078.73 \n")).toBe(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
    );
    expect(chromeUserAgent("Chromium 141.0.7390.54 built on Debian 13")).toContain(
      " Chrome/141.0.0.0 ",
    );
  });

  test("none when the version cannot be read, so the browser says what it says itself", () => {
    expect(chromeUserAgent("")).toBeNull();
    expect(chromeUserAgent("not a browser")).toBeNull();
  });
});
