/**
 * Pausing a chat on the chat host (#2766): omp's own pause gate holds every agent of the chat at its next step, end to
 * end on the fake model provider. Runs from source and compiled (`sdk-chat-host-harness.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { chatHostChats, PROGRAMS, realTest } from "./sdk-chat-host-harness";

const chats = chatHostChats();
afterEach(() => chats.stopAll(), 60_000);

/** How long a held chat is watched for a model reply that must not come. */
const HELD_MS = 2_000;

describe("pausing a chat on the chat host", () => {
  for (const program of PROGRAMS) {
    const programTest = program.command === undefined ? test.skip : realTest;
    const command = program.command ?? [];

    programTest(
      `${program.name}: paused, a prompt gets no reply until resumed; viewers and the state know the pause`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        const paused = await chat.client.request("pause", {});
        expect(paused.pausedAt).toEqual(expect.any(Number));
        await chat.next((event) => event.type === "pause_changed" && event.pausedAt !== null);
        expect((await chat.client.request("get_state", {})).pausedAt).toBe(
          paused.pausedAt ?? undefined,
        );
        // Pausing again keeps the first time.
        expect(await chat.client.request("pause", {})).toEqual({ pausedAt: paused.pausedAt });
        // A server that takes the chat over (D2) hears the pause from the replay of what is live.
        const beforeReplay = chat.events.length;
        await chat.client.request("replay_live", {});
        expect(
          chat.events
            .slice(beforeReplay)
            .some(
              ({ event }) => event.type === "pause_changed" && event.pausedAt === paused.pausedAt,
            ),
        ).toBe(true);

        const sent = chat.client.request("prompt", { text: "say hello" });
        await Bun.sleep(HELD_MS);
        const replied = (): boolean =>
          chat.events.some(
            ({ event }) => event.type === "message_start" && event.message.role === "assistant",
          );
        expect(replied()).toBe(false);

        expect(await chat.client.request("resume", {})).toEqual({ pausedAt: null });
        await chat.next((event) => event.type === "pause_changed" && event.pausedAt === null);
        await sent;
        await chat.next(
          (event) => event.type === "message_end" && event.message.role === "assistant",
        );
        await chat.next((event) => event.type === "session_settled");
        expect((await chat.client.request("get_state", {})).pausedAt).toBeUndefined();
      },
      90_000,
    );

    programTest(
      `${program.name}: a typed /pause pauses without reaching the model, and the command list names it`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        const { commands } = await chat.client.request("get_available_commands", {});
        expect(commands.find((each) => each.name === "pause")).toEqual({
          name: "pause",
          description: "Freeze all agents (main, subagents, advisor) until resumed",
          source: "builtin",
        });
        expect(await chat.client.request("prompt", { text: "/pause" })).toEqual({
          resultFollows: false,
        });
        const state = await chat.client.request("get_state", {});
        expect(state.pausedAt).toEqual(expect.any(Number));
        expect(state.messageCount).toBe(0);
        expect(await chat.client.request("resume", {})).toEqual({ pausedAt: null });
      },
      60_000,
    );

    programTest(
      `${program.name}: a reply already streaming finishes while the chat is paused`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        await chat.client.request("prompt", { text: "stream_held" });
        await chat.next((event) => event.type === "message_update");
        await chat.client.request("pause", {});
        // The fake provider holds this reply after its first lines until the test lets it go: in flight, it finishes.
        await Bun.write(join(chat.folder, "..", "agent", "release-held-reply"), "");
        await chat.next(
          (event) => event.type === "message_end" && event.message.role === "assistant",
        );
        await chat.client.request("resume", {});
        await chat.next((event) => event.type === "session_settled");
      },
      90_000,
    );
  }
});
