import { beforeEach, describe, expect, test } from "vitest";
import {
  DRAWN_NOTICES_STORAGE_KEY,
  type DrawnNoticeStorage,
  MAX_DRAWN_NOTICES,
  sessionDrawnNotices,
} from "../../feedback/drawn-notices";

const streamKey = "extension:notify:12:0a1b2c";
const otherKey = "session:notice:3:9f8e7d";

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("the drawn notices of a tab", () => {
  test("a notice drawn before a reload is restored, so it does not fade in again", () => {
    sessionDrawnNotices().drew(streamKey);
    expect(sessionDrawnNotices().isRestored(streamKey)).toBe(true);
  });

  test("a notice the tab has not drawn before is not restored, so it fades in", () => {
    sessionDrawnNotices().drew(streamKey);
    expect(sessionDrawnNotices().isRestored(otherKey)).toBe(false);
  });

  test("a notice drawn in this page is not restored, so its fade decision never changes while it is drawn", () => {
    const page = sessionDrawnNotices();
    page.drew(streamKey);
    expect(page.isRestored(streamKey)).toBe(false);
  });

  test("a notice that left is forgotten, so it fades in again when it comes back", () => {
    const page = sessionDrawnNotices();
    page.drew(streamKey);
    page.left(streamKey);
    expect(sessionDrawnNotices().isRestored(streamKey)).toBe(false);
  });

  test("a notice restored by a reload fades in again when it leaves and comes back in the same page", () => {
    sessionDrawnNotices().drew(streamKey);
    const reloaded = sessionDrawnNotices();
    expect(reloaded.isRestored(streamKey)).toBe(true);
    reloaded.left(streamKey);
    expect(reloaded.isRestored(streamKey)).toBe(false);
    reloaded.drew(streamKey);
    expect(reloaded.isRestored(streamKey)).toBe(false);
    expect(sessionDrawnNotices().isRestored(streamKey)).toBe(true);
  });

  test("the most recent drawn notices are kept, and the oldest are dropped", () => {
    const page = sessionDrawnNotices();
    for (let index = 0; index <= MAX_DRAWN_NOTICES; index += 1) {
      page.drew(`extension:notify:${index}:aaaaaa`);
    }
    const reloaded = sessionDrawnNotices();
    expect(reloaded.isRestored("extension:notify:0:aaaaaa")).toBe(false);
    expect(reloaded.isRestored(`extension:notify:${MAX_DRAWN_NOTICES}:aaaaaa`)).toBe(true);
  });

  test("damaged storage restores nothing, and storage that refuses writes does not throw", () => {
    window.sessionStorage.setItem(DRAWN_NOTICES_STORAGE_KEY, "{not json");
    expect(sessionDrawnNotices().isRestored(streamKey)).toBe(false);
    const refusing: DrawnNoticeStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("storage is full");
      },
    };
    const memory = sessionDrawnNotices(refusing);
    expect(() => memory.drew(streamKey)).not.toThrow();
    expect(memory.isRestored(streamKey)).toBe(false);
  });

  test("a tab whose storage is blocked draws notices and restores none", () => {
    const memory = sessionDrawnNotices(null);
    expect(() => memory.drew(streamKey)).not.toThrow();
    expect(memory.isRestored(streamKey)).toBe(false);
    expect(sessionDrawnNotices(null).isRestored(streamKey)).toBe(false);
  });
});
