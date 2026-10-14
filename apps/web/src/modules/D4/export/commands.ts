import { AppFailure, type DumpScope, type ThreadId, UiRequestId } from "@omp-app/contracts";
import type { SlashAppCommand } from "@/modules/D2/slash";
import type { DialogHost } from "@/modules/U4/contract";
import type { ExportPort, ExportResult } from "../contract";
import { dumpFileName } from "./port";

export interface ExportCommandDeps {
  readonly threadId: ThreadId;
  readonly port: ExportPort;
  /** U4's dialog host, injected: the picker opens app-origin dialogs only, so no omp answer is sent. */
  readonly dialogs: DialogHost;
  /** Saves text through the app's download path, injected so D4 never touches the DOM. */
  readonly download: (fileName: string, text: string) => void;
}

/** The three formats the export picker offers, in the order it lists them. */
const EXPORT_CHOICES = [
  {
    label: "Markdown file",
    format: "markdown",
    description:
      "Your messages and omp's replies as their exact Markdown. Saved to your downloads.",
  },
  {
    label: "Plain text file",
    format: "plain",
    description:
      "Each message's text as omp recorded it, Markdown marks included. Saved to your downloads.",
  },
  {
    label: "HTML page",
    format: "html",
    description: "omp writes the chat as a web page and tells you where it saved it.",
  },
] as const;

/** Why `/open` and `/record` do nothing here: both only run in omp's terminal, as D2 says. */
const TERMINAL_ONLY_MESSAGES = {
  open: "/open only runs in omp's terminal, so nothing was sent.",
  record: "/record only runs in omp's terminal, so nothing was sent.",
} as const;

/** App-origin dialog ids begin with `app-`. One counter keeps them unique across every picker. */
let requestSequence = 0;
function requestId(purpose: string): UiRequestId {
  requestSequence += 1;
  return UiRequestId.parse(`app-export-${purpose}-${requestSequence}`);
}

/** The AbortSignal a port call takes, when the composer passed one. */
function abortOf(signal: unknown): AbortSignal | undefined {
  return signal instanceof AbortSignal ? signal : undefined;
}

/** Where omp saved the page. omp runs in the chat's folder, so a bare file name is saved there. */
function savedPageMessage(path: string): string {
  return /[\\/]/.test(path)
    ? `omp saved the chat as a web page: ${path}`
    : `omp saved the chat as a web page in this chat's folder: ${path}`;
}

/**
 * The export picker: asks for a format, runs it, and saves a file through the download path. A file is
 * reported as requested, never as saved, because the browser decides what happens to the download.
 */
async function exportChat(
  deps: ExportCommandDeps,
  signal: AbortSignal | undefined,
): Promise<string> {
  const choice = await deps.dialogs.open(
    {
      kind: "select",
      id: requestId("export"),
      title: "Export this chat",
      options: EXPORT_CHOICES.map((entry) => entry.label),
      optionDetails: EXPORT_CHOICES.map((entry) => ({ description: entry.description })),
    },
    { threadId: deps.threadId, origin: "app", signal },
  );
  if (choice.outcome === "cancelled") return "Nothing was exported.";
  const picked = EXPORT_CHOICES.find((entry) => entry.label === choice.response.value);
  if (picked === undefined) {
    throw new AppFailure({
      code: "internal",
      message: "That export option is not one of the choices.",
      retryable: false,
    });
  }
  const result = await deps.port.export({ format: picked.format, threadId: deps.threadId }, signal);
  if (result.kind === "path") return savedPageMessage(result.path);
  if (result.kind !== "download") {
    throw new AppFailure({
      code: "internal",
      message: "omp's reply did not match the export that was asked for.",
      retryable: false,
    });
  }
  const { filename, content } = result.download;
  deps.download(filename, content);
  const count = content.length === 1 ? "1 character" : `${content.length} characters`;
  return `Download requested for ${filename} (${count}).`;
}

/** `/dump` and `/dump all`: omp's typed report, saved as a file through the download path. */
async function dumpChat(
  deps: ExportCommandDeps,
  scope: DumpScope,
  signal: AbortSignal | undefined,
): Promise<string> {
  const result: ExportResult = await deps.port.export(
    { format: "dump", threadId: deps.threadId, scope },
    signal,
  );
  if (result.kind !== "report") {
    throw new AppFailure({
      code: "internal",
      message: "omp's dump did not come back as a report.",
      retryable: false,
    });
  }
  const filename = dumpFileName(scope);
  deps.download(filename, result.text);
  const count = result.text.length === 1 ? "1 character" : `${result.text.length} characters`;
  return `Download requested for ${filename} (${count}).`;
}

/**
 * The scope the words after `/dump` ask for: none is this chat's dump, and `all` is omp's archive report.
 * Any other words are refused, so a typo never saves the wrong report.
 */
function dumpScopeOf(args: string | undefined): DumpScope {
  const words = (args ?? "").trim().toLowerCase();
  if (words === "") return "session";
  if (words === "all") return "all";
  throw new AppFailure({
    code: "invalid_args",
    message: "Use /dump for this chat, or /dump all for where omp archived it.",
    retryable: false,
  });
}

/**
 * D4's export slash commands, for the composition to hand to the composer as app commands. `/export`
 * opens the picker; `/dump` and `/dump all` save omp's reports; `/open` and `/record` are terminal-only
 * and fail with the reason, so the composer shows it and keeps the typed text.
 */
export function createExportSlashCommands(deps: ExportCommandDeps): readonly SlashAppCommand[] {
  return [
    {
      name: "export",
      description: "Export this chat",
      run: async ({ signal }) => ({ message: await exportChat(deps, abortOf(signal)) }),
    },
    {
      name: "dump",
      description: "Save omp's dump of this chat. /dump all saves where omp archived it instead.",
      takesArguments: true,
      run: async ({ signal, args }) => ({
        message: await dumpChat(deps, dumpScopeOf(args), abortOf(signal)),
      }),
    },
    {
      name: "open",
      description: "Only runs in omp's terminal",
      run: () =>
        Promise.reject(
          new AppFailure({
            code: "unavailable",
            message: TERMINAL_ONLY_MESSAGES.open,
            retryable: false,
          }),
        ),
    },
    {
      name: "record",
      description: "Only runs in omp's terminal",
      run: () =>
        Promise.reject(
          new AppFailure({
            code: "unavailable",
            message: TERMINAL_ONLY_MESSAGES.record,
            retryable: false,
          }),
        ),
    },
  ];
}
