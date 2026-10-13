import { describe, expect, test } from "vitest";
import { SlashCommand } from "../contract";
import { guardedForm, routeSlashText, type SlashAppCommand } from "./routing";
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
    expect(routeSlashText("/usage reset", entries, [])).toEqual({
      kind: "omp",
      command: "/usage reset",
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

describe("#957 every form of /share is answered by the app, never sent to omp", () => {
  const share: SlashAppCommand = {
    name: "share",
    description: "Share this chat (not available yet)",
    run: async () => ({}),
  };

  test("/share, with or without arguments, in any letter case and after leading spaces, is the app's", () => {
    for (const text of [
      "/share",
      "/share now",
      "/share:now",
      "/SHARE",
      "/Share now",
      "  /share",
      "\n/share\n",
      "/share   ",
    ]) {
      expect(routeSlashText(text, entries, [share]), JSON.stringify(text)).toEqual({
        kind: "app",
        command: share,
      });
    }
  });

  test("a form of /share is refused by the app even when no handler is registered", async () => {
    const route = routeSlashText("/share now", entries, []);
    expect(route?.kind).toBe("app");
    if (route?.kind !== "app") return;
    await expect(route.command.run({})).rejects.toMatchObject({
      appError: { code: "unavailable", retryable: false },
    });
  });

  test("words that only start with share are not share", () => {
    expect(routeSlashText("/sharex", entries, [share])).toBeNull();
    expect(routeSlashText("/share/x", entries, [share])).toBeNull();
    expect(routeSlashText("please /share", entries, [share])).toBeNull();
  });
});

describe("#1272 omp subcommands that run at once are answered by the app, not sent to omp", () => {
  const sessionDelete: SlashAppCommand = {
    name: "session delete",
    description: "Delete this chat, after you confirm",
    run: async () => ({}),
  };
  const usageReset: SlashAppCommand = {
    name: "usage reset",
    description: "Spend a saved rate-limit reset, after you confirm",
    takesArguments: true,
    run: async () => ({}),
  };

  test("a bare /session delete is the app's, in any spacing, letter case or separator", () => {
    for (const text of [
      "/session delete",
      "/session delete   ",
      " /SESSION   Delete",
      "/session:delete",
      "\n/Session delete\n",
    ]) {
      expect(routeSlashText(text, entries, [sessionDelete]), JSON.stringify(text)).toEqual({
        kind: "app",
        command: sessionDelete,
      });
    }
  });

  test("/session delete with words after it stays omp's, which prints its usage and deletes nothing", () => {
    for (const text of ["/session delete now", "/session delete chat-2"]) {
      expect(routeSlashText(text, entries, [sessionDelete]), text).toEqual({
        kind: "omp",
        command: text,
      });
    }
  });

  test("the bare /usage reset lists the accounts, so it stays omp's", () => {
    expect(routeSlashText("/usage reset", entries, [usageReset])).toEqual({
      kind: "omp",
      command: "/usage reset",
    });
  });

  test("/usage reset with a target is the app's, and the target is handed over as args", () => {
    expect(routeSlashText("/usage reset codex/active", entries, [usageReset])).toEqual({
      kind: "app",
      command: usageReset,
      args: "codex/active",
    });
    expect(routeSlashText("  /USAGE   RESET   anthropic/2  ", entries, [usageReset])).toEqual({
      kind: "app",
      command: usageReset,
      args: "anthropic/2",
    });
  });

  test("with no app handler, each guarded form is refused, so nothing reaches omp", async () => {
    for (const text of [
      "/session delete",
      "/usage reset codex/active",
      "/memory clear",
      "/memory reset now",
      "/ssh remove dev",
      "/ssh rm dev --scope user",
      "/mcp remove github",
      "/mcp rm github",
      "/marketplace remove market",
      "/marketplace rm market",
      "/marketplace uninstall plugin@market",
      "/modelpreset delete fast",
    ]) {
      const route = routeSlashText(text, entries, []);
      expect(route?.kind, text).toBe("app");
      if (route?.kind !== "app") return;
      await expect(route.command.run({}), text).rejects.toMatchObject({
        appError: {
          code: "unavailable",
          message: `/${route.command.name} isn't available in this app, so nothing was sent to omp.`,
          retryable: false,
        },
      });
    }
  });

  test("the forms that only list, print usage or name nothing stay omp's", () => {
    for (const text of [
      "/memory view",
      "/ssh list",
      "/ssh remove",
      "/ssh remove --scope user",
      "/mcp remove",
      "/mcp disable github",
      "/marketplace remove",
      "/marketplace list",
      "/marketplace install plugin@market",
      "/modelpreset delete",
      "/modelpreset switch fast",
    ]) {
      expect(routeSlashText(text, entries, []), text).toEqual({ kind: "omp", command: text });
    }
  });

  test("a word or a command name that only resembles a guarded one is not guarded", () => {
    for (const text of [
      "/sessions delete",
      "/session deletes",
      "/usage resets x",
      "/ssh removed dev",
      "/memories clear",
      "/constructor delete",
    ]) {
      expect(routeSlashText(text, entries, [sessionDelete, usageReset])?.kind, text).not.toBe(
        "app",
      );
    }
  });

  test("guardedForm names the form and the words after it, or nothing when they are harmless", () => {
    expect(guardedForm("/usage reset codex/active")).toEqual({
      name: "usage reset",
      args: "codex/active",
    });
    expect(guardedForm("/session:delete")).toEqual({ name: "session delete", args: "" });
    expect(guardedForm("/session delete now")).toBeNull();
    expect(guardedForm("/share now")).toEqual({ name: "share", args: "now" });
  });
});
