import type { OmpCommandGateway, PortClient, RpcSessionClient } from "@omp-app/contracts";
import { AppFailure, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { KeyedTranscriptMessage } from "@/modules/U1/copy";
import type { ExportPort, ExportRequest } from "../contract";
import { type CopySourceMessage, createCopySourceReader } from "../copy";
import { realChatEntries } from "../copy/fixtures/real-chat";
import { chatAsMarkdown, chatAsPlainText } from "./format";
import { createExportPort } from "./port";
import type { ChatHistory } from "./whole-chat";

const threadId = ThreadId.parse("01a11a8a-ea99-72dd-a84a-017f5d3766ef");

/** The recorded chat as the store holds it: keyed messages, oldest first. */
function recordedEntries(): readonly KeyedTranscriptMessage[] {
  return realChatEntries();
}

/** The recorded chat as copy sources, for the expected files. */
function recordedChat(): readonly CopySourceMessage[] {
  return createCopySourceReader()(recordedEntries());
}

/** A chat whose messages are all loaded: nothing older is left to read. */
function loadedHistory(
  messages: () => readonly KeyedTranscriptMessage[],
): ChatHistory<KeyedTranscriptMessage> {
  return {
    messages,
    loadedEntries: () => messages().length,
    hasOlder: () => false,
    loadOlder: () => Promise.resolve(),
  };
}

/**
 * A chat the store shows from its newest page. Each loadOlder adds the page before it, as the runtime store does,
 * and `loads` counts them.
 */
function pagedHistory(
  newest: readonly KeyedTranscriptMessage[],
  older: readonly KeyedTranscriptMessage[],
): { readonly history: ChatHistory<KeyedTranscriptMessage>; readonly loads: () => number } {
  let shown = [...newest];
  let pending = [...older];
  let loads = 0;
  return {
    loads: () => loads,
    history: {
      messages: () => shown,
      loadedEntries: () => shown.length,
      hasOlder: () => pending.length > 0,
      loadOlder: () => {
        loads += 1;
        shown = [...pending, ...shown];
        pending = [];
        return Promise.resolve();
      },
    },
  };
}

interface Doubles {
  readonly sent: unknown[];
  readonly dumped: unknown[];
}

/** The RPC and gateway ports as the port uses them, with each call recorded. */
function portWith(
  options: {
    readonly history?: ChatHistory<KeyedTranscriptMessage>;
    readonly messages?: () => readonly KeyedTranscriptMessage[];
    readonly send?: () => Promise<unknown>;
    readonly dump?: () => Promise<unknown>;
  } = {},
): { readonly port: ExportPort } & Doubles {
  const sent: unknown[] = [];
  const dumped: unknown[] = [];
  const session = {
    send: (args: unknown) => {
      sent.push(args);
      return options.send?.() ?? Promise.resolve({ path: "omp-session-fixture.html" });
    },
  };
  const gateway = {
    dump: (args: unknown) => {
      dumped.push(args);
      return options.dump?.() ?? Promise.resolve({ scope: "session", text: "dump", empty: false });
    },
  };
  const port = createExportPort({
    threadId,
    history: options.history ?? loadedHistory(options.messages ?? recordedEntries),
    session: session as unknown as Pick<RpcSessionClient, "send">,
    gateway: gateway as unknown as Pick<PortClient<typeof OmpCommandGateway>, "dump">,
  });
  return { port, sent, dumped };
}

async function failureOf(run: () => Promise<unknown>): Promise<AppFailure> {
  try {
    await run();
  } catch (error) {
    if (error instanceof AppFailure) return error;
    throw error;
  }
  throw new Error("the export resolved where a failure was expected");
}

describe("transcript downloads", () => {
  test("a whole chat downloads as Markdown from the raw parts, as omp-chat.md", async () => {
    const { port } = portWith();
    const result = await port.export({ format: "markdown", threadId });
    expect(result).toEqual({
      kind: "download",
      format: "markdown",
      source: "transcript",
      download: {
        filename: "omp-chat.md",
        mediaType: "text/markdown",
        content: chatAsMarkdown(recordedChat()),
      },
    });
  });

  test("a whole chat downloads as plain text, as omp-chat.txt", async () => {
    const { port } = portWith();
    const result = await port.export({ format: "plain", threadId });
    expect(result).toEqual({
      kind: "download",
      format: "plain",
      source: "transcript",
      download: {
        filename: "omp-chat.txt",
        mediaType: "text/plain",
        content: chatAsPlainText(recordedChat()),
      },
    });
  });

  test("one message downloads alone, under the message's own name", async () => {
    const { port } = portWith();
    const first = recordedChat()[0];
    if (first === undefined) throw new Error("the recorded chat has no messages");
    expect(first.raw.messageKey).toBe("entry:01a11a8a-ea99-72dd-a84a-017f5d3766ef:b8e8c20d");
    const result = await port.export({
      format: "markdown",
      threadId,
      target: {
        kind: "message",
        messageKey: "entry:01a11a8a-ea99-72dd-a84a-017f5d3766ef:b8e8c20d",
      },
    });
    if (result.kind !== "download") throw new Error("expected a download");
    expect(result.download.filename).toBe("omp-message.md");
    expect(result.download.content.startsWith("## You\n\n")).toBe(true);
    expect(result.download.content).not.toContain("## omp");
  });

  test("a message that is no longer in the chat is not found", async () => {
    const { port } = portWith();
    const failure = await failureOf(() =>
      port.export({
        format: "plain",
        threadId,
        target: { kind: "message", messageKey: "entry:gone:missing" },
      }),
    );
    expect(failure.appError).toMatchObject({
      code: "not_found",
      message: "That message is no longer in this chat.",
    });
  });

  test("an empty chat has nothing to export, so nothing is downloaded", async () => {
    const { port } = portWith({ messages: () => [] });
    const failure = await failureOf(() => port.export({ format: "markdown", threadId }));
    expect(failure.appError).toMatchObject({
      code: "not_found",
      message: "There is nothing to export in this chat yet.",
    });
  });

  test("a request for another chat is refused before anything is read", async () => {
    const { port } = portWith();
    const failure = await failureOf(() =>
      port.export({ format: "markdown", threadId: ThreadId.parse("another-chat") }),
    );
    expect(failure.appError.code).toBe("not_found");
  });

  test("the export loads the older pages first, so the file holds the whole chat", async () => {
    const entries = recordedEntries();
    const paged = pagedHistory(entries.slice(4), entries.slice(0, 4));
    const { port } = portWith({ history: paged.history });
    const result = await port.export({ format: "markdown", threadId });
    expect(paged.loads()).toBe(1);
    expect(result).toEqual({
      kind: "download",
      format: "markdown",
      source: "transcript",
      download: {
        filename: "omp-chat.md",
        mediaType: "text/markdown",
        content: chatAsMarkdown(recordedChat()),
      },
    });
  });

  test("a message with no text of its own, such as a tool's result, has nothing to export", async () => {
    const { port } = portWith();
    const failure = await failureOf(() =>
      port.export({
        format: "markdown",
        threadId,
        target: {
          kind: "message",
          messageKey: "entry:01a11a8a-ea99-72dd-a84a-017f5d3766ef:64e0a208",
        },
      }),
    );
    expect(failure.appError).toMatchObject({
      code: "not_found",
      message: "That message has no text to export.",
    });
  });
});

describe("HTML pages", () => {
  test("omp's export_html runs with no output path and reports where omp saved the page", async () => {
    const { port, sent } = portWith({
      send: () => Promise.resolve({ path: "omp-session-fixture.html" }),
    });
    const result = await port.export({ format: "html", threadId });
    expect(sent).toEqual([{ threadId, command: { type: "export_html" } }]);
    expect(result).toEqual({
      kind: "path",
      format: "html",
      source: "omp",
      path: "omp-session-fixture.html",
    });
  });

  test("a custom output path is refused, so the browser never picks where omp writes", async () => {
    const { port, sent } = portWith();
    const failure = await failureOf(() =>
      port.export({ format: "html", threadId, outputPath: "/tmp/elsewhere.html" }),
    );
    expect(failure.appError.code).toBe("invalid_args");
    expect(sent).toEqual([]);
  });

  test("a typed failure from the session passes through unchanged", async () => {
    const { port } = portWith({
      send: () =>
        Promise.reject(
          new AppFailure({ code: "unavailable", message: "omp is busy.", retryable: true }),
        ),
    });
    const failure = await failureOf(() => port.export({ format: "html", threadId }));
    expect(failure.appError).toMatchObject({ code: "unavailable", message: "omp is busy." });
  });

  test("a call that throws something else becomes an internal failure with a plain message", async () => {
    const { port } = portWith({ send: () => Promise.reject(new Error("socket closed")) });
    const failure = await failureOf(() => port.export({ format: "html", threadId }));
    expect(failure.appError).toMatchObject({
      code: "internal",
      message: "omp could not save the HTML page.",
    });
  });

  test("an empty path from omp is an internal failure, never a blank link", async () => {
    const { port } = portWith({ send: () => Promise.resolve({ path: "  " }) });
    const failure = await failureOf(() => port.export({ format: "html", threadId }));
    expect(failure.appError.code).toBe("internal");
  });
});

describe("omp's dump reports", () => {
  test("/dump asks for the session scope and returns omp's report text", async () => {
    const { port, dumped } = portWith({
      dump: () =>
        Promise.resolve({ scope: "session", text: "## System Prompt\n\nreport", empty: false }),
    });
    const result = await port.export({ format: "dump", threadId, scope: "session" });
    expect(dumped).toEqual([{ threadId, scope: "session" }]);
    expect(result).toEqual({
      kind: "report",
      format: "dump",
      source: "omp",
      text: "## System Prompt\n\nreport",
    });
  });

  test("/dump all asks for the all scope", async () => {
    const { port, dumped } = portWith({
      dump: () =>
        Promise.resolve({ scope: "all", text: "Session dump archive: /x.zip", empty: false }),
    });
    await port.export({ format: "dump", threadId, scope: "all" });
    expect(dumped).toEqual([{ threadId, scope: "all" }]);
  });

  test("/dump anon asks for the anon scope and returns omp's report", async () => {
    const { port, dumped } = portWith({
      dump: () =>
        Promise.resolve({ scope: "anon", text: "Session dump archive: /x.zip", empty: false }),
    });
    const result = await port.export({ format: "dump", threadId, scope: "anon" });
    expect(dumped).toEqual([{ threadId, scope: "anon" }]);
    expect(result).toEqual({
      kind: "report",
      format: "dump",
      source: "omp",
      text: "Session dump archive: /x.zip",
    });
  });

  test("a dump of a chat with no messages is not found, with nothing to save", async () => {
    const { port } = portWith({
      dump: () => Promise.resolve({ scope: "all", text: "No messages to dump yet.", empty: true }),
    });
    const failure = await failureOf(() => port.export({ format: "dump", threadId, scope: "all" }));
    expect(failure.appError).toMatchObject({
      code: "not_found",
      message: "There are no messages to dump yet.",
    });
  });

  test("a gateway failure passes through; any other failure is an internal one", async () => {
    const typed = portWith({
      dump: () =>
        Promise.reject(
          new AppFailure({ code: "unavailable", message: "No session.", retryable: true }),
        ),
    });
    const typedFailure = await failureOf(() =>
      typed.port.export({ format: "dump", threadId, scope: "session" }),
    );
    expect(typedFailure.appError.code).toBe("unavailable");

    const raw = portWith({ dump: () => Promise.reject(new Error("bad frame")) });
    const rawFailure = await failureOf(() =>
      raw.port.export({ format: "dump", threadId, scope: "session" }),
    );
    expect(rawFailure.appError).toMatchObject({
      code: "internal",
      message: "omp did not return its dump report.",
    });
  });
});

describe("request checks", () => {
  test("a request that is not an export is refused as invalid", async () => {
    const { port } = portWith();
    const failure = await failureOf(() =>
      port.export({ format: "pdf", threadId } as unknown as ExportRequest),
    );
    expect(failure.appError.code).toBe("invalid_args");
  });

  test("a cancelled request starts nothing", async () => {
    const { port, sent } = portWith();
    const controller = new AbortController();
    controller.abort();
    const failure = await failureOf(() =>
      port.export({ format: "html", threadId }, controller.signal),
    );
    expect(failure.appError.code).toBe("cancelled");
    expect(sent).toEqual([]);
  });
});
