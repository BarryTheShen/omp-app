import { describe, expect, test, vi } from "vitest";
import {
  APP_TOKEN_STORAGE_KEY,
  type LaunchLocationLike,
  launchFolderInFragment,
  launchTokenInFragment,
  readLaunchToken,
  type TokenStorageLike,
  websocketUrl,
} from "./token";

function location(hash: string): LaunchLocationLike {
  return {
    hash,
    pathname: "/",
    search: "?view=chat",
    protocol: "http:",
    host: "127.0.0.1:4317",
  };
}

function storage(
  initial: Record<string, string> = {},
): TokenStorageLike & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
}

describe("launch token hand-off", () => {
  test("reads a fragment token, stores it once, and strips only the token fragment", () => {
    const replaceState = vi.fn();
    const session = storage();
    const result = readLaunchToken({
      location: location("#token=launch-value&tab=history"),
      storage: session,
      history: { replaceState },
    });

    expect(result).toEqual({ token: "launch-value", source: "url", folder: null });
    expect(session.values.get(APP_TOKEN_STORAGE_KEY)).toBe("launch-value");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/?view=chat#tab=history");
  });

  test("uses the session token after a reload without exposing it in the URL", () => {
    const session = storage({ [APP_TOKEN_STORAGE_KEY]: "stored-value" });
    const replaceState = vi.fn();
    const result = readLaunchToken({
      location: location("#tab=history"),
      storage: session,
      history: { replaceState },
    });

    expect(result).toEqual({ token: "stored-value", source: "session", folder: null });
    expect(replaceState).not.toHaveBeenCalled();
  });

  test("reports a missing token and tolerates unavailable session storage", () => {
    const result = readLaunchToken({
      location: location(""),
      storage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
      },
    });
    expect(result).toEqual({ token: null, source: "missing", folder: null });
  });

  test("derives a same-origin WebSocket endpoint", () => {
    expect(websocketUrl({ protocol: "http:", host: "127.0.0.1:4317" })).toBe(
      "ws://127.0.0.1:4317/ws",
    );
    expect(websocketUrl({ protocol: "https:", host: "example.test" })).toBe(
      "wss://example.test/ws",
    );
  });
});

describe("launchTokenInFragment", () => {
  test("reads the token from a fragment, among its other parameters", () => {
    expect(launchTokenInFragment("#token=abc&tab=history")).toBe("abc");
  });

  test("is null when the fragment has no token, or an empty one", () => {
    expect(launchTokenInFragment("#tab=history")).toBeNull();
    expect(launchTokenInFragment("#token=")).toBeNull();
    expect(launchTokenInFragment("")).toBeNull();
  });
});

describe("launchFolderInFragment", () => {
  test("reads the folder from a fragment, among its other parameters, as the page decodes it", () => {
    expect(launchFolderInFragment("#token=abc&folder=%2Fwork%2Fmy%20app%26x&tab=history")).toBe(
      "/work/my app&x",
    );
  });

  test("is null when the fragment has no folder, or an empty one", () => {
    expect(launchFolderInFragment("#token=abc")).toBeNull();
    expect(launchFolderInFragment("#folder=")).toBeNull();
    expect(launchFolderInFragment("")).toBeNull();
  });

  test("is null for a path that is not absolute", () => {
    for (const path of ["work/app", "./app", "../app", "~/app", " /work/app", "file:///work/app"]) {
      expect(launchFolderInFragment(`#folder=${encodeURIComponent(path)}`)).toBeNull();
    }
  });
});

describe("launch folder hand-off", () => {
  test("reads the folder with the token and takes both out of the address, keeping other parameters", () => {
    const replaceState = vi.fn();
    const result = readLaunchToken({
      location: location("#token=launch-value&folder=%2Fwork%2Fapp&tab=history"),
      storage: storage(),
      history: { replaceState },
    });

    expect(result).toEqual({ token: "launch-value", source: "url", folder: "/work/app" });
    expect(replaceState).toHaveBeenCalledOnce();
    expect(replaceState).toHaveBeenCalledWith(null, "", "/?view=chat#tab=history");
  });

  test("a link with no folder reports none and leaves the address as the token strip made it", () => {
    const replaceState = vi.fn();
    const result = readLaunchToken({
      location: location("#token=launch-value"),
      storage: storage(),
      history: { replaceState },
    });

    expect(result.folder).toBeNull();
    expect(replaceState).toHaveBeenCalledOnce();
    expect(replaceState).toHaveBeenCalledWith(null, "", "/?view=chat");
  });

  test("a relative folder is ignored, and still taken out of the address", () => {
    const replaceState = vi.fn();
    const result = readLaunchToken({
      location: location("#token=launch-value&folder=projects%2Fapp"),
      storage: storage(),
      history: { replaceState },
    });

    expect(result).toEqual({ token: "launch-value", source: "url", folder: null });
    expect(replaceState).toHaveBeenCalledWith(null, "", "/?view=chat");
  });

  test("a folder alone in the address is read, and the token the tab kept is still used", () => {
    const replaceState = vi.fn();
    const result = readLaunchToken({
      location: location("#folder=%2Fwork%2Fapp%2F"),
      storage: storage({ [APP_TOKEN_STORAGE_KEY]: "stored-value" }),
      history: { replaceState },
    });

    expect(result).toEqual({ token: "stored-value", source: "session", folder: "/work/app" });
    expect(replaceState).toHaveBeenCalledWith(null, "", "/?view=chat");
  });

  test("a page opened without a folder asks for none", () => {
    const replaceState = vi.fn();
    const result = readLaunchToken({
      location: location("#tab=history"),
      storage: storage({ [APP_TOKEN_STORAGE_KEY]: "stored-value" }),
      history: { replaceState },
    });

    expect(result.folder).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });

  test("a second read of the same page finds no folder in the address, so a reload asks for none", () => {
    const address = { ...location("#token=launch-value&folder=%2Fwork%2Fapp") };
    const history = {
      replaceState: (_data: unknown, _unused: string, url?: string | URL | null) => {
        address.hash = new URL(String(url), "http://127.0.0.1:4317").hash;
      },
    };
    const session = storage();

    const first = readLaunchToken({ location: address, storage: session, history });
    const second = readLaunchToken({ location: address, storage: session, history });

    expect(first).toEqual({ token: "launch-value", source: "url", folder: "/work/app" });
    expect(second).toEqual({ token: "launch-value", source: "session", folder: null });
  });
});
