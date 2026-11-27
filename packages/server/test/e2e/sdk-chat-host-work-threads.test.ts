/**
 * The chat host's Workbench tools (`thread_*`), end to end on the fake model provider: every chat has them with no page
 * or host tools set; the fake model calls one (`call_tool thread_open <json>`), the host asks the app (`app.threads`)
 * naming the tool and saying the chat's own agent called, and the model reads the app's answer. Runs from source and
 * compiled (`sdk-chat-host-harness.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { HostRequest } from "@omp-app/contracts/chat-host";
import { chatHostChats, lastReply, PROGRAMS, realTest, resultOf } from "./sdk-chat-host-harness";

const chats = chatHostChats();
afterEach(() => chats.stopAll(), 60_000);

describe("the chat host's Workbench tools", () => {
  for (const program of PROGRAMS) {
    const programTest = program.command === undefined ? test.skip : realTest;
    const command = program.command ?? [];

    programTest(
      `${program.name}: every chat has them; a call reaches the app as app.threads naming the tool, and its answer the model`,
      async () => {
        const chat = await chats.start(command);
        const asked: HostRequest[] = [];
        chat.client.onRequest(async (request) => {
          asked.push(request);
          return request.method === "app.threads"
            ? { content: [{ type: "text", text: 'Opened thread abc123 "Slow new chat".' }] }
            : { content: [], isError: true };
        });
        const hello = await chat.client.hello;
        expect(hello.features ?? []).toContain("work_threads");
        await chat.client.request("prompt", {
          text: 'call_tool thread_open {"title":"Slow new chat","kind":"bug","text":"30 s to list"}',
        });
        await chat.next(resultOf("1"));
        expect(lastReply(chat)).toBe('tool said: Opened thread abc123 "Slow new chat".');
        expect(asked).toMatchObject([
          {
            method: "app.threads",
            params: {
              tool: "thread_open",
              agent: "main",
              params: { title: "Slow new chat", kind: "bug", text: "30 s to list" },
            },
          },
        ]);
      },
      60_000,
    );
  }
});
