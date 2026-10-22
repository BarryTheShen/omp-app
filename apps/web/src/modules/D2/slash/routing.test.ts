import { AppFailure } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { SlashCommand } from "../contract";
import capturedWithMcp from "../fixtures/real-get-available-commands-with-skill-and-mcp.json";
import { guardedForm, routeSlashText, type SlashAppCommand, terminalOnlyNote } from "./routing";
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
      "/mcp reload",
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

  test("/wt and its alias /worktree are guarded in every form: omp's clean-up of the source checkout needs the app's question", () => {
    expect(guardedForm("/wt")).toEqual({ name: "wt", args: "" });
    expect(guardedForm("/wt feature")).toEqual({ name: "wt", args: "feature" });
    expect(guardedForm("/WT:feature")).toEqual({ name: "wt", args: "feature" });
    expect(guardedForm("/worktree")).toEqual({ name: "worktree", args: "" });
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
      "btw",
      "resume",
      "tan",
      "omfg",
      "cleanse",
      "debug",
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
      "copy",
      "open",
      "exit",
      "quit",
      "q",
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
      "seance",
    ];
    for (const name of names) {
      const message = await refusalOf(`/${name}`);
      expect(message, name).toMatch(
        new RegExp(`^/${name} only runs in omp's terminal, so nothing was sent\\.`),
      );
    }
  });

  test("refuses btw when no app command is registered", async () => {
    expect(await refusalOf("/btw what changed?")).toBe(
      "/btw only runs in omp's terminal, so nothing was sent.",
    );
  });
  test("refuses /seance with text after it, the same as the bare name", async () => {
    expect(await refusalOf("/seance x")).toBe(
      "/seance only runs in omp's terminal, so nothing was sent.",
    );
  });
  test("the refusal names the app's own control where one exists", async () => {
    expect(await refusalOf("/copy the README")).toBe(
      "/copy only runs in omp's terminal, so nothing was sent. Use Copy from this chat instead.",
    );
    expect(await refusalOf("/resume")).toBe(
      "/resume only runs in omp's terminal, so nothing was sent. Use the session list instead.",
    );
    expect(await refusalOf("/logout")).toBe(
      "/logout only runs in omp's terminal, so nothing was sent. Provider sign-in is in Settings.",
    );
    expect(await refusalOf("/pause")).toBe(
      "/pause only runs in omp's terminal, so nothing was sent.",
    );
  });
  test("refuses /annotate with a terminal-editor explanation instead of claiming it ran", async () => {
    expect(await refusalOf("/annotate diff")).toBe(
      "/annotate only runs in omp's terminal, where it opens the annotation editor; nothing was sent.",
    );
  });
  test("lets omp handle only the exact lower-case code-review annotate form", () => {
    const annotate = SlashCommand.parse({ name: "annotate", source: "custom" });
    for (const text of [
      "/annotate code-review",
      "/annotate code-review focus on tests",
      "/annotate   code-review focus on tests",
      "/annotate\tcode-review",
    ]) {
      expect(routeSlashText(text, [...entries, annotate], [])).toEqual({
        kind: "omp",
        command: text,
      });
    }
    for (const text of [
      "/annotate Code-Review",
      "/annotate code-reviewer",
      "/annotate last",
      "/share code-review",
      "/wt code-review",
    ]) {
      expect(routeSlashText(text, [...entries, annotate], [])).not.toEqual({
        kind: "omp",
        command: text,
      });
    }
  });

  test("bare /copy is the app's command when the app lists it; words after it stay refused", () => {
    const copy: SlashAppCommand = {
      name: "copy",
      description: "Copy from this chat",
      run: async () => ({}),
    };
    expect(routeSlashText("/copy", entries, [copy])).toEqual({ kind: "app", command: copy });
    expect(routeSlashText("/copy the README", entries, [copy])).not.toEqual({
      kind: "app",
      command: copy,
    });
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
    const filePlan = SlashCommand.parse({ name: "plan", source: "file" });
    expect(routeSlashText("/plan", [...entries, filePlan], [])).toEqual({
      kind: "omp",
      command: "/plan",
    });
  });

  test("a colon form of a terminal-only name is refused like the bare name, since omp reads it as that name and its words", async () => {
    expect(await refusalOf("/loop:5")).toBe(
      "/loop only runs in omp's terminal, so nothing was sent.",
    );
  });

  test("a colon form of a name omp's list advertises keeps its omp route", () => {
    const filePlan = SlashCommand.parse({ name: "plan", source: "file" });
    expect(routeSlashText("/plan:now", [...entries, filePlan], [])).toEqual({
      kind: "omp",
      command: "/plan:now",
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

describe("#2199 a typed terminal-only name has a note; the refusal keeps its text", () => {
  /** The 28 terminal-only commands and their 3 aliases: the names the table answers. */
  const terminalOnlyNames = [
    "agents",
    "btw",
    "cleanse",
    "collab",
    "copy",
    "debug",
    "exit",
    "extensions",
    "status",
    "git",
    "guided-goal",
    "join",
    "leave",
    "live",
    "logout",
    "loop",
    "omfg",
    "open",
    "pause",
    "plan",
    "plan-review",
    "providers",
    "q",
    "queue",
    "quit",
    "record",
    "resume",
    "seance",
    "setup",
    "skills",
    "tan",
    "vibe",
  ];
  /** The app's own alternative that the refusal names, where there is one. */
  const alternatives: Readonly<Record<string, string>> = {
    copy: "Use Copy from this chat instead.",
    logout: "Provider sign-in is in Settings.",
    resume: "Use the session list instead.",
  };
  /** The message the app's refusal carries for a typed terminal-only command when no app command is registered. */
  async function refusalWithoutApp(text: string): Promise<string | undefined> {
    const route = routeSlashText(text, [], []);
    if (route?.kind !== "app") return undefined;
    try {
      await route.command.run({});
      return "ran";
    } catch (error) {
      return error instanceof AppFailure ? error.appError.message : undefined;
    }
  }

  test("each of the 32 names has omp's description in its note, except queue, which the app answers itself", () => {
    expect(terminalOnlyNames).toHaveLength(32);
    for (const name of terminalOnlyNames) {
      if (name === "queue") {
        expect(terminalOnlyNote(name)).toBeNull();
      } else {
        expect(terminalOnlyNote(name)?.does, name).toMatch(/\S/u);
      }
    }
  });

  test("/seance has omp's own description in its note, and no app alternative", () => {
    expect(terminalOnlyNote("seance")).toEqual({
      name: "seance",
      aliasOf: null,
      does: "Consult a saved session without resuming it",
      instead: null,
    });
  });

  test("an alias's note names the omp command it stands for", () => {
    expect(terminalOnlyNote("status")?.aliasOf).toBe("extensions");
    expect(terminalOnlyNote("providers")?.aliasOf).toBe("setup");
    expect(terminalOnlyNote("q")?.aliasOf).toBe("quit");
  });

  test("only an exact name or alias, with no space, has a note", () => {
    expect(terminalOnlyNote("logout")).toEqual({
      name: "logout",
      aliasOf: null,
      does: "Logout from OAuth provider",
      instead: "Provider sign-in is in Settings.",
    });
    for (const typed of ["logou", "lo", "logout now", "logout:now", "Logout", ""]) {
      expect(terminalOnlyNote(typed), JSON.stringify(typed)).toBeNull();
    }
  });

  test("the refusal keeps today's text for each of the 32 names", async () => {
    for (const name of terminalOnlyNames) {
      const sentence = `/${name} only runs in omp's terminal, so nothing was sent.`;
      const alternative = alternatives[name];
      expect(await refusalWithoutApp(`/${name}`), name).toBe(
        alternative === undefined ? sentence : `${sentence} ${alternative}`,
      );
    }
  });

  test("no terminal-only name is in omp's own list, in either captured list, so a note never hides a command omp runs", () => {
    const listed = [
      entries.map((entry) => entry.name),
      (capturedWithMcp.commands as readonly { readonly name: string }[]).map(
        (command) => command.name,
      ),
    ];
    for (const names of listed) {
      for (const name of terminalOnlyNames) expect(names, name).not.toContain(name);
    }
  });
});

describe("S9b /tree, /branch and /rewind are the app's commands, and /rewind is branch's alias", () => {
  const branch: SlashAppCommand = {
    name: "branch",
    aliases: ["rewind"],
    description: "Rewind this chat to one of your messages. This chat is kept.",
    takesArguments: true,
    run: async () => ({}),
  };

  test("the bare name and the alias run branch, words after either are its args, and /rewinds is still a prompt", () => {
    expect(routeSlashText("/branch", [], [branch])).toEqual({ kind: "app", command: branch });
    expect(routeSlashText("/rewind", [], [branch])).toEqual({ kind: "app", command: branch });
    expect(routeSlashText("/rewind now", [], [branch])).toEqual({
      kind: "app",
      command: branch,
      args: "now",
    });
    expect(routeSlashText("/rewind:x", [], [branch])).toEqual({
      kind: "app",
      command: branch,
      args: "x",
    });
    expect(routeSlashText("/rewinds", [], [branch])).toBeNull();
  });

  test("an omp file command named rewind does not take the app's alias away from the app", () => {
    const fileRewind = SlashCommand.parse({ name: "rewind", source: "file" });
    expect(routeSlashText("/rewind", [fileRewind], [branch])).toEqual({
      kind: "app",
      command: branch,
    });
  });
});

describe("S9a /delete is the app's command when the app lists it", () => {
  const deleteCommand: SlashAppCommand = {
    name: "delete",
    description: "Delete this chat, after you confirm",
    takesArguments: true,
    run: async () => ({}),
  };

  test("the bare name is the app's command, words after it are its args, and /deleted and /delete-all stay prompts", () => {
    expect(routeSlashText("/delete", [], [deleteCommand])).toEqual({
      kind: "app",
      command: deleteCommand,
    });
    expect(routeSlashText("/delete now", [], [deleteCommand])).toEqual({
      kind: "app",
      command: deleteCommand,
      args: "now",
    });
    expect(routeSlashText("/delete:now", [], [deleteCommand])).toEqual({
      kind: "app",
      command: deleteCommand,
      args: "now",
    });
    expect(routeSlashText("/deleted", [], [deleteCommand])).toBeNull();
    expect(routeSlashText("/delete-all", [], [deleteCommand])).toBeNull();
  });

  test("a typed /delete has no terminal-only note of its own: the app's row answers it", () => {
    expect(terminalOnlyNote("delete")).toBeNull();
  });
});

describe("S9c /fork is the app's command when the app lists it", () => {
  const fork: SlashAppCommand = {
    name: "fork",
    description: "Fork this chat into a copy and open it. The original is kept.",
    takesArguments: true,
    run: async () => ({}),
  };

  test("the bare name is the app's command, words or a colon after it are its args, and /forks stays a prompt", () => {
    expect(routeSlashText("/fork", [], [fork])).toEqual({ kind: "app", command: fork });
    expect(routeSlashText("/fork pane", [], [fork])).toEqual({
      kind: "app",
      command: fork,
      args: "pane",
    });
    expect(routeSlashText("/fork:window", [], [fork])).toEqual({
      kind: "app",
      command: fork,
      args: "window",
    });
    expect(routeSlashText("/forks", [], [fork])).toBeNull();
  });
});
