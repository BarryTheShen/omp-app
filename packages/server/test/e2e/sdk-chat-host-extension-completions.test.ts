/**
 * Extensions' rows for the message box's `@` menu (`extension_completions`): an extension stacks an autocomplete
 * provider as in omp's terminal (`ctx.ui.addAutocompleteProvider` at `session_start`), and the chat host answers each
 * row with the box's text and caret once the row is taken. Runs from source and compiled (`sdk-chat-host-harness.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chatHostChats, PROGRAMS, realTest } from "./sdk-chat-host-harness";

const chats = chatHostChats();
afterEach(() => chats.stopAll(), 60_000);

/**
 * Offers two notes after an `@word` on the caret's line (its prefix), and keeps what the provider below it offers; a
 * second extension's factory throws, and a third returns no provider: both are skipped, as omp skips them.
 */
const NOTES_EXTENSION = `const NOTES = [{ id: "n1", title: "Lab report" }, { id: "n2", title: "Lab safety" }];
export default function notes(pi) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.addAutocompleteProvider((current) => ({
      ...current,
      async getSuggestions(lines, line, col, signal) {
        const at = /@(\\w+)$/.exec(lines[line].slice(0, col));
        if (!at) return current.getSuggestions(lines, line, col, signal);
        const hits = NOTES.filter((note) => note.title.toLowerCase().includes(at[1].toLowerCase()));
        return { prefix: at[0], items: hits.map((note) => ({ value: note.id, label: note.title, description: "note " + note.id })) };
      },
      applyCompletion(lines, line, col, item, prefix) {
        const next = [...lines];
        const start = col - prefix.length;
        const insert = "@[" + item.label + "](note:" + item.value + ") ";
        next[line] = lines[line].slice(0, start) + insert + lines[line].slice(col);
        return { lines: next, cursorLine: line, cursorCol: start + insert.length };
      },
    }));
    ctx.ui.addAutocompleteProvider(() => { throw new Error("broken provider"); });
    ctx.ui.addAutocompleteProvider(() => ({}));
  });
}
`;

describe("extensions' rows for the @ menu", () => {
  for (const program of PROGRAMS) {
    const programTest = program.command === undefined ? test.skip : realTest;
    const command = program.command ?? [];

    programTest(
      `${program.name}: an extension's rows come with the box as taking each would leave it, on any line`,
      async () => {
        const chat = await chats.start(command, {
          agentFiles: { "extensions/notes.ts": NOTES_EXTENSION },
          nativeDiscovery: true,
        });
        await chat.client.hello;
        const text = "first line\nsee @lab please";
        const caret = text.indexOf(" please");
        expect(await chat.client.request("extension_completions", { text, caret })).toEqual({
          items: [
            {
              label: "Lab report",
              detail: "note n1",
              text: "first line\nsee @[Lab report](note:n1)  please",
              caret: "first line\nsee @[Lab report](note:n1) ".length,
            },
            {
              label: "Lab safety",
              detail: "note n2",
              text: "first line\nsee @[Lab safety](note:n2)  please",
              caret: "first line\nsee @[Lab safety](note:n2) ".length,
            },
          ],
        });
        // Nothing to offer: no rows.
        expect(await chat.client.request("extension_completions", { text: "plain words", caret: 5 })).toEqual({
          items: [],
        });
        expect(await chat.client.request("extension_completions", { text: "@safety", caret: 7 })).toEqual({
          items: [{ label: "Lab safety", detail: "note n2", text: "@[Lab safety](note:n2) ", caret: 23 }],
        });
      },
      60_000,
    );

    programTest(
      `${program.name}: without an extension that adds to the menus, no rows`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        expect(await chat.client.request("extension_completions", { text: "@lab", caret: 4 })).toEqual({ items: [] });
      },
      60_000,
    );
  }
});
