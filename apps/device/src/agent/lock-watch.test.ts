import { describe, expect, test } from "bun:test";
import { type LockEvent, lockEventOf, watchLock } from "./lock-watch";

/** Lines as `gdbus monitor` prints them: `<path>: <interface>.<member> <arguments>` (GLib's gdbus-tool.c). */
const LOCK = "/org/freedesktop/login1/session/_32: org.freedesktop.login1.Session.Lock ()";
const LOCKED_HINT =
  "/org/freedesktop/login1/session/_32: org.freedesktop.DBus.Properties.PropertiesChanged ('org.freedesktop.login1.Session', {'IdleHint': <false>, 'LockedHint': <true>}, @as [])";
const SLEEP = "/org/freedesktop/login1: org.freedesktop.login1.Manager.PrepareForSleep (true,)";

describe("access turns off on screen lock and sleep (#20)", () => {
  test("a lock, the locked hint and going to sleep turn access off; waking, unlocking and other signals do not", () => {
    expect(lockEventOf(LOCK)).toBe("locked");
    expect(lockEventOf(LOCKED_HINT)).toBe("locked");
    expect(lockEventOf(SLEEP)).toBe("sleeping");
    expect(lockEventOf(SLEEP.replace("(true,)", "(false,)"))).toBeNull();
    expect(lockEventOf(LOCKED_HINT.replace("<true>", "<false>"))).toBeNull();
    expect(lockEventOf(LOCK.replace(".Lock ", ".Unlock "))).toBeNull();
    expect(
      lockEventOf(
        "/org/freedesktop/login1: org.freedesktop.login1.Manager.SessionNew ('33', objectpath '/org/freedesktop/login1/session/_33')",
      ),
    ).toBeNull();
  });

  test("the monitor's lines are read as they come, while it keeps running", async () => {
    const heard: LockEvent[] = [];
    const stop = watchLock(
      (event) => heard.push(event),
      () => undefined,
      [
        "sh",
        "-c",
        `echo 'The name org.freedesktop.login1 is owned by :1.5'; echo "${LOCK}"; sleep 30`,
      ],
    );
    try {
      const end = Date.now() + 5_000;
      while (heard.length === 0 && Date.now() < end) await Bun.sleep(25);
      expect(heard).toEqual(["locked"]);
    } finally {
      stop();
    }
  });
});
