import { expect, test } from "bun:test";
import { splitHostContext, withHostContext, withMentions } from "../src/index";

const page = {
  title: 'Birthday "menu" <draft>',
  uri: "siyuan://blocks/20261118234433-s84elov",
  content:
    '红烧牛腩 / Red-braised beef\n{: id="20261118234433-6oumwix"}\nnot the end: </mention> </mentions>',
};

test("a message's mentions come back as tags only, whatever their content holds, also before a host context", () => {
  const typed = "plan the @[Birthday menu](siyuan:20261118234433-s84elov) for Sunday";
  const sent = withHostContext(
    withMentions(typed, "siyuan", "A line for the model.", [page]),
    "siyuan",
    {
      kind: "page",
      title: "Journal",
    },
  );
  // The model gets all of it.
  expect(sent).toContain("红烧牛腩 / Red-braised beef");
  const read = splitHostContext(sent);
  expect(read.text).toBe(typed);
  expect(read.context?.title).toBe("Journal");
  expect(read.mentions).toEqual({
    source: "siyuan",
    items: [{ title: page.title, uri: page.uri }],
  });
  // Without a host context, and with nothing typed.
  expect(splitHostContext(withMentions("", "siyuan", "", [page])).text).toBe("");
});

test("messages sent before this format (the SiYuan extension's <siyuan-context>) read back the same way", () => {
  const sent = [
    "what's on @[Birthday menu](siyuan:20261118234433-s84elov)?",
    "",
    "<siyuan-context>",
    "The person mentioned these SiYuan pages/blocks; …",
    "",
    '### SiYuan page "Birthday menu" (id 20261118234433-s84elov)',
    "Path: /Notes/Notebooks/Miscellaneous/Birthday menu",
    "",
    "红烧牛腩 / Red-braised beef brisket",
    "</siyuan-context>",
  ].join("\n");
  const read = splitHostContext(sent);
  expect(read.text).toBe("what's on @[Birthday menu](siyuan:20261118234433-s84elov)?");
  expect(read.mentions?.items).toEqual([
    { title: "Birthday menu", uri: "siyuan://blocks/20261118234433-s84elov" },
  ]);
  // A message that only talks about the tag is left alone.
  expect(splitHostContext("what does </siyuan-context> mean?").mentions).toBeNull();
});
