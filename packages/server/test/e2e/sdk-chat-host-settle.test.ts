/**
 * The chat host's settle report (SDK plan H5.2g1), end to end on the fake model provider: a yielded run is not always a
 * settled session. Runs from source and compiled (`sdk-chat-host-harness.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chatHostChats, PROGRAMS, realTest, resultOf } from "./sdk-chat-host-harness";

const chats = chatHostChats();
afterEach(() => chats.stopAll(), 60_000);

describe("the chat host's settle report", () => {
  for (const program of PROGRAMS) {
    const programTest = program.command === undefined ? test.skip : realTest;
    const command = program.command ?? [];

    programTest(
      `${program.name}: a plain turn's result says the session is done, and session_settled follows it`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        await chat.client.request("prompt", { text: "hello" });
        expect(await chat.next(resultOf("1"))).toMatchObject({
          status: "completed",
          sessionSettled: true,
        });
        await chat.next((event) => event.type === "session_settled");
        const order = chat.events
          .map(({ event }) => event.type)
          .filter((type) => type === "prompt_result" || type === "session_settled");
        expect(order).toEqual(["prompt_result", "session_settled"]);
        expect((await chat.client.request("get_state", {})).isSettled).toBe(true);
      },
      60_000,
    );

    programTest(
      `${program.name}: a turn that leaves a background job running is not settled until the job is done`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        await chat.client.request("prompt", { text: "run_quick_background" });
        expect(await chat.next(resultOf("1"))).toMatchObject({
          status: "completed",
          sessionSettled: false,
        });
        expect(chat.events.some(({ event }) => event.type === "session_settled")).toBe(false);
        await chat.next((event) => event.type === "session_settled");
        expect((await chat.client.request("get_state", {})).isSettled).toBe(true);
      },
      60_000,
    );
  }
});
