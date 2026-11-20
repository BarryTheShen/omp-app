import { describe, expect, test } from "bun:test";
import { splitAppNotice, withAppNotice } from "../src/index";

describe("a notice put into a chat by something other than the person", () => {
  test("comes back whole with where it came from, tags, quotes and entities in its text included", () => {
    const text = 'New issue #42: "PDF" & <canvas> </app-notice> stays text\nsecond line';
    const message = withAppNotice("issue-watch", text);
    expect(splitAppNotice(message)).toEqual({ source: "issue-watch", text });
    // Its text cannot close the block early.
    expect(message.match(/<\/app-notice>/g)).toHaveLength(1);
  });

  test("the person's own words are never a notice, also when they start or quote one", () => {
    const notice = withAppNotice("wake", "hello");
    expect(splitAppNotice("hello")).toBeNull();
    expect(splitAppNotice(`look at this:\n\n${notice}`)).toBeNull();
    expect(splitAppNotice(`${notice}\nand more`)).toBeNull();
    expect(splitAppNotice('<app-notice source="wake">\nhi <b>\n</app-notice>')).toBeNull();
    expect(splitAppNotice('<app-notice source="Not Valid">\nhi\n</app-notice>')).toBeNull();
  });

  test("a writer cannot send an empty notice or one from an unnamed source", () => {
    expect(() => withAppNotice("wake", "  ")).toThrow();
    expect(() => withAppNotice("", "hi")).toThrow();
    expect(() => withAppNotice('a" onclick="x', "hi")).toThrow();
  });
});
