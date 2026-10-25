/**
 * The question the app asks before a typed form that deletes data runs in omp (`/memory clear`, `/ssh remove`, and the
 * rest of `DESTRUCTIVE_FORMS`). It names the target the person typed and says what omp deletes. Cancel sends nothing.
 *
 * A form with no target, or with a `--scope` that is not `project` or `user`, makes omp print its usage or refuse the
 * scope before anything is deleted, so it has no question (`null`), and the app sends it as typed. The forms that
 * delete everything of a kind and take no target (`/memory clear`, `/forget-approvals`) always ask; `/forget-approvals`
 * is the one form that is a single word.
 */
export interface DestructiveQuestion {
  /** The overlay's name for the dialog. */
  readonly label: string;
  /** Names the target, in the words the person typed it as. */
  readonly title: string;
  readonly description: string;
  /** The destructive button. Cancel and closing the dialog both send nothing. */
  readonly confirmLabel: string;
}

/** The words a typed target reads as: its name (the first word that is not a flag), and the value of `--scope` if any. */
interface TypedTarget {
  readonly name: string | undefined;
  readonly scope: string | undefined;
}

/**
 * omp's words for a target: the first word that does not start with a dash is the name, and `--scope` takes the word after
 * it (helpers/parse.ts `parseNamedScopeArgs`). Quotes around the name are dropped, as a person types them.
 */
function typedTarget(args: string): TypedTarget {
  const words = args
    .trim()
    .split(/\s+/u)
    .filter((word) => word !== "");
  const flagAt = words.indexOf("--scope");
  const valueAt = flagAt === -1 ? -1 : flagAt + 1;
  const scope = valueAt === -1 ? undefined : words[valueAt];
  const name = words.find((word, index) => index !== valueAt && !word.startsWith("-"));
  return { name: name === undefined ? undefined : name.replace(/^["'`]|["'`]$/gu, ""), scope };
}

type Builder = (args: string) => DestructiveQuestion | null;

/** `/ssh remove` and `/mcp remove`: a config entry, in the project config unless `--scope user` says otherwise. */
function configEntry(noun: string, label: string, confirmLabel: string): Builder {
  return (args) => {
    const { name, scope } = typedTarget(args);
    if (name === undefined) return null;
    if (scope !== undefined && scope !== "project" && scope !== "user") return null;
    return {
      label,
      title: `Remove the ${noun} "${name}" from the ${scope ?? "project"} config?`,
      description: "Its entry is deleted from that config file. This cannot be undone.",
      confirmLabel,
    };
  };
}

/** `/marketplace remove` and `/marketplace rm`: the registry entry and the cached catalog of a marketplace. */
const marketplaceRemove: Builder = (args) => {
  const { name } = typedTarget(args);
  if (name === undefined) return null;
  return {
    label: "Remove marketplace",
    title: `Remove the marketplace "${name}"?`,
    description: "Its registry entry and cached catalog are deleted.",
    confirmLabel: "Remove marketplace",
  };
};

/** `/marketplace uninstall`: a plugin's installed files, from the scope it names or the one it is installed in. */
const pluginUninstall: Builder = (args) => {
  const { name, scope } = typedTarget(args);
  if (name === undefined) return null;
  if (scope !== undefined && scope !== "project" && scope !== "user") return null;
  return {
    label: "Uninstall plugin",
    title:
      scope === undefined ? `Uninstall "${name}"?` : `Uninstall "${name}" from the ${scope} scope?`,
    description: "The plugin's installed files are deleted. This cannot be undone.",
    confirmLabel: "Uninstall",
  };
};

/** `/memory clear` and `/memory reset`: omp's persisted memory state and the memory files for the workspace (memories/index.ts:320). */
const memoryClear: Builder = () => ({
  label: "Clear memory",
  title: "Clear all saved memory?",
  description:
    "omp deletes all persisted memory and the generated memory files for this workspace. This cannot be undone.",
  confirmLabel: "Clear memory",
});

/** `/modelpreset delete`: a saved preset. One that a project or `--config` file defines stays, and omp says so. */
const presetDelete: Builder = (args) => {
  const { name } = typedTarget(args);
  if (name === undefined) return null;
  return {
    label: "Delete model preset",
    title: `Delete the model preset "${name}"?`,
    description:
      "Only a saved preset is deleted. A preset that a project or --config file defines stays, and omp says so.",
    confirmLabel: "Delete preset",
  };
};

/**
 * `/forget-approvals`: omp's `clearApprovalGrants` (builtin-control.ts:86-95 runs it and answers "Remembered approvals
 * forgotten; ..."; tools/approval-cache.ts:217-222, omp v18.12.6). It empties both tiers that "Ask and remember" fills
 * (approval-cache.ts:1-11): the in-memory grants of every conversation in that omp process (`sessionsByDir`, :188-190, :220), and
 * `approval-cache.db` in omp's agent folder (`ApprovalCache.clear`, :106-122, a `DELETE FROM grants`), which covers every later
 * session. In this app each chat is its own omp process, so the first tier is this chat's own and other chats keep theirs; the
 * second is one file that every chat, and omp in a terminal, reads from the same folder, so they all lose it. It takes no target,
 * and omp ignores any text typed after it, so the question is always asked.
 */
const forgetApprovals: Builder = () => ({
  label: "Forget approvals",
  title: "Forget every remembered approval?",
  description:
    "omp forgets every file and folder approval it remembered across sessions (kept in omp's own folder, so other chats and omp in a terminal lose them too) and the ones this chat remembered. The next read or write asks again. This cannot be undone.",
  confirmLabel: "Forget approvals",
});

/** The guarded forms that delete data, keyed by the words the app matches them on (routing.ts `GUARDED_OMP_COMMANDS`). */
const QUESTIONS: Record<string, Builder> = {
  "memory clear": memoryClear,
  "memory reset": memoryClear,
  "ssh remove": configEntry("SSH host", "Remove SSH host", "Remove host"),
  "ssh rm": configEntry("SSH host", "Remove SSH host", "Remove host"),
  "mcp remove": configEntry("MCP server", "Remove MCP server", "Remove server"),
  "mcp rm": configEntry("MCP server", "Remove MCP server", "Remove server"),
  "marketplace remove": marketplaceRemove,
  "marketplace rm": marketplaceRemove,
  "marketplace uninstall": pluginUninstall,
  "modelpreset delete": presetDelete,
  "forget-approvals": forgetApprovals,
};

/** The guarded forms that delete data, in the words the app matches them on (`memory clear`, `ssh rm`, ...). */
export const DESTRUCTIVE_FORMS: readonly string[] = Object.keys(QUESTIONS);

/**
 * The question for a typed destructive form (`form` is its name in lower case, `args` the text after its words), or null
 * when the form names no target, or no form of that name deletes data. The question names the target as typed.
 */
export function destructiveQuestion(form: string, args: string): DestructiveQuestion | null {
  if (!Object.hasOwn(QUESTIONS, form)) return null;
  const build = QUESTIONS[form];
  return build === undefined ? null : build(args);
}
