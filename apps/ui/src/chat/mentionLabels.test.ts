import { expect, test } from "vitest";
import { expandMentions, shortenMentions } from "./mentionLabels";

test("a picked mention shows as its label, the caret stays after it, and the message goes out with the link", () => {
  const kept = new Map<string, string>();
  const link = "@[Birthday menu](siyuan:20261118234433-s84elov)";
  const box = `plan the ${link} for Sunday`;
  const caret = `plan the ${link} `.length;
  const shown = shortenMentions(box, caret, kept);
  expect(shown.text).toBe("plan the @Birthday menu for Sunday");
  expect(shown.text.slice(0, shown.caret)).toBe("plan the @Birthday menu ");
  expect(expandMentions(`${shown.text} please`, kept)).toBe(`${box} please`);
});

test("only whole labels come back: an edited label, or a longer word, stays as typed", () => {
  const kept = new Map<string, string>();
  shortenMentions("@[Menu](siyuan:1) @[Menu 2](siyuan:2)", 0, kept);
  expect(expandMentions("@Menu and @Menu 2, then @Menus", kept)).toBe(
    "@[Menu](siyuan:1) and @[Menu 2](siyuan:2), then @Menus",
  );
  expect(expandMentions("@Birthday", new Map())).toBe("@Birthday");
});
