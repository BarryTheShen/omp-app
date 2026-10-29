import type { ChatHostCommand } from "@omp-app/contracts/chat-host";
import { describe, expect, test } from "vitest";
import { findTrigger, matchCommands, mentionText, replaceTrigger, shellRun } from "./triggers";

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
      query: "src/pa",
      start: 8,
      end: 15,
    });
    expect(findTrigger("@", 1)).toEqual({ kind: "file", query: "", start: 0, end: 1 });
    // An address is not a mention: the `@` does not start a word.
    expect(findTrigger("mail me@home", 12)).toBeNull();
    // After a space the mention is finished.
    expect(findTrigger("@src/a.ts and", 13)).toBeNull();
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
