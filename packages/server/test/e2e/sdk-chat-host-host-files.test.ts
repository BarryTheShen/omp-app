/**
 * A chat whose files are on the computer of the app that shows it (`--app-host-files=<host>`, `chat-host/host-files.ts`),
 * end to end on the fake model provider: omp offers none of its own tools that work on this computer's files and
 * shell, keeps `read` and `write`, and its system prompt says where the files are. A chat without the flag offers them.
 * Runs from source and compiled (`sdk-chat-host-harness.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
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

/** omp's tools that reach this computer's files, shell or code, and its subagents, which would too: a chat offers them. */
const LOCAL_TOOLS = ["bash", "edit", "eval", "glob", "grep", "task"];

/** A tool of the host, as a panel registers it (`hostToolDefinitions`): it reads the project's files on its computer. */
const HOST_READ = {
  name: "testhost_read",
  description: "Reads a file of the project on the host's computer",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  loadMode: "essential" as const,
};

async function ask(chat: Chat, text: string, requestId: string): Promise<string> {
  await chat.client.request("prompt", { text });
  await chat.next(resultOf(requestId));
  return lastReply(chat);
}

/** A chat started with `args` whose host answers its tool's calls with the file's text, as a panel would. */
async function chatWithHostTool(
  command: readonly string[],
  args: readonly string[],
): Promise<Chat> {
  const chat = await chats.start(command, { args: [...args] });
  chat.client.onRequest(async () => ({ content: [{ type: "text", text: "# Demo, on the host" }] }));
  await chat.client.hello;
  expect(await chat.client.request("set_host_tools", { tools: [HOST_READ] })).toEqual({
    toolNames: ["testhost_read"],
  });
  return chat;
}

/** The tool names a `tools_offered` reply lists. */
const offeredIn = (reply: string): readonly string[] => reply.replace(/^tools: /, "").split(", ");

describe("a chat whose files are on its host", () => {
  for (const program of PROGRAMS) {
    const programTest = program.command === undefined ? test.skip : realTest;
    const command = program.command ?? [];

    programTest(
      `${program.name}: omp offers no tool for this computer's files or shell, keeps read and write, and says where the files are`,
      async () => {
        const chat = await chatWithHostTool(command, ["--app-host-files=testhost"]);
        // Request 1 set the host's tool; the prompts are 2 on.
        const offered = offeredIn(await ask(chat, "tools_offered", "2"));
        for (const name of ["testhost_read", "read", "write"]) expect(offered).toContain(name);
        for (const name of LOCAL_TOOLS) expect(offered).not.toContain(name);
        expect(await ask(chat, 'call_tool testhost_read {"path":"README.md"}', "3")).toBe(
          "tool said: # Demo, on the host",
        );
        expect(await ask(chat, "system_has Where this chat's files are", "4")).toBe(
          "system has it",
        );
        expect(await ask(chat, "system_has their names start with `testhost_`", "5")).toBe(
          "system has it",
        );
      },
      90_000,
    );

    programTest(
      `${program.name}: a chat without it offers omp's own tools, and says nothing of a host`,
      async () => {
        const chat = await chatWithHostTool(command, []);
        const offered = offeredIn(await ask(chat, "tools_offered", "2"));
        for (const name of ["testhost_read", "read", "write", ...LOCAL_TOOLS])
          expect(offered).toContain(name);
        expect(await ask(chat, "system_has Where this chat's files are", "3")).toBe(
          "system lacks it",
        );
      },
      90_000,
    );
  }
});
