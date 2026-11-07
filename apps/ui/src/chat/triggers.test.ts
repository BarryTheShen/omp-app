import type { ChatHostCommand } from "@omp-app/contracts/chat-host";
import { describe, expect, test } from "vitest";
import {
  askedAs,
  findTrigger,
  folderMention,
  matchCommands,
  mentionText,
  rebaseRow,
  replaceTrigger,
  shellRun,
} from "./triggers";

describe("findTrigger", () => {
  test("a `/` command is the box's first word, up to the caret", () => {
    expect(findTrigger("/mo", 3)).toEqual({ kind: "command", query: "mo", start: 0, end: 3 });
    // The rest of the word under the caret is replaced too.
    expect(findTrigger("/model", 2)).toEqual({ kind: "command", query: "m", start: 0, end: 6 });
    // Once the command has a space after it, its arguments are being typed.
    expect(findTrigger("/model fake", 11)).toBeNull();
    // A slash later in the text is not a command.
    expect(findTrigger("see /etc", 8)).toBeNull();
  });

  test("an `@` mention starts a word anywhere and runs to the caret", () => {
    expect(findTrigger("look at @src/pa", 15)).toEqual({
      kind: "file",
      form: "word",
      query: "src/pa",
      start: 8,
      end: 15,
    });
    expect(findTrigger("@", 1)).toEqual({
      kind: "file",
      form: "word",
      query: "",
      start: 0,
      end: 1,
    });
    // On the caret's line.
    expect(findTrigger("first\n@lec", 10)).toEqual({
      kind: "file",
      form: "word",
      query: "lec",
      start: 6,
      end: 10,
    });
    // An address is not a mention: the `@` does not start a word.
    expect(findTrigger("mail me@home", 12)).toBeNull();
  });

  test('`@"` starts a name in quotes, open up to its closing quote, which a pick replaces too (#2846)', () => {
    expect(findTrigger('see @"lecture 3', 15)).toEqual({
      kind: "file",
      form: "quoted",
      query: "lecture 3",
      start: 4,
      end: 15,
    });
    expect(findTrigger('@"', 2)).toEqual({
      kind: "file",
      form: "quoted",
      query: "",
      start: 0,
      end: 2,
    });
    // The caret back inside a closed name: the rest of it, through the quote, is replaced.
    const named = '@"lecture 3 notes.txt" and';
    expect(findTrigger(named, 8)).toEqual({
      kind: "file",
      form: "quoted",
      query: "lectur",
      start: 0,
      end: named.indexOf(" and"),
    });
    // After the closing quote the mention is finished.
    expect(findTrigger('@"lecture 3" and', 16)).toBeNull();
    expect(findTrigger('@"ab"', 5)).toBeNull();
  });

  test("words with one space between them go on with the mention; two spaces or a new line end it (#2846)", () => {
    expect(findTrigger("look at @lecture 3", 18)).toEqual({
      kind: "file",
      form: "spaced",
      query: "lecture 3",
      start: 8,
      end: 18,
    });
    // Right after a space, and with the caret inside the last word.
    expect(findTrigger("@lecture ", 9)).toEqual({
      kind: "file",
      form: "spaced",
      query: "lecture ",
      start: 0,
      end: 9,
    });
    expect(findTrigger("@lecture 3x", 10)).toEqual({
      kind: "file",
      form: "spaced",
      query: "lecture 3",
      start: 0,
      end: 11,
    });
    expect(findTrigger("@lecture  ", 10)).toBeNull();
    expect(findTrigger("@lecture  3", 11)).toBeNull();
    expect(findTrigger("@lecture\n3", 10)).toBeNull();
    expect(findTrigger("@ lecture", 9)).toBeNull();
    // A new `@` starts its own mention.
    expect(findTrigger("@src @pa", 8)).toEqual({
      kind: "file",
      form: "word",
      query: "pa",
      start: 5,
      end: 8,
    });
  });
});

describe("matchCommands", () => {
  const command = (name: string, aliases?: string[]): ChatHostCommand => ({
    name,
    source: "builtin",
    ...(aliases === undefined ? {} : { aliases }),
  });

  test("names and aliases that start with the query come first, then those that contain it", () => {
    const commands = [
      command("session"),
      command("compact"),
      command("model", ["m"]),
      command("plan"),
    ];
    expect(matchCommands(commands, "m").map((item) => item.name)).toEqual(["model", "compact"]);
    expect(matchCommands(commands, "").map((item) => item.name)).toEqual([
      "session",
      "compact",
      "model",
      "plan",
    ]);
  });
});

describe("mentions and replacing", () => {
  test("a path with a space is quoted, so omp reads it as one path", () => {
    expect(mentionText("src/parser.ts")).toBe("@src/parser.ts ");
    expect(mentionText("notes/my plan.md")).toBe('@"notes/my plan.md" ');
  });

  test("a folder keeps the menu in it: its quote, when it needs one, stays open", () => {
    expect(folderMention("src/")).toBe("@src/");
    expect(folderMention("my notes/")).toBe('@"my notes/');
    const typed = 'see @"my notes/';
    expect(findTrigger(typed, typed.length)).toMatchObject({ form: "quoted", query: "my notes/" });
  });

  test("extensions are asked about words with spaces in their quoted form, as omp's terminal asks them", () => {
    const text = "read @summer 2027 please";
    const trigger = findTrigger(text, 17);
    expect(trigger).toMatchObject({ form: "spaced", query: "summer 2027" });
    if (trigger === null) return;
    expect(askedAs(text, 17, trigger)).toEqual({ text: 'read @"summer 2027 please', caret: 18 });
    const word = findTrigger("read @summer", 12);
    if (word === null) throw new Error("no trigger");
    expect(askedAs("read @summer", 12, word)).toEqual({ text: "read @summer", caret: 12 });
  });

  test("an extension's row for an earlier keystroke replaces the mention as typed now", () => {
    // Asked at `read @summer`, the row put its link there; since then ` 2` was typed.
    const link = "@[Summer 2027 Internship](note:n2) ";
    const row = { text: `read ${link}`, caret: 5 + link.length };
    expect(
      rebaseRow(row, { text: "read @summer", caret: 12 }, 5, { text: "read @summer 2", caret: 14 }),
    ).toEqual(row);
    // Text after the caret stays where it is.
    const kept = { text: "see @[Lab report](note:n1)  please", caret: 27 };
    expect(
      rebaseRow(kept, { text: "see @lab please", caret: 8 }, 4, {
        text: "see @lab r please",
        caret: 10,
      }),
    ).toEqual(kept);
    // A row that changed the text before the mention cannot be put on it.
    expect(
      rebaseRow({ text: "READ @x ", caret: 8 }, { text: "read @x", caret: 7 }, 5, {
        text: "read @x y",
        caret: 9,
      }),
    ).toBeNull();
  });

  test("a chosen row replaces the trigger's span and the caret goes after it", () => {
    const text = "look at @src/pa please";
    const trigger = findTrigger(text, 15);
    expect(trigger).not.toBeNull();
    if (trigger === null) return;
    expect(replaceTrigger(text, trigger, "@src/parser.ts ")).toEqual({
      text: "look at @src/parser.ts  please",
      caret: 23,
    });
  });
});

describe("shellRun", () => {
  test("`!` runs bash and `$` runs Python; doubled, the run stays out of the model's context", () => {
    expect(shellRun("!ls -la")).toEqual({
      method: "bash",
      input: "ls -la",
      excludeFromContext: false,
    });
    expect(shellRun("!!git status")).toEqual({
      method: "bash",
      input: "git status",
      excludeFromContext: true,
    });
    expect(shellRun("$print(1)")).toEqual({
      method: "python",
      input: "print(1)",
      excludeFromContext: false,
    });
    expect(shellRun("$$x = 2")).toEqual({
      method: "python",
      input: "x = 2",
      excludeFromContext: true,
    });
    // Typing the doubled prefix alone is still the doubled mode.
    expect(shellRun("!!")).toEqual({ method: "bash", input: "", excludeFromContext: true });
    expect(shellRun("list the files")).toBeNull();
  });
});
