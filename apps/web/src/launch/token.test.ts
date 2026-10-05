import { describe, expect, test, vi } from "vitest";
import {
  APP_TOKEN_STORAGE_KEY,
  type LaunchLocationLike,
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

    expect(result).toEqual({ token: "launch-value", source: "url" });
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

    expect(result).toEqual({ token: "stored-value", source: "session" });
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
    expect(result).toEqual({ token: null, source: "missing" });
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
