import type {
  DumpScope,
  OmpCommandGateway,
  PortClient,
  RpcSessionClient,
  ThreadId,
} from "@omp-app/contracts";
import type { KeyedTranscriptMessage } from "@/modules/U1/copy";
import {
  type ExportPort,
  type ExportRequest,
  ExportRequestSchema,
  type ExportResult,
} from "../contract";
import { type CopySourceMessage, createCopySourceReader } from "../copy";
import { asFailure, failure } from "./failure";
import { chatAsMarkdown, chatAsPlainText } from "./format";
import { type ChatHistory, readWholeChat } from "./whole-chat";

export interface ExportPortOptions {
  /** The one chat this port exports; a request for any other chat is refused. */
  readonly threadId: ThreadId;
  /**
   * The open chat's messages and older pages. A transcript export loads the whole chat through it first: the store
   * holds only the newest window of a long chat, and a file says it holds the whole chat.
   */
  readonly history: ChatHistory<KeyedTranscriptMessage>;
  /** A0.8's typed session client. `export_html` runs as one typed command, with no output path. */
  readonly session: Pick<RpcSessionClient, "send">;
  /** A1's typed `/dump` and `/dump all` reports (A1 issue 793). */
  readonly gateway: Pick<PortClient<typeof OmpCommandGateway>, "dump">;
}

/** The download names for a whole chat and for one message, per format. */
const FILE_NAMES = {
  chat: { markdown: "omp-chat.md", plain: "omp-chat.txt" },
  message: { markdown: "omp-message.md", plain: "omp-message.txt" },
} as const;

const MEDIA_TYPES = { markdown: "text/markdown", plain: "text/plain" } as const;

/** The download name of a `/dump` report: the session dump is Markdown, the archive report is text. */
const DUMP_FILE_NAMES: Readonly<Record<DumpScope, string>> = {
  session: "omp-dump.md",
  all: "omp-dump-archive.txt",
};

/**
 * D4's ExportPort over one chat. Markdown and plain files come from U1.7's raw parts, of the whole chat; an HTML
 * page is omp's own `export_html`; `/dump` and `/dump all` are A1's typed reports. Nothing is written here: a
 * download is returned for the caller to save through the app's download path.
 */
export function createExportPort(options: ExportPortOptions): ExportPort {
  const readSource = createCopySourceReader();
  return {
    async export(request: ExportRequest, signal?: AbortSignal): Promise<ExportResult> {
      const parsed = ExportRequestSchema.safeParse(request);
      if (!parsed.success) throw failure("invalid_args", "That export request is not valid.");
      if (signal?.aborted === true) throw failure("cancelled", "The export was cancelled.");
      const value = parsed.data;
      if (value.threadId !== options.threadId) {
        throw failure("not_found", "That chat is not open here.");
      }
      switch (value.format) {
        case "markdown":
        case "plain":
          return transcriptFile(value.format, value.target?.messageKey, signal);
        case "html":
          return htmlPage(value.outputPath, signal);
        case "dump":
          return dumpReport(value.scope, signal);
      }
    },
  };

  async function transcriptFile(
    format: "markdown" | "plain",
    messageKey: CopySourceMessage["raw"]["messageKey"] | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ExportResult> {
    const messages = readSource(await readWholeChat(options.history, signal));
    const chosen =
      messageKey === undefined
        ? messages
        : messages.filter((message) => message.raw.messageKey === messageKey);
    if (messageKey !== undefined && chosen.length === 0) {
      throw failure("not_found", "That message is no longer in this chat.");
    }
    const content = format === "markdown" ? chatAsMarkdown(chosen) : chatAsPlainText(chosen);
    if (content.trim() === "") {
      throw failure(
        "not_found",
        messageKey === undefined
          ? "There is nothing to export in this chat yet."
          : "That message has no text to export.",
      );
    }
    const names = messageKey === undefined ? FILE_NAMES.chat : FILE_NAMES.message;
    return {
      kind: "download",
      format,
      source: "transcript",
      download: { filename: names[format], mediaType: MEDIA_TYPES[format], content },
    };
  }

  async function htmlPage(
    outputPath: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ExportResult> {
    if (outputPath !== undefined) {
      throw failure(
        "invalid_args",
        "A custom location is not supported: the browser does not choose where omp writes files.",
      );
    }
    const saved = await asFailure(
      () =>
        options.session.send(
          { threadId: options.threadId, command: { type: "export_html" } },
          { signal },
        ),
      "omp could not save the HTML page.",
    );
    if (saved.path.trim() === "") {
      throw failure("internal", "omp did not say where it saved the HTML page.");
    }
    return { kind: "path", format: "html", source: "omp", path: saved.path };
  }

  async function dumpReport(
    scope: DumpScope,
    signal: AbortSignal | undefined,
  ): Promise<ExportResult> {
    const report = await asFailure(
      () => options.gateway.dump({ threadId: options.threadId, scope }, { signal }),
      "omp did not return its dump report.",
    );
    if (report.empty) throw failure("not_found", "There are no messages to dump yet.");
    return { kind: "report", format: "dump", source: "omp", text: report.text };
  }
}

/** The download name for a `/dump` report, by scope. */
export function dumpFileName(scope: DumpScope): string {
  return DUMP_FILE_NAMES[scope];
}
