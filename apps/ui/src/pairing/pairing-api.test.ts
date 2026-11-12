import { PAIRING_PATHS, pairingLink } from "@omp-app/contracts";
import { afterEach, describe, expect, test, vi } from "vitest";
import { askMachine, codeFromAddress } from "./pairing-api";

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
