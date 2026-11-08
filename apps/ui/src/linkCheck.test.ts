import type { AppClient, OutageReport } from "@omp-app/client";
import type { ClientTraceReport } from "@omp-app/contracts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TICK_MS, watchLink } from "./linkCheck";

/** A page: its visibility, and the listeners the watcher puts on the document and the window. */
function page() {
  const listeners = new Map<string, Set<() => void>>();
  const target = {
    addEventListener: (type: string, listener: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(listener);
    },
    removeEventListener: (type: string, listener: () => void) =>
      listeners.get(type)?.delete(listener),
  };
  const doc = { visibilityState: "visible" as "visible" | "hidden", ...target };
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", target);
  vi.stubGlobal("navigator", {
    userAgent: "Mozilla/5.0 AppleWebKit/605.1.15 Version/27.0 Safari/605.1.15",
  });
  const fire = (type: string) => {
    for (const listener of [...(listeners.get(type) ?? [])]) listener();
  };
  return {
    hide: () => {
      doc.visibilityState = "hidden";
      fire("visibilitychange");
    },
    show: () => {
      doc.visibilityState = "visible";
      fire("visibilitychange");
    },
    fire,
  };
}

/** A client whose link is in `state`, noting what the watcher asks of it. */
function client(state: "open" | "reconnecting") {
  const asked: string[] = [];
  const traces: ClientTraceReport[] = [];
  let outage: ((report: OutageReport) => void) | undefined;
  const fake = {
    connectionState: state,
    nudge: () => asked.push("nudge"),
    reconnectNow: (cause?: string) => asked.push(`reconnect ${cause}`),
    checkLink: (within: number) => {
      asked.push(`check ${within}`);
      return Promise.resolve(true);
    },
    onOutage: (listener: (report: OutageReport) => void) => {
      outage = listener;
      return () => {
        outage = undefined;
      };
    },
    port: () => ({
      health: () => new Promise(() => {}),
      reportClientTrace: (trace: ClientTraceReport) => {
        traces.push(trace);
        return Promise.resolve();
      },
    }),
  };
  return {
    client: fake as unknown as AppClient,
    asked,
    traces,
    outage: (report: OutageReport) => outage?.(report),
  };
}

const REPORT: OutageReport = {
  cause: "closed",
  closeCode: 1006,
  toWelcomeMs: 420,
  outageMs: 510,
  tries: 1,
  failedTries: 0,
  stalledTries: 0,
  openMs: 300,
  welcomeMs: 420,
  streams: 3,
  resumeMs: 90,
};

describe("the link watcher", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"],
    });
    vi.setSystemTime(1_790_000_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("a page back after longer than the server keeps a silent link reconnects at once, without a check", () => {
    const shown = page();
    const link = client("open");
    const stop = watchLink(link.client);
    shown.hide();
    vi.setSystemTime(Date.now() + 130_000);
    shown.show();
    expect(link.asked).toEqual(["reconnect away"]);
    stop();
  });

  test("a page back after half a minute checks its link first, with 4 seconds for the answer", () => {
    const shown = page();
    const link = client("open");
    const stop = watchLink(link.client);
    shown.hide();
    vi.setSystemTime(Date.now() + 30_000);
    shown.show();
    expect(link.asked).toEqual(["check 4000"]);
    stop();
  });

  test("a clock that jumped while the page was shown means the device slept: the same rule applies", () => {
    page();
    const link = client("open");
    const stop = watchLink(link.client);
    // A laptop asleep for three minutes: its timers did not run, its clock went on.
    vi.setSystemTime(Date.now() + 180_000);
    vi.advanceTimersByTime(TICK_MS);
    expect(link.asked).toEqual(["reconnect away"]);
    stop();
  });

  test("ticks a little late are no sleep", () => {
    page();
    const link = client("open");
    const stop = watchLink(link.client);
    vi.setSystemTime(Date.now() + 8_000);
    vi.advanceTimersByTime(TICK_MS);
    expect(link.asked).toEqual([]);
    stop();
  });

  test("while the link is down, coming back, a focus and being online each send the waiting reconnect at once", () => {
    const shown = page();
    const link = client("reconnecting");
    const stop = watchLink(link.client);
    shown.hide();
    vi.setSystemTime(Date.now() + 30_000);
    shown.show();
    shown.fire("focus");
    shown.fire("online");
    expect(link.asked).toEqual(["nudge", "nudge", "nudge"]);
    stop();
  });

  test("an outage goes to the server's log as a link trace, with the page's return before it", () => {
    const shown = page();
    const link = client("reconnecting");
    const stop = watchLink(link.client);
    shown.hide();
    vi.setSystemTime(Date.now() + 45_000);
    shown.show();
    link.outage(REPORT);
    expect(link.traces).toEqual([
      {
        marks: {
          outage_ms: 510,
          to_welcome_ms: 420,
          tries: 1,
          failed_tries: 0,
          stalled_tries: 0,
          open_ms: 300,
          welcome_ms: 420,
          streams: 3,
          resume_ms: 90,
          close_code: 1006,
          away_ms: 45_000,
        },
        gaps: [],
        supported: ["link", "closed", "browser", "webkit", "shown"],
      },
    ]);
    stop();
  });
});
