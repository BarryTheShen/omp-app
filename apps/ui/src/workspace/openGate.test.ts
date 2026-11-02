import { describe, expect, test } from "vitest";
import { OpenGate } from "./openGate";

/** Whether the promise has settled by the time the microtasks queued now have run. */
async function settled(promise: Promise<void>): Promise<boolean> {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  return done;
}

describe("when a pane opens its chat (#2768)", () => {
  test("on a desktop every pane opens at once", async () => {
    const gate = new OpenGate(true);
    expect(await settled(gate.wait("a"))).toBe(true);
    expect(await settled(gate.wait("b"))).toBe(true);
  });

  test("on a phone a pane waits until it is in front; the pane in front opens, also its next chats", async () => {
    const gate = new OpenGate(false);
    const behind = gate.wait("behind");
    gate.allow("front");
    expect(await settled(gate.wait("front"))).toBe(true);
    expect(await settled(gate.wait("front"))).toBe(true);
    expect(await settled(behind)).toBe(false);
    gate.allow("behind");
    expect(await settled(behind)).toBe(true);
  });

  test("leaving the phone layout opens every pane that waited; a closed pane waits no more", async () => {
    const gate = new OpenGate(false);
    const first = gate.wait("first");
    const closed = gate.wait("closed");
    gate.forget("closed");
    gate.setEveryPane(true);
    expect(await settled(first)).toBe(true);
    expect(await settled(closed)).toBe(false);
  });
});
