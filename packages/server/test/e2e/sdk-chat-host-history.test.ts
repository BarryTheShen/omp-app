/**
 * The chat host's history and session changes (SDK plan H5.2c), end to end on the fake model provider: entries, the
 * tree, message pages, new chat, branch, fork and rewind in place (#2692). Runs from source and compiled
 * (`sdk-chat-host-harness.ts`). Request ids count from 1 in the order a test sends them.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  type Chat,
  chatHostChats,
  lastReply,
  PROGRAMS,
  realTest,
  resultOf,
} from "./sdk-chat-host-harness";

const chats = chatHostChats();
afterEach(() => chats.stopAll(), 60_000);

/** The session's user prompts, with their entry ids and parents, from `get_entries`. */
async function userPrompts(chat: Chat) {
  const { entries } = await chat.client.request("get_entries", {});
  return entries.flatMap((entry) => {
    if (entry.type !== "message" || entry.message.role !== "user") return [];
    const { content } = entry.message;
    const text =
      typeof content === "string"
        ? content
        : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
    return [{ id: entry.id, parentId: entry.parentId, text }];
  });
}

describe("the chat host's history and session changes", () => {
  for (const program of PROGRAMS) {
    const programTest = program.command === undefined ? test.skip : realTest;
    const command = program.command ?? [];

    programTest(
      `${program.name}: entries read from a cursor, the tree has the same leaf, and an unknown cursor is unknown_since`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        await chat.client.request("prompt", { text: "hello" });
        await chat.next(resultOf("1"));
        const all = await chat.client.request("get_entries", {});
        expect(all.leafId).toBe(all.entries.at(-1)?.id ?? null);
        const first = all.entries[0];
        const after = await chat.client.request("get_entries", { since: first?.id });
        expect(after.entries).toEqual(all.entries.slice(1));
        await expect(
          chat.client.request("get_entries", { since: "deadbeef" }),
        ).rejects.toMatchObject({
          code: "unknown_since",
        });
        const tree = await chat.client.request("get_tree", {});
        expect(tree.leafId).toBe(all.leafId);
        expect(tree.tree.length).toBeGreaterThan(0);
        const { messages } = await chat.client.request("get_branch_messages", {});
        expect(messages.map((message) => message.text)).toEqual(["hello"]);
      },
      60_000,
    );

    programTest(
      `${program.name}: messages page through in order, and a cursor from before the next turn is stale`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        await chat.client.request("prompt", { text: "one" });
        await chat.next(resultOf("1"));
        await chat.client.request("prompt", { text: "two" });
        await chat.next(resultOf("2"));
        const whole = await chat.client.request("get_messages_page", { limit: 256 });
        const first = await chat.client.request("get_messages_page", { limit: 3 });
        const rest = await chat.client.request("get_messages_page", { cursor: first.nextCursor });
        expect([...first.messages, ...rest.messages]).toEqual(whole.messages);
        expect(rest.nextCursor).toBeUndefined();
        await chat.client.request("prompt", { text: "three" });
        await chat.next(resultOf("6"));
        await expect(
          chat.client.request("get_messages_page", { cursor: first.nextCursor }),
        ).rejects.toMatchObject({ code: "stale_cursor" });
      },
      60_000,
    );

    programTest(
      `${program.name}: while a reply streams, a fork, a rewind and a page are refused as busy`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        await chat.client.request("prompt", { text: "hello" });
        await chat.next(resultOf("1"));
        const [prompt] = await userPrompts(chat);
        // The first prompt's reply already sent updates: wait for the held reply's own, so the requests below meet it.
        const mark = chat.events.length;
        await chat.client.request("prompt", { text: "stream_held" });
        await chat.nextAfter(mark, (event) => event.type === "message_update");
        const entryId = prompt?.id ?? "";
        // One at a time: a refusal answered before its `expect` was attached would count as unhandled.
        await expect(chat.client.request("fork", { entryId })).rejects.toMatchObject({
          code: "session_busy",
        });
        await expect(chat.client.request("navigate_tree", { entryId })).rejects.toMatchObject({
          code: "session_busy",
        });
        await expect(chat.client.request("get_messages_page", {})).rejects.toMatchObject({
          code: "session_busy",
        });
        await chat.client.request("abort", {});
      },
      60_000,
    );

    programTest(
      `${program.name}: a rewind to the second prompt gives its text back, moves the leaf before it, and the chat goes on from there (#2692)`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        await chat.client.request("prompt", { text: "first apple" });
        await chat.next(resultOf("1"));
        await chat.client.request("prompt", { text: "second zebra" });
        await chat.next(resultOf("2"));
        const { sessionFile } = await chat.client.request("get_state", {});
        const second = (await userPrompts(chat)).find((prompt) => prompt.text === "second zebra");
        expect(second).toBeDefined();
        const rewound = await chat.client.request("navigate_tree", { entryId: second?.id ?? "" });
        expect(rewound).toMatchObject({
          cancelled: false,
          editorText: "second zebra",
          leafId: second?.parentId,
        });
        expect((await chat.client.request("get_entries", {})).leafId).toBe(
          second?.parentId ?? null,
        );
        expect((await chat.client.request("get_state", {})).sessionFile).toBe(sessionFile);
        await chat.client.request("prompt", { text: "context_has zebra" });
        await chat.next(resultOf("8"));
        expect(lastReply(chat)).toBe("context lacks zebra");
        await chat.client.request("prompt", { text: "context_has apple" });
        await chat.next(resultOf("9"));
        expect(lastReply(chat)).toBe("context has apple");
      },
      60_000,
    );

    programTest(
      `${program.name}: a fork and a new chat open new session files, and a branch gives its prompt's text back`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        await chat.client.request("prompt", { text: "hello" });
        await chat.next(resultOf("1"));
        const [prompt] = await userPrompts(chat);
        const before = await chat.client.request("get_state", {});
        expect(await chat.client.request("fork", { entryId: prompt?.id ?? "" })).toEqual({
          cancelled: false,
        });
        const forked = await chat.client.request("get_state", {});
        expect(forked.sessionFile).not.toBe(before.sessionFile);
        const [forkedPrompt] = await userPrompts(chat);
        expect(await chat.client.request("branch", { entryId: forkedPrompt?.id ?? "" })).toEqual({
          text: "hello",
          cancelled: false,
        });
        expect(await chat.client.request("new_session", {})).toEqual({ cancelled: false });
        const fresh = await chat.client.request("get_state", {});
        expect(fresh.messageCount).toBe(0);
        expect(fresh.sessionId).not.toBe(forked.sessionId);
      },
      60_000,
    );

    programTest(
      `${program.name}: a new chat ends the reply still streaming in the old one as aborted`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        await chat.client.request("prompt", { text: "stream_held" });
        await chat.next((event) => event.type === "message_update");
        expect(await chat.client.request("new_session", {})).toEqual({ cancelled: false });
        expect(await chat.next(resultOf("1"))).toMatchObject({ status: "aborted" });
      },
      60_000,
    );
  }
});
