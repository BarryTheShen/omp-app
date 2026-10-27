/**
 * The chat host on omp's SDK (SDK plan H5.1), end to end on the fake model provider: hello, a streamed prompt and its
 * result, Stop, and a start that fails. Runs from source and compiled (`sdk-chat-host-harness.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chatHostChats, PROGRAMS, realTest, resultOf } from "./sdk-chat-host-harness";

const chats = chatHostChats();
// Stopping a chat waits for its session to close (omp's SIGTERM cleanup), which takes more than Bun's default 5 s on a
// loaded machine.
afterEach(() => chats.stopAll(), 60_000);

describe("the chat host on omp's SDK", () => {
  for (const program of PROGRAMS) {
    const programTest = program.command === undefined ? test.skip : realTest;
    const command = program.command ?? [];

    programTest(
      `${program.name}: hello names the chat, and its state reads back`,
      async () => {
        const chat = await chats.start(command);
        const hello = await chat.client.hello;
        expect(hello.protocol).toBe(1);
        expect(hello.methods).toEqual(
          expect.arrayContaining(["prompt", "abort", "get_state", "set_event_options"]),
        );
        expect(hello.session.cwd).toBe(chat.folder);
        const state = await chat.client.request("get_state", {});
        expect(state.model).toMatchObject({ provider: "fake", id: "fake-model" });
        expect(state.isStreaming).toBe(false);
        expect(state.sessionId).toBe(hello.session.id);
      },
      60_000,
    );

    programTest(
      `${program.name}: a prompt streams the reply and ends with its result`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        await chat.client.request("set_event_options", { messageUpdates: "delta" });
        const answer = await chat.client.request("prompt", { text: "stream_code" });
        expect(answer).toEqual({ resultFollows: true });
        const result = await chat.next(resultOf("2"));
        expect(result).toMatchObject({ status: "completed", agentInvoked: true });

        const types = chat.events.map((entry) => entry.event.type);
        expect(types.indexOf("agent_start")).toBeLessThan(types.indexOf("message_update"));
        expect(types.lastIndexOf("agent_end")).toBeLessThan(types.indexOf("prompt_result"));
        const updates = chat.events.filter((entry) => entry.event.type === "message_update");
        expect(updates.length).toBeGreaterThan(1);
        for (const { event } of updates) {
          expect(event).toMatchObject({
            messageId: expect.any(String),
            message: { role: "assistant" },
          });
          expect(event).not.toHaveProperty("assistantMessageEvent.partial");
        }
        expect(chat.events.map((entry) => entry.seq)).toEqual(
          chat.events.map((_, index) => index + 1),
        );
        expect((await chat.client.request("get_state", {})).messageCount).toBeGreaterThanOrEqual(2);
      },
      60_000,
    );

    programTest(
      `${program.name}: Stop stops the reply, and the prompt's result says it was aborted`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        await chat.client.request("prompt", { text: "stream_held" });
        await chat.next((event) => event.type === "message_update");
        expect((await chat.client.request("get_state", {})).isStreaming).toBe(true);
        await chat.client.request("abort", {});
        expect(await chat.next(resultOf("1"))).toMatchObject({ status: "aborted" });
        expect((await chat.client.request("get_state", {})).isStreaming).toBe(false);
      },
      60_000,
    );

    programTest(
      `${program.name}: a chat that cannot start ends with the reason on stderr`,
      async () => {
        const chat = await chats.start(command, { args: ["--no-such-flag"] });
        await expect(chat.client.hello).rejects.toMatchObject({ code: "closed" });
        await chat.process.stderrSettled?.();
        expect(chat.process.stderrTail).toContain("unknown flag --no-such-flag");
      },
      60_000,
    );
  }
});
