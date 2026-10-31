import { describe, expect, test } from "bun:test";
import { PAIRING_CODE_TRIES, PAIRING_REQUEST_MS } from "@omp-app/contracts";
import { PairingDesk, WAITING_REQUESTS_MAX } from "./pairing";

/** A desk on a clock the test moves. */
function deskAt(start = 1_000_000) {
  let now = start;
  const desk = new PairingDesk({ now: () => now });
  return {
    desk,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("pairing by a paired device's answer", () => {
  test("a request waits, is listed with its 6 digits, and once allowed gives the asking device its name and kind, once", () => {
    const { desk } = deskAt();
    const asked = desk.ask("iPhone · Home Screen app", "home-screen-app");
    if (asked === "busy") throw new Error("busy");
    expect(asked.code).toMatch(/^\d{6}$/);
    expect(desk.claim(asked.requestId)).toEqual({ status: "waiting" });
    const [listed] = desk.waiting();
    expect(listed).toMatchObject({ name: "iPhone · Home Screen app", code: asked.code });
    // The list shows a request by its id, never by the secret that collects the key.
    expect(listed?.id).not.toBe(asked.requestId);

    expect(desk.allow(listed?.id ?? "")).toBe(true);
    expect(desk.waiting()).toEqual([]);
    expect(desk.claim(asked.requestId)).toEqual({
      status: "allowed",
      name: "iPhone · Home Screen app",
      kind: "home-screen-app",
    });
    // Collected once: the same secret gets nothing more.
    expect(desk.claim(asked.requestId)).toEqual({ status: "expired" });
  });

  test("a denied request says so to the asking device once; an answered request takes no second answer", () => {
    const { desk } = deskAt();
    const asked = desk.ask("Laptop", "browser");
    if (asked === "busy") throw new Error("busy");
    const id = desk.waiting()[0]?.id ?? "";
    expect(desk.deny(id)).toBe(true);
    expect(desk.allow(id)).toBe(false);
    expect(desk.claim(asked.requestId)).toEqual({ status: "denied" });
    expect(desk.claim(asked.requestId)).toEqual({ status: "expired" });
  });

  test("an unanswered request ends after 5 minutes: it leaves the list and can no longer be allowed or collected", () => {
    const { desk, advance } = deskAt();
    const asked = desk.ask("Laptop", "browser");
    if (asked === "busy") throw new Error("busy");
    const id = desk.waiting()[0]?.id ?? "";
    advance(PAIRING_REQUEST_MS);
    expect(desk.waiting()).toEqual([]);
    expect(desk.allow(id)).toBe(false);
    expect(desk.claim(asked.requestId)).toEqual({ status: "expired" });
    desk.dispose();
  });

  test("at most 5 requests wait at once; one that ends makes room", () => {
    const { desk } = deskAt();
    for (let n = 0; n < WAITING_REQUESTS_MAX; n++)
      expect(desk.ask(`d${n}`, "browser")).not.toBe("busy");
    expect(desk.ask("one more", "browser")).toBe("busy");
    expect(desk.deny(desk.waiting()[0]?.id ?? "")).toBe(true);
    expect(desk.ask("one more", "browser")).not.toBe("busy");
    desk.dispose();
  });

  test("the paired devices hear each new request and each answer", () => {
    const { desk } = deskAt();
    let heard = 0;
    desk.subscribe(() => {
      heard += 1;
    });
    desk.ask("Laptop", "browser");
    desk.allow(desk.waiting()[0]?.id ?? "");
    expect(heard).toBe(2);
    desk.dispose();
  });
});

describe("pairing with a one-time code", () => {
  test("the code pairs once, typed in any case, with or without its dash", () => {
    const { desk } = deskAt();
    const { code } = desk.newCode();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    const typed = `${code.slice(0, 4).toLowerCase()}-${code.slice(4)}`;
    expect(desk.enterCode(typed)).toEqual({ status: "ok" });
    expect(desk.enterCode(code)).toEqual({ status: "expired" });
  });

  test("5 wrong entries end the code; it then fails even when right", () => {
    const { desk } = deskAt();
    const { code } = desk.newCode();
    const wrong = code === "AAAAAAAA" ? "BBBBBBBB" : "AAAAAAAA";
    for (let left = PAIRING_CODE_TRIES - 1; left >= 0; left--) {
      expect(desk.enterCode(wrong)).toEqual({ status: "wrong", triesLeft: left });
    }
    expect(desk.enterCode(code)).toEqual({ status: "expired" });
  });

  test("a code ends after 10 minutes, and a new one replaces the one before", () => {
    const { desk, advance } = deskAt();
    const first = desk.newCode().code;
    const second = desk.newCode().code;
    if (first !== second)
      expect(desk.enterCode(first)).toEqual({ status: "wrong", triesLeft: PAIRING_CODE_TRIES - 1 });
    advance(10 * 60_000);
    expect(desk.enterCode(second)).toEqual({ status: "expired" });
  });

  test("with no code made, every entry is expired and uses nothing up", () => {
    const { desk } = deskAt();
    expect(desk.enterCode("K7F3-QX9M")).toEqual({ status: "expired" });
  });
});
