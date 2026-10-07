import type { ClientErrorReport } from "@omp-app/contracts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  installClientErrorReporting,
  reportClientError,
  setClientErrorSink,
} from "./client-errors";

let reports: ClientErrorReport[] = [];
let uninstall: (() => void) | undefined;
let nativeConsoleError: typeof console.error;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-07T07:00:00.000Z"));
  reports = [];
  nativeConsoleError = console.error;
  // The tests make console.error calls on purpose.
  console.error = vi.fn();
  window.history.replaceState(null, "", "/chat?name=private#token=launch-secret-token");
});

afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  setClientErrorSink(undefined);
  console.error = nativeConsoleError;
  vi.useRealTimers();
});

function connect(): void {
  setClientErrorSink(async (report) => {
    reports.push(report);
  });
}

describe("page error reporting", () => {
  test("forwards an uncaught error, an unhandled rejection and a console error, with the page without its fragment or query", () => {
    connect();
    uninstall = installClientErrorReporting();
    window.dispatchEvent(
      new ErrorEvent("error", {
        message: "Uncaught TypeError: x is undefined",
        error: new TypeError("x is undefined"),
      }),
    );
    vi.advanceTimersByTime(2_000);
    const rejection = new Event("unhandledrejection") as PromiseRejectionEvent;
    Object.defineProperty(rejection, "reason", { value: new RangeError("too deep") });
    window.dispatchEvent(rejection);
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
    for (const report of reports) {
      expect(report.page).toBe("http://localhost:3000/chat");
    }
    expect(JSON.stringify(reports)).not.toContain("launch-secret-token");
    expect(JSON.stringify(reports)).not.toContain("private");
  });

  test("the console error still reaches the real console, and objects are not written out", () => {
    connect();
    const native = vi.fn();
    console.error = native;
    uninstall = installClientErrorReporting();
    console.error("saw", { prompt: "my private words", nested: { more: "secret" } });
    expect(native).toHaveBeenCalledTimes(1);
    expect(reports[0]?.message).toBe("saw [Object]");
    expect(JSON.stringify(reports)).not.toContain("private words");
  });

  test("reports made before the connection wait for it, and the oldest are dropped past twenty", () => {
    uninstall = installClientErrorReporting();
    for (let index = 0; index < 25; index += 1) {
      vi.advanceTimersByTime(2_000);
      reportClientError({ kind: "console", message: `early ${index}` });
    }
    expect(reports).toEqual([]);
    connect();
    expect(reports.map((report) => report.message)).toEqual(
      Array.from({ length: 20 }, (_, index) => `early ${index + 5}`),
    );
  });

  test("the same message repeating within a second is one event; later it is a new one", () => {
    connect();
    reportClientError({ kind: "console", message: "loop" });
    reportClientError({ kind: "console", message: "loop" });
    vi.advanceTimersByTime(500);
    reportClientError({ kind: "console", message: "loop" });
    expect(reports).toHaveLength(1);
    vi.advanceTimersByTime(600);
    reportClientError({ kind: "console", message: "loop" });
    expect(reports).toHaveLength(2);
  });

  test("a report that fails to send is dropped quietly, never reported again", async () => {
    let attempts = 0;
    setClientErrorSink(async () => {
      attempts += 1;
      throw new Error("socket closed");
    });
    uninstall = installClientErrorReporting();
    console.error("first");
    await vi.advanceTimersByTimeAsync(10);
    // The failure of the report did not produce a console error of its own, which would loop.
    expect(attempts).toBe(1);
  });

  test("cuts a very long message and stack to what the server accepts, and uninstalling restores console.error", () => {
    connect();
    const native = console.error;
    uninstall = installClientErrorReporting();
    expect(console.error).not.toBe(native);
    reportClientError({ kind: "error", message: "m".repeat(5_000), stack: "s".repeat(20_000) });
    expect(reports[0]?.message).toHaveLength(2_000);
    expect(reports[0]?.stack).toHaveLength(8_000);
    uninstall();
    uninstall = undefined;
    expect(console.error).toBe(native);
  });
});
