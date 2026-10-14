import { AppFailure, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { routeSlashText, type SlashAppCommand } from "@/modules/D2/slash";
import type { DialogHost } from "@/modules/U4/contract";
import type { ExportPort, ExportRequest, ExportResult } from "../contract";
import { createExportSlashCommands } from "./commands";

const threadId = ThreadId.parse("01a11a8a-ea99-72dd-a84a-017f5d3766ef");

interface Harness {
  readonly commands: readonly SlashAppCommand[];
  readonly requests: ExportRequest[];
  readonly downloads: { readonly fileName: string; readonly text: string }[];
  readonly dialogRequests: unknown[];
}

/**
 * The composer's commands over stand-in ports: the dialog answers `choice` (or cancels), and the export
 * port answers with `result`. Every request, download and dialog is recorded.
 */
function harnessWith(options: {
  readonly choice?: string | "cancelled";
  readonly result?: () => Promise<ExportResult>;
}): Harness {
  const requests: ExportRequest[] = [];
  const downloads: { fileName: string; text: string }[] = [];
  const dialogRequests: unknown[] = [];
  const dialogs = {
    open: (request: unknown) => {
      dialogRequests.push(request);
      return Promise.resolve(
        options.choice === undefined || options.choice === "cancelled"
          ? { outcome: "cancelled", kind: "select", timedOut: false }
          : { outcome: "answered", response: { kind: "select", value: options.choice } },
      );
    },
  };
  const port: ExportPort = {
    export: (request) => {
      requests.push(request);
      return options.result?.() ?? Promise.reject(new Error("no export result was set"));
    },
  };
  const commands = createExportSlashCommands({
    threadId,
    port,
    dialogs: dialogs as unknown as DialogHost,
    download: (fileName, text) => downloads.push({ fileName, text }),
  });
  return { commands, requests, downloads, dialogRequests };
}

function commandNamed(commands: readonly SlashAppCommand[], name: string): SlashAppCommand {
  const command = commands.find((entry) => entry.name === name);
  if (command === undefined) throw new Error(`no /${name} command`);
  return command;
}

async function failureOf(run: () => Promise<unknown>): Promise<AppFailure> {
  try {
    await run();
  } catch (error) {
    if (error instanceof AppFailure) return error;
    throw error;
  }
  throw new Error("the command resolved where a failure was expected");
}

const markdownFile: ExportResult = {
  kind: "download",
  format: "markdown",
  source: "transcript",
  download: { filename: "omp-chat.md", mediaType: "text/markdown", content: "## You\n\nhi" },
};

describe("the export slash commands", () => {
  test("the four commands the composer runs are /export, /dump, /open and /record", () => {
    const { commands } = harnessWith({});
    expect(commands.map((entry) => entry.name)).toEqual(["export", "dump", "open", "record"]);
  });

  test("a typed /dump and /dump all route to the dump command, with all as its argument", () => {
    const { commands } = harnessWith({});
    expect(routeSlashText("/dump", [], commands)).toEqual({
      kind: "app",
      command: commandNamed(commands, "dump"),
    });
    expect(routeSlashText("/dump all", [], commands)).toEqual({
      kind: "app",
      command: commandNamed(commands, "dump"),
      args: "all",
    });
  });

  test("/export opens a picker that lists the three formats, as an app-origin select", async () => {
    const harness = harnessWith({
      choice: "Markdown file",
      result: () => Promise.resolve(markdownFile),
    });
    await commandNamed(harness.commands, "export").run({});
    expect(harness.dialogRequests).toEqual([
      expect.objectContaining({
        kind: "select",
        title: "Export this chat",
        options: ["Markdown file", "Plain text file", "HTML page"],
      }),
    ]);
  });

  test("choosing Markdown saves omp-chat.md through the download path and says it was requested", async () => {
    const harness = harnessWith({
      choice: "Markdown file",
      result: () => Promise.resolve(markdownFile),
    });
    const outcome = await commandNamed(harness.commands, "export").run({});
    expect(harness.requests).toEqual([{ format: "markdown", threadId }]);
    expect(harness.downloads).toEqual([{ fileName: "omp-chat.md", text: "## You\n\nhi" }]);
    expect(outcome).toEqual({ message: "Download requested for omp-chat.md (10 characters)." });
  });

  test("choosing HTML reports the path omp gave and saves nothing in the browser", async () => {
    const harness = harnessWith({
      choice: "HTML page",
      result: () =>
        Promise.resolve({
          kind: "path",
          format: "html",
          source: "omp",
          path: "omp-session-x.html",
        }),
    });
    const outcome = await commandNamed(harness.commands, "export").run({});
    expect(outcome).toEqual({
      message: "omp saved the chat as a web page in this chat's folder: omp-session-x.html",
    });
    expect(harness.downloads).toEqual([]);
  });

  test("a page saved at a full path names that path", async () => {
    const harness = harnessWith({
      choice: "HTML page",
      result: () =>
        Promise.resolve({
          kind: "path",
          format: "html",
          source: "omp",
          path: "/work/omp-session-x.html",
        }),
    });
    const outcome = await commandNamed(harness.commands, "export").run({});
    expect(outcome).toEqual({
      message: "omp saved the chat as a web page: /work/omp-session-x.html",
    });
  });

  test("cancelling the picker exports nothing", async () => {
    const harness = harnessWith({ choice: "cancelled" });
    const outcome = await commandNamed(harness.commands, "export").run({});
    expect(outcome).toEqual({ message: "Nothing was exported." });
    expect(harness.requests).toEqual([]);
  });

  test("/dump saves omp's session report as omp-dump.md", async () => {
    const harness = harnessWith({
      result: () =>
        Promise.resolve({
          kind: "report",
          format: "dump",
          source: "omp",
          text: "## System Prompt",
        }),
    });
    const outcome = await commandNamed(harness.commands, "dump").run({});
    expect(harness.requests).toEqual([{ format: "dump", threadId, scope: "session" }]);
    expect(harness.downloads).toEqual([{ fileName: "omp-dump.md", text: "## System Prompt" }]);
    expect(outcome).toEqual({ message: "Download requested for omp-dump.md (16 characters)." });
  });

  test("/dump all saves omp's archive report as omp-dump-archive.txt", async () => {
    const harness = harnessWith({
      result: () =>
        Promise.resolve({
          kind: "report",
          format: "dump",
          source: "omp",
          text: "Session dump archive: x",
        }),
    });
    await commandNamed(harness.commands, "dump").run({ args: "all" });
    expect(harness.requests).toEqual([{ format: "dump", threadId, scope: "all" }]);
    expect(harness.downloads.map((entry) => entry.fileName)).toEqual(["omp-dump-archive.txt"]);
  });

  test("/dump with other words is refused, and nothing is asked of omp", async () => {
    const harness = harnessWith({});
    const failure = await failureOf(() =>
      commandNamed(harness.commands, "dump").run({ args: "later" }),
    );
    expect(failure.appError).toMatchObject({
      code: "invalid_args",
      message: "Use /dump for this chat, or /dump all for where omp archived it.",
    });
    expect(harness.requests).toEqual([]);
    expect(harness.downloads).toEqual([]);
  });

  test("a failure from the port reaches the composer as the same typed failure", async () => {
    const harness = harnessWith({
      result: () =>
        Promise.reject(
          new AppFailure({
            code: "not_found",
            message: "There are no messages to dump yet.",
            retryable: false,
          }),
        ),
    });
    const failure = await failureOf(() =>
      commandNamed(harness.commands, "dump").run({ args: "all" }),
    );
    expect(failure.appError).toMatchObject({
      code: "not_found",
      message: "There are no messages to dump yet.",
    });
    expect(harness.downloads).toEqual([]);
  });

  test("/open and /record say they work only in omp's terminal, and do nothing else", async () => {
    const harness = harnessWith({});
    const open = await failureOf(() => commandNamed(harness.commands, "open").run({}));
    const record = await failureOf(() => commandNamed(harness.commands, "record").run({}));
    expect(open.appError).toMatchObject({
      code: "unavailable",
      message: "/open only runs in omp's terminal, so nothing was sent.",
    });
    expect(record.appError).toMatchObject({
      code: "unavailable",
      message: "/record only runs in omp's terminal, so nothing was sent.",
    });
    expect(harness.dialogRequests).toEqual([]);
    expect(harness.requests).toEqual([]);
  });
});
