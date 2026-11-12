/**
 * `ask_first` (the chats of a browser panel), end to end on the fake model provider: before it, a command runs with no
 * asking (omp's default approval mode, "yolo"); after it, the chat asks the app first (`ui.approve`) and runs the command
 * only when allowed, reads freely, calls the page's own tools with no asking (the page answers them), asks before a
 * change to the shared to-do list, does not message subagents, and asks again after its host starts anew on the same
 * file; a stricter mode the person chose is kept. The fake model calls a tool with `call_tool <tool> <json>`, then says
 * what the tool gave it. Runs from source and compiled (`sdk-chat-host-harness.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import type { HostRequest } from "@omp-app/contracts/chat-host";
import {
  type Chat,
  chatHostChats,
  lastReply,
  PROGRAMS,
  realTest,
  resultOf,
} from "./sdk-chat-host-harness";

const chats = chatHostChats();
afterEach(() => chats.stopAll(), 60_000);

/** Has the fake model call `tool` with `args`, as request `id`; gives back the model's reply. */
async function call(chat: Chat, id: string, tool: string, args: unknown): Promise<string> {
  await chat.client.request("prompt", { text: `call_tool ${tool} ${JSON.stringify(args)}` });
  await chat.next(resultOf(id));
  return lastReply(chat);
}

const bash = (chat: Chat, id: string, command: string): Promise<string> =>
  call(chat, id, "bash", { command });

/**
 * Plays the app: a page tool's call and the to-do list answer, an approval gets `approval()`; every request is kept.
 */
function answering(chat: Chat, approval: () => unknown): HostRequest[] {
  const asked: HostRequest[] = [];
  chat.client.onRequest(async (request) => {
    asked.push(request);
    if (request.method === "tool.call") return { content: [{ type: "text", text: "Shop" }] };
    if (request.method === "app.todos") return { content: [{ type: "text", text: "0 to do." }] };
    return approval();
  });
  return asked;
}

const approvals = (asked: readonly HostRequest[]): number =>
  asked.filter((request) => request.method === "ui.approve").length;

/** A tool of the page's, as a browser panel gives one. */
const PAGE_TITLE = {
  name: "page_title",
  description: "Says the title of the page the panel shows",
  parameters: { type: "object", properties: {} },
};

/** The chat's file under its agent folder. */
async function sessionFile(chat: Chat): Promise<string> {
  const agentDir = join(dirname(chat.folder), "agent");
  for await (const file of new Bun.Glob("sessions/**/*.jsonl").scan({ cwd: agentDir })) {
    return join(agentDir, file);
  }
  throw new Error("the chat has no file");
}

const exists = (folder: string, name: string): Promise<boolean> =>
  Bun.file(join(folder, name)).exists();

describe("a chat told to ask first", () => {
  for (const program of PROGRAMS) {
    const programTest = program.command === undefined ? test.skip : realTest;
    const command = program.command ?? [];

    programTest(
      `${program.name}: asks before a command and a to-do change, reads and calls the page's tools freely, messages no subagent, and asks again after its host starts anew`,
      async () => {
        const chat = await chats.start(command);
        let approval: unknown = "deny";
        const asked = answering(chat, () => approval);
        await chat.client.hello;

        // omp's default: a command runs with no asking.
        expect(await bash(chat, "1", "printf free > free.txt; printf free")).toContain(
          "tool said: free",
        );
        expect(asked).toEqual([]);

        expect(await chat.client.request("ask_first", {})).toEqual({ approvalMode: "always-ask" });
        // Asked, and denied: the command never ran.
        expect(await bash(chat, "3", "printf held > held.txt; printf held")).not.toContain(
          "tool said: held",
        );
        expect(approvals(asked)).toBe(1);
        expect(await exists(chat.folder, "held.txt")).toBe(false);
        // Asked again, and allowed once: it ran.
        approval = "once";
        expect(await bash(chat, "4", "printf allowed > allowed.txt; printf allowed")).toContain(
          "tool said: allowed",
        );
        expect(approvals(asked)).toBe(2);
        expect(await exists(chat.folder, "allowed.txt")).toBe(true);
        // Reading stays free.
        expect(await call(chat, "5", "read", { path: "allowed.txt" })).toContain("allowed");
        expect(approvals(asked)).toBe(2);
        // The page's own tool: the page answers it, with no asking.
        await chat.client.request("set_host_tools", { tools: [PAGE_TITLE] });
        expect(await call(chat, "7", "page_title", {})).toContain("tool said: Shop");
        expect(approvals(asked)).toBe(2);
        // The shared to-do list: read freely; a change asks, and denied, it never reaches the app.
        approval = "deny";
        expect(await call(chat, "8", "shared_todos", { action: "list" })).toContain("0 to do.");
        expect(approvals(asked)).toBe(2);
        await call(chat, "9", "shared_todos", { action: "add", title: "run this later" });
        expect(approvals(asked)).toBe(3);
        expect(
          asked.filter(
            (request) =>
              request.method === "app.todos" &&
              (request.params as { action?: string }).action === "add",
          ),
        ).toEqual([]);
        // Subagents run without asking: the chat does not message them.
        expect(
          await call(chat, "10", "write", { path: "agent://all", content: "run this" }),
        ).toContain("does not message subagents");
        expect(approvals(asked)).toBe(3);

        // Its host starts anew on the same file, with no ask_first: it still asks.
        const file = await sessionFile(chat);
        await chat.process.stop();
        const again = await chats.start(command, { args: ["--resume", file] });
        const askedAgain = answering(again, () => "deny");
        await again.client.hello;
        await bash(again, "1", "printf later > later.txt; printf later");
        expect(approvals(askedAgain)).toBe(1);
        expect(await exists(chat.folder, "later.txt")).toBe(false);
        expect(await exists(again.folder, "later.txt")).toBe(false);
      },
      120_000,
    );

    programTest(
      `${program.name}: keeps a stricter mode the person chose, which asks before reading files too`,
      async () => {
        const chat = await chats.start(command, {
          config: "tools:\n  approvalMode: always-ask-cached\n",
        });
        const asked = answering(chat, () => "deny");
        await chat.client.hello;
        expect(await chat.client.request("ask_first", {})).toEqual({
          approvalMode: "always-ask-cached",
        });
        await Bun.write(join(chat.folder, "notes.txt"), "private");
        await call(chat, "2", "read", { path: "notes.txt" });
        expect(approvals(asked)).toBe(1);
      },
      60_000,
    );
  }
});
