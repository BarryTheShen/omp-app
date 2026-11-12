import { describe, expect, test } from "vitest";
import { Follower, NO_TAB_HELD } from "./follow";

describe("the tab the chat's tools act on", () => {
  test("between replies, none, whichever tab is in front", () => {
    const follower = new Follower();
    expect(() => follower.bound()).toThrow(NO_TAB_HELD);
    follower.front(3);
    expect(() => follower.bound()).toThrow(NO_TAB_HELD);
  });

  test("a reply the person began keeps the tab in front then, through omp's start and other tabs, until it ends", () => {
    const follower = new Follower();
    follower.front(3);
    follower.turn(true, true);
    follower.front(7);
    expect(follower.bound()).toBe(3);
    // omp's own start of the reply, after the send that began it, keeps it too.
    follower.turn(true);
    expect(follower.bound()).toBe(3);
    follower.turn(false);
    expect(() => follower.bound()).toThrow(NO_TAB_HELD);
  });

  test("a message sent into a running reply moves nothing: one the person began keeps its tab, one begun elsewhere still holds none", () => {
    const follower = new Follower();
    follower.front(3);
    follower.turn(true, true);
    follower.front(7);
    follower.turn(true, true);
    expect(follower.bound()).toBe(3);
    follower.turn(false);
    // A queued task's reply, or one already running when the panel loaded.
    follower.turn(true);
    follower.turn(true, true);
    expect(() => follower.bound()).toThrow(NO_TAB_HELD);
  });

  test("a reply begun elsewhere acts on no tab, whichever comes to the front; the next one the person begins acts on theirs", () => {
    const follower = new Follower();
    follower.front(3);
    follower.turn(true);
    expect(() => follower.bound()).toThrow(NO_TAB_HELD);
    follower.front(9);
    expect(() => follower.bound()).toThrow(NO_TAB_HELD);
    follower.turn(false);
    follower.turn(true, true);
    expect(follower.bound()).toBe(9);
  });

  test("a reply begun with no tab in front holds none, not the next tab to come to the front", () => {
    const follower = new Follower();
    follower.front(null);
    follower.turn(true, true);
    follower.front(4);
    expect(() => follower.bound()).toThrow(NO_TAB_HELD);
  });
});
