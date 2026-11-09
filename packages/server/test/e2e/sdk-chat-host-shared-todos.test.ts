/**
 * The chat host's `shared_todos` tool (D7), end to end on the fake model provider: every chat has it with no page or
 * host tools set; the fake model calls it (`call_tool shared_todos <json>`), the host asks the app (`app.todos`) saying
 * the chat's own agent called, and the model reads the app's answer. Runs from source and compiled
 * (`sdk-chat-host-harness.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { HostRequest } from "@omp-app/contracts/chat-host";
import { chatHostChats, lastReply, PROGRAMS, realTest, resultOf } from "./sdk-chat-host-harness";

const chats = chatHostChats();
afterEach(() => chats.stopAll(), 60_000);

describe("the chat host's shared_todos tool", () => {
  for (const program of PROGRAMS) {
    const programTest = program.command === undefined ? test.skip : realTest;
    const command = program.command ?? [];

    programTest(
      `${program.name}: every chat has it; a call reaches the app as app.todos from the chat's agent, and its answer the model`,
      async () => {
        const chat = await chats.start(command);
        const asked: HostRequest[] = [];
        chat.client.onRequest(async (request) => {
          asked.push(request);
          return request.method === "app.todos"
            ? { content: [{ type: "text", text: "2 to do (1 doing)." }] }
            : { content: [], isError: true };
        });
        const hello = await chat.client.hello;
        expect(hello.features ?? []).toContain("shared_todos");
        await chat.client.request("prompt", {
          text: 'call_tool shared_todos {"action":"list","includeDone":true}',
        });
        await chat.next(resultOf("1"));
        expect(lastReply(chat)).toBe("tool said: 2 to do (1 doing).");
        expect(asked).toMatchObject([
          { method: "app.todos", params: { agent: "main", action: "list", includeDone: true } },
        ]);
      },
      60_000,
    );
  }
});
