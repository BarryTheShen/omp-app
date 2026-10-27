/**
 * The queue on the chat host (SDK plan H5.2a2): `steer` and `follow_up` while a reply streams, the queue and interrupt
 * modes, and `abort_bash`, end to end on the fake model provider. Runs from source and compiled
 * (`sdk-chat-host-harness.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { chatHostChats, PROGRAMS, realTest, resultOf } from "./sdk-chat-host-harness";

const chats = chatHostChats();
afterEach(() => chats.stopAll(), 60_000);

describe("the queue on the chat host", () => {
  for (const program of PROGRAMS) {
    const programTest = program.command === undefined ? test.skip : realTest;
    const command = program.command ?? [];

    programTest(
      `${program.name}: a steer and a follow-up sent while a reply streams wait in omp's two queues, with no prompt result`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        await chat.client.request("prompt", { text: "stream_held" });
        await chat.next((event) => event.type === "message_update");
        expect(await chat.client.request("steer", { text: "steer this way" })).toEqual({});
        expect(await chat.client.request("follow_up", { text: "and then this" })).toEqual({});
        expect(await chat.client.request("abort_and_restore_queue", {})).toEqual({
          steering: [{ text: "steer this way" }],
          followUp: [{ text: "and then this" }],
        });
        await chat.next(resultOf("1"));
        await chat.next((event) => event.type === "session_settled");
        expect(chat.events.filter(({ event }) => event.type === "prompt_result")).toHaveLength(1);
      },
      60_000,
    );

    programTest(
      `${program.name}: the queue and interrupt modes change this chat, and omp's settings file stays as it was`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        const settingsFile = join(chat.folder, "..", "agent", "config.yml");
        const settingsBefore = await Bun.file(settingsFile).text();
        const initial = await chat.client.request("get_state", {});
        const steering = initial.steeringMode === "all" ? "one-at-a-time" : "all";
        const followUp = initial.followUpMode === "all" ? "one-at-a-time" : "all";
        const interrupt = initial.interruptMode === "wait" ? "immediate" : "wait";
        await chat.client.request("set_steering_mode", { mode: steering });
        await chat.client.request("set_follow_up_mode", { mode: followUp });
        await chat.client.request("set_interrupt_mode", { mode: interrupt });
        expect(await chat.client.request("get_state", {})).toMatchObject({
          steeringMode: steering,
          followUpMode: followUp,
          interruptMode: interrupt,
        });
        // omp saves a changed setting soon after; give it the time before reading the file.
        await Bun.sleep(1_500);
        expect(await Bun.file(settingsFile).text()).toBe(settingsBefore);
      },
      60_000,
    );

    programTest(
      `${program.name}: abort_bash stops a running ! command`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        const marker = join(chat.folder, "bash-started");
        const running = chat.client.request("bash", {
          command: "touch bash-started; sleep 30; echo finished",
        });
        for (let waited = 0; !(await Bun.file(marker).exists()); waited += 50) {
          if (waited > 20_000) throw new Error("the ! command never started");
          await Bun.sleep(50);
        }
        expect(await chat.client.request("abort_bash", {})).toEqual({});
        expect(await running).toMatchObject({ cancelled: true });
      },
      60_000,
    );
  }
});
