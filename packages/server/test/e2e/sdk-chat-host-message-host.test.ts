/**
 * The app a message was sent from (`ctx.ui.messageHost`), end to end on the fake model provider: a prompt's `host`, as
 * the lite view sends it, is what the extensions' input hooks read, and only while they read it; a widget may name the
 * one app whose lite view shows it. Runs from source and compiled (`sdk-chat-host-harness.ts`). Request ids count from
 * 1 in the order a test sends them.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { type Chat, chatHostChats, PROGRAMS, realTest, resultOf } from "./sdk-chat-host-harness";

const chats = chatHostChats();
afterEach(() => chats.stopAll(), 60_000);

/**
 * Adds where each message came from to its text, as an extension adds what a notes app has open; `/widgets` shows a
 * line for the notes app's lite view and one for every view, and says what a hook outside a message reads.
 */
const FROM_EXTENSION = `export default function from(pi) {
  pi.on("input", async (event, ctx) =>
    event.text.startsWith("/") ? undefined : { text: event.text + " (sent from " + (ctx.ui.messageHost ?? "the full app") + ")" });
  pi.registerCommand("widgets", {
    description: "Shows the test's widgets",
    handler: async (_args, ctx) => {
      ctx.ui.setWidget("notes", ["In the notes app"], { host: "siyuan" });
      ctx.ui.setWidget("everywhere", ["In every view"]);
      ctx.ui.notify("between messages: " + String(ctx.ui.messageHost), "info");
    },
  });
}
`;

/** The session's user messages, in order, from `get_entries`. */
async function userTexts(chat: Chat): Promise<string[]> {
  const { entries } = await chat.client.request("get_entries", {});
  return entries.flatMap((entry) => {
    if (entry.type !== "message" || entry.message.role !== "user") return [];
    const { content } = entry.message;
    return [
      typeof content === "string"
        ? content
        : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
    ];
  });
}

describe("the app a message was sent from", () => {
  for (const program of PROGRAMS) {
    const programTest = program.command === undefined ? test.skip : realTest;
    const command = program.command ?? [];

    programTest(
      `${program.name}: the input hooks read a message's host, only while they read it, and a widget keeps the app it names`,
      async () => {
        const chat = await chats.start(command, {
          agentFiles: { "extensions/from.ts": FROM_EXTENSION },
          nativeDiscovery: true,
        });
        expect((await chat.client.hello).features).toContain("message_host");

        await chat.client.request("prompt", { text: "first", host: "siyuan" });
        await chat.next(resultOf("1"));
        await chat.client.request("prompt", { text: "second" });
        await chat.next(resultOf("2"));
        expect(await userTexts(chat)).toEqual([
          "first (sent from siyuan)",
          "second (sent from the full app)",
        ]);

        const before = chat.events.length;
        await chat.client.request("prompt", { text: "/widgets", host: "siyuan" });
        const notice = await chat.next(
          (event) =>
            event.type === "ui_notify" &&
            chat.events.findIndex((entry) => entry.event === event) >= before,
        );
        // The command runs after the hooks read the message: no message is being read then.
        expect(notice.type === "ui_notify" ? notice.message : "").toBe("between messages: null");
        const widgets = chat.events
          .map((entry) => entry.event)
          .filter(
            (event) =>
              event.type === "ui_widget" &&
              (event.widgetKey === "notes" || event.widgetKey === "everywhere"),
          );
        expect(widgets).toEqual([
          {
            type: "ui_widget",
            widgetKey: "notes",
            widgetLines: ["In the notes app"],
            widgetHost: "siyuan",
          },
          { type: "ui_widget", widgetKey: "everywhere", widgetLines: ["In every view"] },
        ]);

        // A host that is not an app's name is refused, as any malformed request is.
        await expect(
          chat.client.request("prompt", { text: "third", host: "Not a name!" }),
        ).rejects.toThrow();
      },
      90_000,
    );
  }
});
