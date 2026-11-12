import { PAIRING_PATHS, pairingLink } from "@omp-app/contracts";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  askMachine,
  askToPair,
  codeFromAddress,
  enterPairingCode,
  takePairingCode,
} from "./pairing-api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a pairing QR code's address", () => {
  test("opens the app's page, which reads back the code; other addresses carry none", () => {
    const opened = new URL(pairingLink("https://app.example.ts.net/", "K7F3QX9M"));
    expect(opened.pathname).toBe("/");
    expect(codeFromAddress(opened.hash)).toBe("K7F3QX9M");
    expect(codeFromAddress("#token=abc&folder=%2Fhome")).toBeNull();
    expect(codeFromAddress("")).toBeNull();
  });
});

describe("taking the one-time code from the address", () => {
  /** A page at `/#pair=K7F3QX9M`, on its own or in a frame; what `history.replaceState` was told. */
  function page(framed: boolean) {
    const replaced: string[] = [];
    const self: { parent: unknown; location: unknown; history: unknown } = {
      parent: null,
      location: { hash: "#pair=K7F3QX9M&x=1", pathname: "/", search: "?embed=1" },
      history: {
        replaceState: (_state: unknown, _title: string, url: string) => replaced.push(url),
      },
    };
    self.parent = framed ? {} : self;
    vi.stubGlobal("window", self);
    return replaced;
  }

  test("a page of its own takes it out of the address, and the rest of the address stays", () => {
    const replaced = page(false);
    expect(takePairingCode()).toBe("K7F3QX9M");
    expect(replaced).toEqual(["/?embed=1#x=1"]);
  });

  test("a page in a frame takes none and leaves the address: a frame must not use up a code with five wrong tries", () => {
    const replaced = page(true);
    expect(takePairingCode()).toBeNull();
    expect(replaced).toEqual([]);
  });
});

describe("the frame a pairing page tells the app", () => {
  const bodies: Record<string, unknown>[] = [];
  const answer = (status: Record<string, unknown>) => async (_path: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json(status);
  };

  test("is sent with a request and with a code, and left out for a page of its own", async () => {
    vi.stubGlobal("fetch", answer({ requestId: "r", code: "123456", expiresAt: "t" }));
    await askToPair("Panel", "browser", { framed: true, framedBy: "vscode-webview://abc" });
    await askToPair("Panel", "browser", { framed: true });
    await askToPair("Page", "browser");
    vi.stubGlobal("fetch", answer({ status: "expired" }));
    await enterPairingCode("K7F3QX9M", "Panel", "browser", "host", { framed: true });
    expect(bodies.splice(0)).toEqual([
      { name: "Panel", kind: "browser", framed: true, framedBy: "vscode-webview://abc" },
      { name: "Panel", kind: "browser", framed: true },
      { name: "Page", kind: "browser" },
      { code: "K7F3QX9M", name: "Panel", kind: "browser", keep: "host", framed: true },
    ]);
  });
});

describe("the name of the computer this page is on", () => {
  test("is asked by POST with a time limit, and is the name the app gives", async () => {
    const fetched = vi.fn(async (_path: string, _init?: RequestInit) =>
      Response.json({ machine: "my-laptop" }),
    );
    vi.stubGlobal("fetch", fetched);
    expect(await askMachine()).toBe("my-laptop");
    const [path, init] = fetched.mock.calls[0] ?? [];
    expect(path).toBe(PAIRING_PATHS.machine);
    expect(init?.method).toBe("POST");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  test("is null when the app knows none, refuses, answers oddly or does not answer", async () => {
    for (const answer of [
      () => Response.json({ machine: null }),
      () => Response.json({ error: "Not this app's page" }, { status: 403 }),
      () => Response.json({ machine: 7 }),
      () => Response.json({ machine: "my-laptop", other: true }),
      () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
    ]) {
      vi.stubGlobal("fetch", async () => answer());
      expect(await askMachine()).toBeNull();
    }
  });
});
