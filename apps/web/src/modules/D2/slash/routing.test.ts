import { describe, expect, test } from "vitest";
import { SlashCommand } from "../contract";
import { routeSlashText, type SlashAppCommand } from "./routing";
import { REAL_COMMAND_LIST } from "./test-support";

const entries = REAL_COMMAND_LIST.map((raw) => SlashCommand.parse(raw));
const newChat: SlashAppCommand = {
  name: "new",
  description: "Start a new chat",
  run: async () => ({ message: "Started a new chat." }),
};

describe("D2.3 submit routing", () => {
  test("a known omp command, or its alias, goes to the gateway with the text as typed", () => {
    expect(routeSlashText("/usage", entries, [])).toEqual({ kind: "omp", command: "/usage" });
    expect(routeSlashText("/models", entries, [])).toEqual({ kind: "omp", command: "/models" });
    expect(routeSlashText("/usage reset x", entries, [])).toEqual({
      kind: "omp",
      command: "/usage reset x",
    });
  });

  test("the app's command runs only when it is the whole message", () => {
    expect(routeSlashText("/new", [], [newChat])).toEqual({ kind: "app", command: newChat });
    expect(routeSlashText("/new  ", [], [newChat])).toEqual({ kind: "app", command: newChat });
    expect(routeSlashText("/new this week", [], [newChat])).toBeNull();
  });

  test("text that is not a known command stays a prompt: paths, unknown words, a leading space, a bare slash", () => {
    for (const text of [
      "/etc/hosts",
      "/nosuch",
      " /usage",
      "usage",
      "/",
      "/ usage",
      "please /usage",
      "",
    ]) {
      expect(routeSlashText(text, entries, [newChat]), JSON.stringify(text)).toBeNull();
    }
  });

  test("a trailing line break does not hide a command", () => {
    expect(routeSlashText("/usage\n", entries, [])).toEqual({ kind: "omp", command: "/usage" });
  });

  test("an MCP prompt listed as server:prompt routes like any other command", () => {
    const withPrompt = [
      ...entries,
      SlashCommand.parse({ name: "github:review", source: "mcp_prompt" }),
    ];
    expect(routeSlashText("/github:review focus=tests", withPrompt, [])).toEqual({
      kind: "omp",
      command: "/github:review focus=tests",
    });
  });
});
