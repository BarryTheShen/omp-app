import { afterEach, describe, expect, test, vi } from "vitest";
import { framedByOf, frameOfThisPage, panelInside, panelWarning } from "./framed-by";

afterEach(() => {
  vi.unstubAllGlobals();
});

const ZEN = "moz-extension://1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const EDGE = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

describe("which app a panel is inside", () => {
  test("each origin is named in words, an extension by the start of its id", () => {
    expect(panelInside({ framed: true, framedBy: ZEN })).toBe(
      "a Firefox or Zen extension (moz-extension://1a2b3c4d…)",
    );
    expect(panelInside({ framed: true, framedBy: EDGE })).toBe(
      "a Chrome or Edge extension (chrome-extension://abcdefgh…)",
    );
    expect(panelInside({ framed: true, framedBy: "vscode-webview://0a1b2c3d" })).toBe("VS Code");
    expect(panelInside({ framed: true, framedBy: "vscode-file://vscode-app" })).toBe("VS Code");
    expect(panelInside({ framed: true, framedBy: "https://notes.example.com" })).toBe(
      "notes.example.com",
    );
    expect(panelInside({ framed: true, framedBy: "http://localhost:6806" })).toBe("localhost:6806");
    // An id shorter than eight characters is shown whole.
    expect(panelInside({ framedBy: "moz-extension://abc" })).toBe(
      "a Firefox or Zen extension (moz-extension://abc)",
    );
  });

  test("a frame that did not say whose it is still shows as a panel; a page of its own shows none", () => {
    expect(panelInside({ framed: true })).toBe("another app that did not say which");
    expect(panelInside({})).toBeNull();
    expect(panelInside({ framed: false })).toBeNull();
  });
});

describe("what the person allowing a request is told", () => {
  test("a panel inside a known app holds the device's key, and the app's earlier device is named or none is", () => {
    expect(panelWarning({ framed: true, framedBy: ZEN, framedBefore: null })).toBe(
      "In a panel inside a Firefox or Zen extension (moz-extension://1a2b3c4d…). It will hold this device's key. This app has not paired before.",
    );
    expect(
      panelWarning({ framed: true, framedBy: ZEN, framedBefore: "Zen sidebar on my-laptop" }),
    ).toBe(
      "In a panel inside a Firefox or Zen extension (moz-extension://1a2b3c4d…). It will hold this device's key. The same app paired before as Zen sidebar on my-laptop.",
    );
  });

  test("a panel inside an app that did not say which holds the key too, and has no paired-before line", () => {
    expect(panelWarning({ framed: true })).toBe(
      "In a panel inside another app that did not say which. It will hold this device's key.",
    );
    // Nothing was matched against an origin that is not known, whatever the record carries.
    expect(panelWarning({ framed: true, framedBefore: null })).toBe(
      "In a panel inside another app that did not say which. It will hold this device's key.",
    );
  });

  test("a page of its own is told nothing", () => {
    expect(panelWarning({})).toBeNull();
  });
});

describe("the origin of a frame", () => {
  test("is the first one the app can name: an extension's, VS Code's, a site's; anything else is none", () => {
    expect(framedByOf(null, ZEN)).toBe(ZEN);
    expect(framedByOf(ZEN, EDGE)).toBe(ZEN);
    expect(framedByOf("null", undefined, "https://notes.example.com")).toBe(
      "https://notes.example.com",
    );
    expect(
      framedByOf("null", "file:///index.html", "https://a/b", `https://${"a".repeat(200)}`),
    ).toBeNull();
    expect(framedByOf()).toBeNull();
  });
});

describe("what this page tells the app of its frame", () => {
  const page = (ancestorOrigins: string[] | undefined, framed = true) => {
    const self: { parent: unknown; location: { ancestorOrigins: string[] | undefined } } = {
      parent: null,
      location: { ancestorOrigins },
    };
    self.parent = framed ? {} : self;
    vi.stubGlobal("window", self);
  };

  test("nothing for a page of its own", async () => {
    page(undefined, false);
    expect(await frameOfThisPage()).toEqual({});
  });

  test("the browser's ancestor, when it names one the app can name", async () => {
    page([ZEN]);
    expect(await frameOfThisPage()).toEqual({ framed: true, framedBy: ZEN });
  });

  test("a frame is said even when its origin is unknown: no ancestors in Firefox, an opaque origin elsewhere", async () => {
    page(undefined);
    expect(await frameOfThisPage()).toEqual({ framed: true });
    page(["null"]);
    expect(await frameOfThisPage()).toEqual({ framed: true });
  });
});
