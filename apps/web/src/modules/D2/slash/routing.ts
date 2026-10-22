import { type AbortSignalLike, AppFailure } from "@omp-app/contracts";
import type { SlashListEntry } from "./rank";

/**
 * A command the app runs itself, such as `/new`. It is named without the slash; the composition supplies `run`, and D2
 * never imports the module that does the work. A bare name runs it with no arguments. A command that sets
 * `takesArguments` also runs when text follows its name, and `run` then gets that text as `args`.
 */
export interface SlashAppCommand {
  readonly name: string;
  /** Other names that run the command, typed as `/alias` (`rewind` runs `branch`). */
  readonly aliases?: readonly string[];
  readonly description: string;
  /** Set for a command that reads the text after its name (`/goal ship the release`). Without it, `/name text` is not the app's. */
  readonly takesArguments?: true;
  /** Set for a command the `/` list leaves out: a guarded form, whose words omp's own list already covers. It still runs when typed. */
  readonly unlisted?: true;
  /** Resolves with an optional plain-English note for the header. Rejects with an AppFailure whose message the person sees. */
  readonly run: (options: {
    readonly signal?: AbortSignalLike;
    /** The text after the name, trimmed. Given only when the command takes arguments and some were typed. */
    readonly args?: string;
  }) => Promise<{ readonly message?: string }>;
}

export type SlashRoute =
  | { readonly kind: "omp"; readonly command: string }
  | { readonly kind: "app"; readonly command: SlashAppCommand; readonly args?: string };

/**
 * When a guarded subcommand word runs omp's action, judged on the text after the word (trimmed):
 * `any` always; `bare` only with nothing after it (`/session delete x` prints omp's usage, builtin-session.ts:270, :293);
 * `target` with any text after it, since a bare word lists or prints usage; `name` with a first word that is not a flag
 * (helpers/parse.ts, `parseNamedScopeArgs`).
 */
type Trigger = "any" | "bare" | "target" | "name";

function triggerRuns(trigger: Trigger, rest: string): boolean {
  switch (trigger) {
    case "any":
      return true;
    case "bare":
      return rest === "";
    case "target":
      return rest !== "";
    case "name":
      return rest !== "" && !rest.startsWith("-");
  }
}

/**
 * omp subcommands that run at once when typed, so the app answers them itself (`guardedRoute`). A form that deletes data asks first (`destructive.ts`). Every row was
 * checked against omp v18.9.1; a form that only prints usage or lists stays text. `/share` is guarded in every form (issue 957,
 * builtin-collaboration.ts:293-296).
 *
 * The app's RPC runs a command's `handle`, the path rpc-mode.ts:1799 takes (acp-builtins.ts:59-69). The guard matches the
 * command name and the subcommand word in any letter case, as it does for `/share`.
 * - `session delete` deletes the chat's session file (builtin-session.ts:270-280, `dropSession` at :280).
 * - `usage reset <target>` spends a saved rate-limit reset (builtin-session.ts:411-414; `handleUsageResetCommand` at
 *   :41-70, `redeemResetCredit` at :68). A bare `usage reset` lists the accounts (:57-62).
 * - `memory clear` and `memory reset` delete the persisted memory (builtin-lifecycle.ts:571-573).
 * - `ssh remove|rm` and `mcp remove|rm` delete a named host or server (helpers/ssh.ts:139-152, :188-190; helpers/mcp.ts:456-468,
 *   :527-528). Without a name they print usage.
 * - `mcp reload` refreshes omp's command list over RPC and reconnects no server (helpers/mcp.ts:518-520; rpc-mode.ts:1805),
 *   so the app answers it with the typed reload and says what that did.
 * - `marketplace remove|rm` delete a marketplace source, and `uninstall` deletes a plugin's installed files
 *   (builtin-marketplace.ts:124-130 and :181-187; marketplace/manager.ts:578-638, the removal at :636).
 * - `modelpreset delete <name>` deletes a saved preset (builtin-modes.ts:847-849, :981-983).
 * - `wt` and its alias `worktree` move the chat into a new worktree. With omp's "Clean Source Checkout on /wt" setting on, they
 *   also reset and clean the folder's checkout (builtin-lifecycle.ts:747, session-worktree.ts:96-103). The app cannot read that
 *   setting, so every form asks first.
 * - `annotate` opens omp's annotation editor, which needs omp's interactive terminal UI and sends no message without it,
 *   except lower-case `annotate code-review` with whitespace or end-of-text, which omp runs headlessly to return a review request
 *   (`extensibility/custom-commands/bundled/annotate/index.ts:223-239`; the exemption is the same `:230` parser check).
 */
const GUARDED_OMP_COMMANDS: Record<string, true | Record<string, Trigger>> = {
  share: true,
  session: { delete: "bare" },
  usage: { reset: "target" },
  memory: { clear: "any", reset: "any" },
  ssh: { remove: "name", rm: "name" },
  mcp: { remove: "name", rm: "name", reload: "any" },
  marketplace: { remove: "target", rm: "target", uninstall: "target" },
  modelpreset: { delete: "target" },
  wt: true,
  worktree: true,
  annotate: true,
};

/** omp's `parseSubcommand`: the first word of the arguments in lower case, and the text after it. */
function subcommandOf(args: string): { readonly verb: string; readonly rest: string } {
  const trimmed = args.trim();
  const space = trimmed.search(/\s/u);
  if (space === -1) return { verb: trimmed.toLowerCase(), rest: "" };
  return { verb: trimmed.slice(0, space).toLowerCase(), rest: trimmed.slice(space + 1).trim() };
}

/** A guarded form a message names: its name in lower case (`share`, `session delete`), and the text after its words. */
interface GuardedForm {
  readonly name: string;
  readonly args: string;
}

/** The guarded form a message names, or null. omp reads the name up to a space or a colon, then the subcommand word. */
export function guardedForm(text: string): GuardedForm | null {
  const match = /^\s*\/([^\s:]+)[\s:]?([\s\S]*)$/u.exec(text);
  const name = match?.[1]?.toLowerCase();
  // Own keys only: a name such as `constructor` is not a guarded form.
  if (name === undefined || !Object.hasOwn(GUARDED_OMP_COMMANDS, name)) return null;
  const guard = GUARDED_OMP_COMMANDS[name];
  const words = match?.[2] ?? "";
  // omp handles this form without its interactive UI and sends the review request to the agent. omp trims its arguments
  // first (`args.trim().match(/^code-review.../)`, annotate/index.ts:230), so extra spaces before the word do not matter.
  if (name === "annotate" && /^code-review(?:\s|$)/u.test(words.trim())) return null;
  if (guard === true) return { name, args: words.trim() };
  const { verb, rest } = subcommandOf(words);
  const trigger: Trigger | undefined =
    guard !== undefined && Object.hasOwn(guard, verb) ? guard[verb] : undefined;
  if (trigger === undefined || !triggerRuns(trigger, rest)) return null;
  return { name: `${name} ${verb}`, args: rest };
}

/** The guarded form a message names, in lower case (`share`, `session delete`), or null. */
export function guardedCommandName(text: string): string | null {
  return guardedForm(text)?.name ?? null;
}

/** Refusals that say why, for the guarded forms whose reason is more useful than "isn't available". Own keys only. */
const SPECIFIC_REFUSALS: Readonly<Record<string, string>> = {
  annotate:
    "/annotate only runs in omp's terminal, where it opens the annotation editor; nothing was sent.",
};

/** The refusal for a guarded form the app has no handler for. Nothing is sent to omp. */
export function guardedRefusal(name: string): AppFailure {
  return new AppFailure({
    code: "unavailable",
    message: Object.hasOwn(SPECIFIC_REFUSALS, name)
      ? (SPECIFIC_REFUSALS[name] as string)
      : `/${name} isn't available in this app, so nothing was sent to omp.`,
    retryable: false,
  });
}

/**
 * The app's route for a guarded form, or null when the text is not one. The app's own command of that name answers
 * it, and a command that takes arguments gets the text after its words. With no command of that name, the form is
 * refused, so omp still never sees it.
 */
export function guardedRoute(
  text: string,
  appCommands: readonly SlashAppCommand[],
): SlashRoute | null {
  const form = guardedForm(text);
  if (form === null) return null;
  const own = appCommands.find((command) => command.name.toLowerCase() === form.name);
  if (own !== undefined) {
    return own.takesArguments === true
      ? { kind: "app", command: own, args: form.args }
      : { kind: "app", command: own };
  }
  return {
    kind: "app",
    command: {
      name: form.name,
      description: "Not available in this app",
      run: () => Promise.reject(guardedRefusal(form.name)),
    },
  };
}

/**
 * omp's commands that only its terminal runs: the top-level builtins with a `handleTui` and no text `handle` in omp
 * v18.9.1, the same at v18.8.9 (builtin-*.ts). omp leaves them out of its list, and its RPC prompt has no handler for
 * them, so it hands their text to the model (acp-builtins.ts:66, rpc-mode.ts:1798-1838). The app answers each one
 * itself. `does` is omp's own description of the command, `instead` the app's control for the same job (or none), and
 * `aliasOf` the command an alias stands for. Names the app already answers (`/new`, `/settings`, `/login`, `/hotkeys`,
 * `/hub`, `/goal`) are not listed, so their other forms stay prompts.
 */
interface TerminalOnlyEntry {
  readonly does: string;
  readonly instead?: string;
  readonly aliasOf?: string;
  /** The app answers this name in the composer itself (`/queue` is its queued-message command): no note, but the refusal stands. */
  readonly answeredByApp?: true;
}

/** The note the composer shows for a typed terminal-only name: the name, omp's description and the app's alternative. */
export interface TerminalOnlyNote {
  /** The name as typed, without the slash. */
  readonly name: string;
  /** The omp name an alias stands for (`branch` for `rewind`), or null. */
  readonly aliasOf: string | null;
  /** omp's description of the command. */
  readonly does: string;
  /** The app's own control for the same job, or null. */
  readonly instead: string | null;
}

const TERMINAL_ONLY_OMP_COMMANDS: Readonly<Record<string, TerminalOnlyEntry>> = {
  agents: { does: "Open the agents hub (per-agent model, prewalk, and advisor)" },
  btw: { does: "Ask a side question, or browse this session's BTW history" },
  cleanse: { does: "Detect and fix project diagnostics with weighted parallel subagents" },
  clear: {
    does: "Clear the conversation context in place, keeping the session",
    instead: "Use New chat instead.",
  },
  collab: { does: "Share this session live via a relay" },
  copy: {
    does: "Pick text or code from the conversation to copy",
    instead: "Use Copy from this chat instead.",
  },
  debug: { does: "Open debug tools selector" },
  exit: { does: "Exit the application" },
  extensions: { does: "Open Extension Control Center dashboard" },
  status: { aliasOf: "extensions", does: "Open Extension Control Center dashboard" },
  fork: { does: "Fork this session, or open it in a multiplexer pane or window" },
  git: { does: "Open the git UI (split diff viewer, staging, commit composer)" },
  "guided-goal": { does: "Have the agent interview you in chat, then set up goal mode" },
  join: { does: "Join a shared collab session" },
  leave: { does: "Leave the collab session" },
  live: { does: "Start Codex-backed realtime voice mode" },
  logout: {
    does: "Logout from OAuth provider",
    instead: "Provider sign-in is in Settings.",
  },
  loop: {
    does: "Toggle loop mode: the next prompt you send re-submits after every yield. A count, a duration, or --until or --while with a command bounds it.",
  },
  omfg: { does: "Forge a TTSR rule from a complaint to stop a recurring behavior" },
  open: {
    does: "Open the last link from the conversation in your browser (or pick one with /copy)",
  },
  pause: { does: "Freeze all agents (main, subagents, advisor) until resumed" },
  plan: { does: "Toggle plan mode (agent plans before executing)" },
  "plan-review": { does: "Re-open the plan review for the latest plan (plan mode only)" },
  providers: { aliasOf: "setup", does: "Open provider setup" },
  q: { aliasOf: "quit", does: "Quit the application" },
  queue: { does: "Queue a message for after the agent yields", answeredByApp: true },
  quit: { does: "Quit the application" },
  record: { does: "Start or stop recording this screen to a replayable file (omp play)" },
  resume: {
    does: "Resume a different session",
    instead: "Use the session list instead.",
  },
  setup: { does: "Open provider setup" },
  skills: { does: "Search, install, and update skills from the skills.omp.sh registry" },
  tan: { does: "Run a full background agent on tangential work" },
  vibe: {
    does: "Toggle vibe mode (direct persistent fast/good worker sessions; read-only toolset)",
  },
};

/**
 * The note for a typed name that only omp's terminal runs, given without its slash: an exact name or alias, and no
 * space. Any other text has no note. The provider hides the note when a listed row takes the same name.
 */
export function terminalOnlyNote(typed: string): TerminalOnlyNote | null {
  const entry = Object.hasOwn(TERMINAL_ONLY_OMP_COMMANDS, typed)
    ? TERMINAL_ONLY_OMP_COMMANDS[typed]
    : undefined;
  if (entry === undefined || entry.answeredByApp === true) return null;
  return {
    name: typed,
    aliasOf: entry.aliasOf ?? null,
    does: entry.does,
    instead: entry.instead ?? null,
  };
}

/** The app's answer to a typed name that only omp's terminal runs: one plain sentence, and nothing sent to omp. */
function terminalOnlyRoute(name: string): SlashRoute | null {
  const entry = Object.hasOwn(TERMINAL_ONLY_OMP_COMMANDS, name)
    ? TERMINAL_ONLY_OMP_COMMANDS[name]
    : undefined;
  if (entry === undefined) return null;
  const sentence = `/${name} only runs in omp's terminal, so nothing was sent.`;
  const message = entry.instead === undefined ? sentence : `${sentence} ${entry.instead}`;
  return {
    kind: "app",
    command: {
      name,
      description: "Only runs in omp's terminal",
      run: () => Promise.reject(new AppFailure({ code: "unavailable", message, retryable: false })),
    },
  };
}

/**
 * Decides where a submitted message goes. Only text that starts with the slash, whose first word is a
 * command omp or the app lists, is a command. Anything else, including `/etc/hosts`, an unknown `/word`
 * and text that starts with a space, is a normal prompt and returns null. A guarded form (see
 * GUARDED_OMP_COMMANDS) is a command, and leading spaces do not hide it. A name ends at its first whitespace or colon, as
 * omp reads it (`/force:read` is `force`). A name only omp's terminal runs is refused by the app
 * (TERMINAL_ONLY_OMP_COMMANDS), so its text never reaches the model.
 */
export function routeSlashText(
  text: string,
  entries: readonly SlashListEntry[],
  appCommands: readonly SlashAppCommand[],
): SlashRoute | null {
  const guarded = guardedRoute(text, appCommands);
  if (guarded !== null) return guarded;
  if (!text.startsWith("/")) return null;
  const trimmed = text.trimEnd();
  for (const app of appCommands) {
    // A name with a space is a guarded form (`usage reset`): only guardedRoute answers it, so its bare words stay omp's.
    if (app.name.includes(" ")) continue;
    if (![app.name, ...(app.aliases ?? [])].some((name) => trimmed === `/${name}`)) continue;
    return { kind: "app", command: app };
  }
  // omp reads a name up to its first whitespace or colon (parse.ts): `/goal:pause` is `/goal pause`.
  const named = /^\/([^\s:]*)/u.exec(trimmed)?.[1] ?? "";
  // A command that takes arguments is the app's when text follows its name. The bare name is matched above, unchanged.
  for (const app of appCommands) {
    if (app.takesArguments === true && [app.name, ...(app.aliases ?? [])].includes(named)) {
      const args = trimmed
        .slice(named.length + 1)
        .replace(/^:/u, "")
        .trim();
      return args === "" ? { kind: "app", command: app } : { kind: "app", command: app, args };
    }
  }
  const word = /^\/(\S*)/u.exec(trimmed)?.[1] ?? "";
  if (word === "") return null;
  // omp's list names a colon name whole (`github:review`); any other word is also read as its name before the colon.
  const known = [word, named].some((candidate) =>
    entries.some((entry) => entry.name === candidate || (entry.aliases ?? []).includes(candidate)),
  );
  if (known) return { kind: "omp", command: trimmed };
  // omp reads the name up to its first whitespace or colon, so `/clear:now` is refused like `/clear`.
  return terminalOnlyRoute(named);
}
