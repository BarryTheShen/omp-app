import {
  type ChatSessionClient,
  type OmpCommandGateway,
  type PortClient,
  ThreadId,
} from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { routeSlashText, type SlashAppCommand } from "@/modules/D2/slash";
import type { OmpRuntimeStore } from "@/modules/R0/store/store";
import type { DialogHost } from "@/modules/U4/contract";
import { exportSlashCommandsFor } from "./export-commands";

const threadId = ThreadId.parse("01a11a8a-ea99-72dd-a84a-017f5d3766ef");

/**
 * The export commands for the open chat, over fakes: the picker answers `choice` (or is cancelled), the gateway
 * answers each dump with its scope's text, and every dialog, dump and download is recorded.
 */
function mountedWith(choice?: string) {
  const dumped: unknown[] = [];
  const downloads: { fileName: string; text: string }[] = [];
  const dialogRequests: { title?: unknown }[] = [];
  const dialogs = {
    open: (request: { title?: unknown }) => {
      dialogRequests.push(request);
      return Promise.resolve(
        choice === undefined
          ? { outcome: "cancelled", kind: "select", timedOut: false }
          : { outcome: "answered", response: { kind: "select", value: choice } },
      );
    },
  } as unknown as DialogHost;
  const gateway = {
    dump: (args: { scope: string }) => {
      dumped.push(args);
      return Promise.resolve({ scope: args.scope, text: `report for ${args.scope}`, empty: false });
    },
  } as unknown as Pick<PortClient<typeof OmpCommandGateway>, "dump">;
  const store = {
    getSnapshot: () => ({
      messageOrder: [],
      messages: {},
      transcript: { entries: {}, order: [], head: null, hasOlder: false },
    }),
  } as unknown as Pick<OmpRuntimeStore, "getSnapshot">;
  const commands = exportSlashCommandsFor({
    threadId,
    store,
    loadOlder: undefined,
    session: {
      request: () => Promise.reject(new Error("no session call is expected in this test")),
    } as unknown as Pick<ChatSessionClient, "request">,
    gateway,
    dialogs,
    download: (fileName, text) => downloads.push({ fileName, text }),
  });
  return { commands, dumped, downloads, dialogRequests };
}

function commandNamed(commands: readonly SlashAppCommand[], name: string): SlashAppCommand {
  const command = commands.find((entry) => entry.name === name);
  if (command === undefined) throw new Error(`no /${name} command`);
  return command;
}

describe("the export commands mounted in the open chat", () => {
  test("the chat mounts export, dump, open and record", () => {
    expect(mountedWith().commands.map((entry) => entry.name)).toEqual([
      "export",
      "dump",
      "open",
      "record",
    ]);
  });

  test("a typed /export routes to the app's picker, and a typed /dump anon to the dump with anon as its argument", () => {
    const { commands } = mountedWith();
    expect(routeSlashText("/export", [], commands)).toEqual({
      kind: "app",
      command: commandNamed(commands, "export"),
    });
    expect(routeSlashText("/dump anon", [], commands)).toEqual({
      kind: "app",
      command: commandNamed(commands, "dump"),
      args: "anon",
    });
  });

  test("a typed /export opens the picker titled Export this chat, and a cancelled pick exports nothing", async () => {
    const { commands, dialogRequests, downloads } = mountedWith();
    await expect(commandNamed(commands, "export").run({})).resolves.toEqual({
      message: "Nothing was exported.",
    });
    expect(dialogRequests).toHaveLength(1);
    expect(dialogRequests[0]).toMatchObject({ kind: "select", title: "Export this chat" });
    expect(downloads).toEqual([]);
  });

  test("a typed /dump anon asks omp for the anonymized report and saves it as omp-dump-anonymized.txt", async () => {
    const { commands, dumped, downloads } = mountedWith();
    const outcome = await commandNamed(commands, "dump").run({ args: "anon" });
    expect(dumped).toEqual([{ threadId, scope: "anon" }]);
    expect(downloads).toEqual([{ fileName: "omp-dump-anonymized.txt", text: "report for anon" }]);
    expect(outcome).toEqual({
      message: "Download requested for omp-dump-anonymized.txt (15 characters).",
    });
  });
});
