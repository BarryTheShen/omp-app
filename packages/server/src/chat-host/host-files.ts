/**
 * A chat whose files are on the computer of the app that shows it (`--app-host-files=<host>`, `host-folders.ts`): omp's
 * own tools that work on this computer's files, shell or code are left out, since this computer has none of the
 * project; the host's own tools reach the files. omp's `read` and `write` stay: they read web pages, skills and omp's
 * internal addresses, and `write` carries omp's `xd://` devices (MCP servers among them).
 */
import { CHAT_HOST_FILES_ARG } from "@omp-app/contracts/chat-host/args";

/** omp's built-in tools such a chat keeps; omp drops the ones its settings turn off. */
export const HOST_FILES_TOOLS: readonly string[] = [
  "read",
  "write",
  "ask",
  "todo",
  "web_search",
  "github",
  "wait",
  "context_notes",
  "new_context",
  "retain",
  "recall",
  "reflect",
  "memory_edit",
  "learn",
  "manage_skill",
];

const HOST = /^[a-z][a-z0-9-]{0,31}$/;

/** The chat's host from its arguments, and the arguments for omp without it. */
export function hostFilesOf(args: readonly string[]): {
  readonly host: string | undefined;
  readonly rest: readonly string[];
} {
  const prefix = `${CHAT_HOST_FILES_ARG}=`;
  let host: string | undefined;
  const rest = args.filter((arg) => {
    if (!arg.startsWith(prefix)) return true;
    const named = arg.slice(prefix.length);
    if (HOST.test(named)) host = named;
    return false;
  });
  return { host, rest };
}

/** The host's name as people know it. */
const hostWords = (host: string): string => (host === "vscode" ? "VS Code" : host);

/** What omp's system prompt adds for such a chat: where the files are, and what reaches them. */
export function hostFilesNote(host: string): string {
  const app = hostWords(host);
  return [
    "# Where this chat's files are",
    `This chat works on a project on the person's own computer, open in ${app} there. This chat runs on another computer, so the project's files and commands are reached only through the tools ${app} gives this chat while its panel is open: their names start with \`${host}_\`. Paths are relative to the project's folder.`,
    `- Read, search, edit and write the project's files, and run its commands, with those tools only. omp's own \`read\` and \`write\` work here on web pages, skills and internal addresses, not on the project.`,
    `- If no \`${host}_\` tool is there, the panel is closed: say so, and ask the person to open omp app's panel in ${app}.`,
  ].join("\n");
}
