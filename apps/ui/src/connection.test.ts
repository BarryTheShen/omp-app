import { afterEach, describe, expect, test, vi } from "vitest";

/** The cookies a site has on the phone, which Add to Home Screen copies into the new app. */
function cookieJar() {
  const values = new Map<string, string>();
  const written: string[] = [];
  return {
    values,
    written,
    get cookie(): string {
      return [...values].map(([name, value]) => `${name}=${value}`).join("; ");
    },
    set cookie(line: string) {
      written.push(line);
      const [pair = ""] = line.split(";");
      const [name = "", value = ""] = pair.split("=");
      values.set(name.trim(), value);
    },
  };
}

/** One page: its address, its tab's storage, the browser's navigator, and the site's cookies. */
function page(options: { hash: string; ios: boolean; cookies: ReturnType<typeof cookieJar> }) {
  const session = new Map<string, string>();
  let address = `/${options.hash}`;
  const shown: (() => void)[] = [];
  vi.stubGlobal("window", {
    location: { hash: options.hash, pathname: "/", search: "" },
    sessionStorage: {
      getItem: (key: string) => session.get(key) ?? null,
      setItem: (key: string, value: string) => session.set(key, value),
    },
    history: {
      replaceState: (_state: unknown, _title: string, url: string) => {
        address = url;
      },
    },
    navigator: options.ios ? { standalone: false } : {},
  });
  // The page's document: the site's cookies, and the page coming back to the front.
  const document = Object.create(options.cookies);
  document.visibilityState = "visible";
  document.addEventListener = (type: string, listener: () => void) => {
    if (type === "visibilitychange") shown.push(listener);
  };
  vi.stubGlobal("document", document);
  return {
    address: () => address,
    comeBack: () => {
      for (const listener of shown) listener();
    },
  };
}

async function readToken(): Promise<string | null> {
  vi.resetModules();
  return (await import("./connection")).readToken();
}

describe("readToken", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("on iOS the link's token is kept for the Home Screen app, which opens without it", async () => {
    const cookies = cookieJar();
    const safari = page({ hash: "#token=abc", ios: true, cookies });
    expect(await readToken()).toBe("abc");
    expect(safari.address()).toBe("/");
    expect(cookies.written).toEqual([
      "omp-app-token=abc; Path=/; Max-Age=34560000; SameSite=Strict; Secure",
    ]);

    // The Home Screen app: its own empty tab storage, no token in its address, Safari's cookies copied in.
    page({ hash: "", ios: true, cookies });
    expect(await readToken()).toBe("abc");
  });

  test("a newer link replaces the token kept for the Home Screen", async () => {
    const cookies = cookieJar();
    cookies.values.set("omp-app-token", "old");
    page({ hash: "#token=new", ios: true, cookies });
    expect(await readToken()).toBe("new");
    expect(cookies.values.get("omp-app-token")).toBe("new");
  });

  test("on iOS the kept token is written again at each start and each return to the front: WebKit keeps a script's cookie only 7 days", async () => {
    const cookies = cookieJar();
    cookies.values.set("omp-app-token", "abc");
    const line = "omp-app-token=abc; Path=/; Max-Age=34560000; SameSite=Strict; Secure";
    const app = page({ hash: "", ios: true, cookies });
    expect(await readToken()).toBe("abc");
    expect(cookies.written).toEqual([line]);
    app.comeBack();
    expect(cookies.written).toEqual([line, line]);
  });

  test("elsewhere the token lasts as long as the tab", async () => {
    const cookies = cookieJar();
    page({ hash: "#token=abc", ios: false, cookies });
    expect(await readToken()).toBe("abc");
    expect(cookies.written).toEqual([]);

    // A cookie from earlier is not read outside iOS either.
    cookies.values.set("omp-app-token", "kept");
    page({ hash: "", ios: false, cookies });
    expect(await readToken()).toBeNull();
  });
});
