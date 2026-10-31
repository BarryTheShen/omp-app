import { describe, expect, test } from "bun:test";
import { type Clock, type ServerLink, startHandback } from "./handback";

/** A clock the test moves by hand. */
function manualClock() {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const clock: Clock = {
    setTimeout: (run, ms) => {
      const id = ++next;
      timers.set(id, { at: now + ms, run });
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  };
  return {
    clock,
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...timers]
          .filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = until;
    },
  };
}

/** The server's connection, which the test opens and closes. */
function serverLink(connected: boolean) {
  let state = connected;
  const listeners = new Set<(connected: boolean) => void>();
  const link: ServerLink = {
    connected: () => state,
    onConnection(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    link,
    set(next: boolean) {
      state = next;
      for (const listener of listeners) listener(next);
    },
  };
}

describe("startHandback", () => {
  test("two minutes without a server, the settled chat is handed back once", () => {
    const { clock, advance } = manualClock();
    const server = serverLink(true);
    let handedBack = 0;
    startHandback({ link: server.link, settled: () => true, handBack: () => handedBack++, clock });
    server.set(false);
    advance(119_999);
    expect(handedBack).toBe(0);
    advance(1);
    expect(handedBack).toBe(1);
    advance(600_000);
    expect(handedBack).toBe(1);
  });

  test("a server that comes back in time keeps the chat", () => {
    const { clock, advance } = manualClock();
    const server = serverLink(true);
    let handedBack = 0;
    startHandback({ link: server.link, settled: () => true, handBack: () => handedBack++, clock });
    server.set(false);
    advance(60_000);
    server.set(true);
    advance(600_000);
    expect(handedBack).toBe(0);
  });

  test("a turn that runs is finished first", () => {
    const { clock, advance } = manualClock();
    const server = serverLink(false);
    let running = true;
    let handedBack = 0;
    startHandback({
      link: server.link,
      settled: () => !running,
      handBack: () => handedBack++,
      clock,
    });
    advance(120_000 + 30_000);
    expect(handedBack).toBe(0);
    running = false;
    advance(5_000);
    expect(handedBack).toBe(1);
  });

  test("stopped, it hands nothing back", () => {
    const { clock, advance } = manualClock();
    const server = serverLink(false);
    let handedBack = 0;
    const stop = startHandback({
      link: server.link,
      settled: () => true,
      handBack: () => handedBack++,
      clock,
    });
    stop();
    advance(600_000);
    expect(handedBack).toBe(0);
  });
});
