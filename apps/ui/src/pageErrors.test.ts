import type { ClientErrorReport } from "@omp-app/contracts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { installPageErrorReporting, reportPageError, setPageErrorSink } from "./pageErrors";

let reports: ClientErrorReport[] = [];
let uninstall: (() => void) | undefined;
let nativeConsoleError: typeof console.error;
const listeners = new Map<string, Set<(event: unknown) => void>>();

/** Fires a window event at the listeners the reporter put there. */
function fire(type: string, event: object): void {
  for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-08T22:00:00.000Z"));
  reports = [];
  listeners.clear();
  // A page opened with a launch link: its token is in the fragment, a name in the query.
  vi.stubGlobal("window", {
    location: {
      origin: "https://app.example:8443",
      pathname: "/chat",
      search: "?name=private",
      hash: "#token=launch-secret-token",
      href: "https://app.example:8443/chat?name=private#token=launch-secret-token",
    },
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(listener);
    },
    removeEventListener: (type: string, listener: (event: unknown) => void) =>
      listeners.get(type)?.delete(listener),
  });
  nativeConsoleError = console.error;
  // The tests make console.error calls on purpose.
  console.error = vi.fn();
});

afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  setPageErrorSink(undefined);
  console.error = nativeConsoleError;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function connect(): void {
  setPageErrorSink(async (report) => {
    reports.push(report);
  });
}

describe("the page's errors in the debug log", () => {
  test("forwards an uncaught error, an unhandled rejection and a console error, with the page without its fragment or query", () => {
    connect();
    uninstall = installPageErrorReporting();
    fire("error", {
      message: "Uncaught TypeError: x is undefined",
      error: new TypeError("x is undefined"),
    });
    vi.advanceTimersByTime(2_000);
    fire("unhandledrejection", { reason: new RangeError("too deep") });
    vi.advanceTimersByTime(2_000);
    console.error("something broke", new Error("inner"));

    expect(reports.map((report) => report.kind)).toEqual([
      "error",
      "unhandledrejection",
      "console",
    ]);
    expect(reports[0]?.message).toBe("Uncaught TypeError: x is undefined");
    expect(reports[0]?.stack).toContain("TypeError: x is undefined");
    expect(reports[1]?.message).toBe("RangeError: too deep");
    expect(reports[2]?.message).toBe("something broke Error: inner");
    for (const report of reports) expect(report.page).toBe("https://app.example:8443/chat");
    expect(JSON.stringify(reports)).not.toContain("launch-secret-token");
    expect(JSON.stringify(reports)).not.toContain("private");
  });

  test("an error event without a message is told by its error, and one with neither still counts", () => {
    connect();
    uninstall = installPageErrorReporting();
    fire("error", { message: "", error: new SyntaxError("bad token") });
    vi.advanceTimersByTime(2_000);
    fire("error", { message: "" });
    expect(reports.map((report) => report.message)).toEqual([
      "SyntaxError: bad token",
      "Uncaught error",
    ]);
  });

  test("the console error still reaches the real console, and objects are not written out", () => {
    connect();
    const native = vi.fn();
    console.error = native;
    uninstall = installPageErrorReporting();
    console.error("saw", { prompt: "my private words", nested: { more: "secret" } });
    expect(native).toHaveBeenCalledTimes(1);
    expect(reports[0]?.message).toBe("saw [Object]");
    expect(JSON.stringify(reports)).not.toContain("private words");
  });

  test("reports made before the connection wait for it, and the oldest are dropped past twenty", () => {
    uninstall = installPageErrorReporting();
    for (let index = 0; index < 25; index += 1) {
      vi.advanceTimersByTime(2_000);
      reportPageError({ kind: "console", message: `early ${index}` });
    }
    expect(reports).toEqual([]);
    connect();
    expect(reports.map((report) => report.message)).toEqual(
      Array.from({ length: 20 }, (_, index) => `early ${index + 5}`),
    );
  });

  test("the same message repeating within a second is one event; later it is a new one", () => {
    connect();
    vi.advanceTimersByTime(2_000);
    reportPageError({ kind: "console", message: "loop" });
    reportPageError({ kind: "console", message: "loop" });
    vi.advanceTimersByTime(500);
    reportPageError({ kind: "console", message: "loop" });
    expect(reports).toHaveLength(1);
    vi.advanceTimersByTime(600);
    reportPageError({ kind: "console", message: "loop" });
    expect(reports).toHaveLength(2);
  });

  test("a report that fails to send is dropped quietly, never reported again", async () => {
    let attempts = 0;
    setPageErrorSink(async () => {
      attempts += 1;
      throw new Error("socket closed");
    });
    const native = vi.fn();
    console.error = native;
    uninstall = installPageErrorReporting();
    vi.advanceTimersByTime(2_000);
    console.error("first");
    await vi.advanceTimersByTimeAsync(10);
    expect(attempts).toBe(1);
    // The failed report wrote nothing to the console of its own, which would loop.
    expect(native).toHaveBeenCalledTimes(1);
  });

  test("cuts a very long message and stack to what the server takes, and uninstalling restores console.error", () => {
    connect();
    const native = console.error;
    uninstall = installPageErrorReporting();
    expect(console.error).not.toBe(native);
    vi.advanceTimersByTime(2_000);
    reportPageError({ kind: "error", message: "m".repeat(5_000), stack: "s".repeat(20_000) });
    expect(reports[0]?.message).toHaveLength(2_000);
    expect(reports[0]?.stack).toHaveLength(8_000);
    uninstall();
    uninstall = undefined;
    expect(console.error).toBe(native);
  });
});
