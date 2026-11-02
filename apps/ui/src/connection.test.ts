import { afterEach, describe, expect, test, vi } from "vitest";

/** One page: its address and its tab's storage. */
function page(hash: string, session = new Map<string, string>()) {
  let address = `/${hash}`;
  vi.stubGlobal("window", {
    location: { hash, pathname: "/", search: "" },
    sessionStorage: {
      getItem: (key: string) => session.get(key) ?? null,
      setItem: (key: string, value: string) => session.set(key, value),
    },
    history: {
      replaceState: (_state: unknown, _title: string, url: string) => {
        address = url;
      },
    },
  });
  return { address: () => address, session };
}

async function readToken(): Promise<string | null> {
  vi.resetModules();
  return (await import("./connection")).readToken();
}

describe("readToken", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("the link's token leaves the address, other parts stay, and the tab keeps it for its reloads", async () => {
    const opened = page("#token=abc&folder=%2Fwork");
    expect(await readToken()).toBe("abc");
    expect(opened.address()).toBe("/#folder=%2Fwork");

    // A reload of the same tab: no token in the address, the tab's copy.
    page("", opened.session);
    expect(await readToken()).toBe("abc");

    // Another tab or device opened without the link has none: it signs in as a paired device.
    page("");
    expect(await readToken()).toBeNull();
  });
});
