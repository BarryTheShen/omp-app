import { AppFailure } from "@omp-app/contracts";
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

describe("#1271 omp's terminal-only commands are answered by the app in plain words, never sent to the model", () => {
  /** The message the app's route refuses with for a typed text: undefined when the text is not the app's route. */
  async function refusalOf(text: string): Promise<string | undefined> {
    const route = routeSlashText(text, entries, []);
    if (route?.kind !== "app") return undefined;
    try {
      await route.command.run({});
      return "ran";
    } catch (error) {
      return error instanceof AppFailure ? error.appError.message : undefined;
    }
  }

  test("every name that only omp's terminal runs is refused by the app, and nothing runs", async () => {
    const names = [
      "clear",
      "delete",
      "resume",
      "btw",
      "tan",
      "omfg",
      "cleanse",
      "debug",
      "restart",
      "setup",
      "plan",
      "vibe",
      "guided-goal",
      "loop",
      "queue",
      "pause",
      "record",
      "live",
      "logout",
      "fork",
      "tree",
      "copy",
      "open",
      "exit",
      "quit",
      "q",
      "branch",
      "rewind",
      "agents",
      "extensions",
      "status",
      "git",
      "skills",
      "providers",
      "collab",
      "join",
      "leave",
      "plan-review",
    ];
    for (const name of names) {
      const message = await refusalOf(`/${name}`);
      expect(message, name).toMatch(
        new RegExp(`^/${name} only runs in omp's terminal, so nothing was sent\\.`),
      );
    }
  });

  test("the refusal names the app's own control where one exists", async () => {
    expect(await refusalOf("/clear")).toBe(
      "/clear only runs in omp's terminal, so nothing was sent. Use New chat instead.",
    );
    expect(await refusalOf("/copy")).toBe(
      "/copy only runs in omp's terminal, so nothing was sent. Use Copy from this chat instead.",
    );
    expect(await refusalOf("/resume")).toBe(
      "/resume only runs in omp's terminal, so nothing was sent. Use the session list instead.",
    );
    expect(await refusalOf("/logout")).toBe(
      "/logout only runs in omp's terminal, so nothing was sent. Provider sign-in is in Settings.",
    );
    expect(await refusalOf("/delete")).toBe(
      "/delete only runs in omp's terminal, so nothing was sent. Delete a chat from the session list instead.",
    );
    expect(await refusalOf("/pause")).toBe(
      "/pause only runs in omp's terminal, so nothing was sent.",
    );
  });

  test("text that only looks like one of these names, or is a path, is still a prompt", () => {
    for (const text of [
      "/clearance",
      "/clear-cache",
      "/deleted",
      "/copies",
      "/tree-view",
      "/etc/hosts",
    ]) {
      expect(routeSlashText(text, entries, []), text).toBeNull();
    }
  });

  test("a name omp's list advertises keeps its omp route, even where omp's terminal has a builtin of that name", () => {
    const fileClear = SlashCommand.parse({ name: "clear", source: "file" });
    expect(routeSlashText("/clear", [...entries, fileClear], [])).toEqual({
      kind: "omp",
      command: "/clear",
    });
  });

  test("a colon form of a terminal-only name is refused like the bare name, since omp reads it as that name and its words", async () => {
    expect(await refusalOf("/clear:now")).toBe(
      "/clear only runs in omp's terminal, so nothing was sent. Use New chat instead.",
    );
    expect(await refusalOf("/clear:")).toBe(
      "/clear only runs in omp's terminal, so nothing was sent. Use New chat instead.",
    );
    expect(await refusalOf("/loop:5")).toBe(
      "/loop only runs in omp's terminal, so nothing was sent.",
    );
  });

  test("a colon form of a name omp's list advertises keeps its omp route", () => {
    const fileClear = SlashCommand.parse({ name: "clear", source: "file" });
    expect(routeSlashText("/clear:now", [...entries, fileClear], [])).toEqual({
      kind: "omp",
      command: "/clear:now",
    });
  });
});

describe("#1273 a command typed with a colon is read the way omp reads it, up to the colon", () => {
  test("omp's colon forms route to omp with the text as typed, so omp runs the command it names", () => {
    expect(routeSlashText("/force:read summarize", entries, [])).toEqual({
      kind: "omp",
      command: "/force:read summarize",
    });
    expect(routeSlashText("/fast:on", entries, [])).toEqual({ kind: "omp", command: "/fast:on" });
    expect(routeSlashText("/browser:visible", entries, [])).toEqual({
      kind: "omp",
      command: "/browser:visible",
    });
    expect(routeSlashText("/slow:status", entries, [])).toEqual({
      kind: "omp",
      command: "/slow:status",
    });
    expect(routeSlashText("/force:", entries, [])).toEqual({ kind: "omp", command: "/force:" });
  });

  test("a colon name omp lists whole keeps its route, and a name nothing lists is still a prompt", () => {
    const withSkill = [...entries, SlashCommand.parse({ name: "skill:review", source: "skill" })];
    expect(routeSlashText("/skill:review tests", withSkill, [])).toEqual({
      kind: "omp",
      command: "/skill:review tests",
    });
    for (const text of ["/nosuch:read summarize", "/etc:hosts", "/:force", ":force read"]) {
      expect(routeSlashText(text, entries, []), text).toBeNull();
    }
  });
});
