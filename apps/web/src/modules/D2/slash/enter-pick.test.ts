import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type CapabilityMap, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { DESTRUCTIVE_FORMS } from "./destructive";
import golden from "./enter-pick.golden.json";
import realCatalog from "./fixtures/real-get-available-commands-18.12.2.json";
import { createSlashCommandProvider } from "./provider";
import type { SlashAppCommand } from "./routing";
import { fakeSlashClient } from "./test-support";

// Enter runs the first row of the `/` list. This pins that row for every prefix of every single-word name omp lists
// (names and aliases) and of every app command name, with omp's real 18.12.2 list and main's real provider. A change
// that moves a pick fails here; `ENTER_PICK_UPDATE=1` (run from apps/web) rewrites the golden file, and the diff goes in the PR body.
// #2175 replaces the app's older length-weighted prefix scores with omp v18.12.6's exact/prefix/subsequence scores.
// Source: packages/tui/src/autocomplete.ts:374-382,395,475-478. No command-usage counts reach this app catalog, so
// usage defaults to zero and equal scores keep catalog order.
// v18.12.2 has the same scorer/default at packages/tui/src/autocomplete.ts:368-376,389,464-467.
// This corrects old app picks, not an upstream ranking change between releases.
// Prefix picks changed: a/ad add-dir→advisor; b/br branch→browser; c/co/com/comp copy/compact→computer,
// e/ex effort/export→extended-context; fo/for fork→force; g goal→green; h hub→handoff; m mcp→model,
// mo move→model; p pin→prewalk; r retry→ratchet; s ssh→security; se session→security,
// t todo→trace; tr tree→trace; x export→extended-context.
// Subsequence ties changed: v move→advisor and y copy→security, per packages/tui/src/autocomplete.ts:191-217,475-478.

const threadId = ThreadId.parse("thread-enter-pick");
const available: CapabilityMap = {
  "omp.cmd.get_available_commands": { state: "available", via: "rpc" },
};
const GOLDEN_PATH = resolve(process.cwd(), "src/modules/D2/slash/enter-pick.golden.json");

function appCommand(
  name: string,
  description: string,
  flags: {
    readonly unlisted?: true;
    readonly takesArguments?: true;
    readonly aliases?: readonly string[];
  } = {},
): SlashAppCommand {
  return { name, description, ...flags, run: async () => ({}) };
}

/**
 * The app's own commands as the composition hands them to the composer (app/root.tsx `appSlashCommands`, main 1ffa8d473,
 * with S9a's `delete`, S9b's `tree` and `branch`, S9c's `fork`, S9d's `clear`, and S9e's `restart`). Nineteen are listed rows; the rest
 * are unlisted, guarded forms that still route when typed. An unlisted form does not replace omp's row of its name
 * (provider.ts `listEntries`), so `wt` and `worktree` leave omp's `wt` row listed.
 */
const APP_COMMANDS: readonly SlashAppCommand[] = [
  appCommand("new", "Start a new chat"),
  appCommand("clear", "Start a new chat with an empty context. This chat stays in your list."),
  appCommand("fresh", "Start a fresh connection to the model"),
  appCommand("share", "Share this chat as a link"),
  appCommand("copy", "Copy from this chat"),
  appCommand("tree", "Browse this chat's messages, to rewind or fork from one"),
  appCommand("branch", "Rewind this chat to one of your messages. This chat is kept.", {
    aliases: ["rewind"],
  }),
  appCommand("fork", "Fork this chat into a copy and open it. The original is kept.", {
    takesArguments: true,
  }),
  appCommand("export", "Export this chat"),
  appCommand("dump", "Save omp's dump of this chat.", { takesArguments: true }),
  appCommand("open", "Open the last link from the conversation in your browser."),
  appCommand("record", "Start or stop recording this screen to a replayable file."),
  appCommand("login", "Log in to a model provider"),
  appCommand("settings", "Open settings"),
  appCommand("hotkeys", "Show all keyboard shortcuts"),
  appCommand("goal", "Show, set, pause, resume or drop the goal", { takesArguments: true }),
  appCommand("hub", "Open the Agent Hub"),
  appCommand("wt", "Move this chat into a worktree, after you confirm", {
    unlisted: true,
    takesArguments: true,
  }),
  appCommand("worktree", "Move this chat into a worktree, after you confirm", {
    unlisted: true,
    takesArguments: true,
  }),
  appCommand("mcp reload", "Refresh the command list omp offers", { unlisted: true }),
  appCommand("session delete", "Delete this chat, after you confirm", { unlisted: true }),
  appCommand("delete", "Delete this chat, after you confirm"),
  appCommand("usage reset", "Spend a saved rate-limit reset, after you confirm", {
    unlisted: true,
    takesArguments: true,
  }),
  ...DESTRUCTIVE_FORMS.map((form) =>
    appCommand(form, "Asks first, then runs it in omp", { unlisted: true, takesArguments: true }),
  ),
  appCommand("restart", "Restart omp on this chat, after you confirm"),
];

/** Every prefix of every single-word name omp lists (names and aliases) or the app names, plus `a` to `z`. */
function typedPrefixes(): readonly string[] {
  const words = new Set<string>();
  for (const command of realCatalog.commands) {
    words.add(command.name);
    for (const alias of command.aliases ?? []) words.add(alias);
  }
  for (const app of APP_COMMANDS) {
    words.add(app.name);
    for (const alias of app.aliases ?? []) words.add(alias);
  }
  const prefixes = new Set<string>("abcdefghijklmnopqrstuvwxyz");
  for (const word of words) {
    if (/\s/u.test(word)) continue;
    for (let length = 1; length <= word.length; length += 1) prefixes.add(word.slice(0, length));
  }
  return [...prefixes].sort();
}

async function picksForEveryPrefix(): Promise<Record<string, string>> {
  const fake = fakeSlashClient({ commands: async () => ({ commands: realCatalog.commands }) });
  const provider = createSlashCommandProvider({
    client: fake.client,
    threadId,
    capabilities: () => available,
    appCommands: () => APP_COMMANDS,
  });
  const picks: Record<string, string> = {};
  try {
    for (const prefix of typedPrefixes()) {
      const { candidates } = await provider.searchTyped(prefix);
      picks[prefix] = candidates[0]?.label ?? "(none)";
    }
  } finally {
    provider.dispose();
  }
  return picks;
}

describe("#2263 Enter's first row for every typed prefix, with omp's 18.12.2 list", () => {
  test("the app's commands are the 19 listed rows and the unlisted guarded forms", () => {
    const listed = APP_COMMANDS.filter((app) => app.unlisted !== true).map((app) => app.name);
    expect(listed).toEqual([
      "new",
      "clear",
      "fresh",
      "share",
      "copy",
      "tree",
      "branch",
      "fork",
      "export",
      "dump",
      "open",
      "record",
      "login",
      "settings",
      "hotkeys",
      "goal",
      "hub",
      "delete",
      "restart",
    ]);
  });

  test("every prefix of every name and alias picks the row the golden file records", async () => {
    const picks = await picksForEveryPrefix();
    if (process.env.ENTER_PICK_UPDATE === "1") {
      writeFileSync(GOLDEN_PATH, `${JSON.stringify(picks, null, 2)}\n`);
      return;
    }
    expect(Object.keys(picks).length).toBeGreaterThan(300);
    expect(picks).toEqual(golden);
  });

  test("the picks for the examples the plan names", async () => {
    const picks = await picksForEveryPrefix();
    expect(picks).toMatchObject({
      s: "/security",
      set: "/settings",
      lo: "/login",
      ex: "/extended-context",
      m: "/model",
    });
  });

  test("S8: the nine prefixes that reach omp's wt row by its name or its alias worktree pick /wt", async () => {
    const picks = await picksForEveryPrefix();
    for (const prefix of [
      "w",
      "wt",
      "wo",
      "wor",
      "work",
      "workt",
      "worktr",
      "worktre",
      "worktree",
    ]) {
      expect(picks[prefix], prefix).toBe("/wt");
    }
  });
});
