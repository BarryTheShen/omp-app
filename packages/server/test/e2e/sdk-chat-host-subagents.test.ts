/**
 * The chat host's subagents (SDK plan H5.2f), end to end on the fake model provider: the fake model starts subagents
 * with omp's `task` tool (`spawn_subagent`, `spawn_steerable_subagent`, `spawn_long_subagent`), and the test reads the
 * roster, their events and transcripts, steers one and kills one. Runs from source and compiled
 * (`sdk-chat-host-harness.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { ChatEvent } from "@omp-app/contracts/chat-host";
import { chatHostChats, PROGRAMS, realTest, resultOf } from "./sdk-chat-host-harness";

const chats = chatHostChats();
afterEach(() => chats.stopAll(), 60_000);

const lifecycle = (status: string) => (event: ChatEvent) =>
  event.type === "subagent_lifecycle" && event.payload.status === status;

/** A chat with lifecycle and progress events on, that starts one subagent with `prompt` (request 2). */
async function startSubagent(command: readonly string[], prompt: string) {
  const chat = await chats.start(command);
  await chat.client.hello;
  expect(await chat.client.request("set_subagent_subscription", { level: "progress" })).toEqual({
    level: "progress",
  });
  await chat.client.request("prompt", { text: prompt });
  const started = await chat.next(lifecycle("started"));
  const id = started.type === "subagent_lifecycle" ? started.payload.id : "";
  return { chat, id };
}

function transcriptText(messages: readonly unknown[]): string {
  return JSON.stringify(messages);
}

describe("the chat host's subagents", () => {
  for (const program of PROGRAMS) {
    const programTest = program.command === undefined ? test.skip : realTest;
    const command = program.command ?? [];

    programTest(
      `${program.name}: a subagent's start and end reach the app, and its transcript stays readable after it ends`,
      async () => {
        const { chat, id } = await startSubagent(command, "spawn_subagent");
        await chat.next(resultOf("2"));
        expect(await chat.next(lifecycle("completed"))).toMatchObject({ payload: { id } });
        expect((await chat.client.request("get_subagents", {})).subagents).toEqual([]);
        const transcript = await chat.client.request("get_subagent_messages", { subagentId: id });
        expect(transcript.nextByte).toBeGreaterThan(0);
        expect(transcriptText(transcript.messages)).toContain("nested_probe_child");
        // Only this session's subagents' transcripts can be read.
        await expect(
          chat.client.request("get_subagent_messages", { sessionFile: "/etc/passwd" }),
        ).rejects.toMatchObject({ message: "Unknown subagent session file" });
      },
      90_000,
    );

    programTest(
      `${program.name}: a running subagent is listed, and the app's message reaches it`,
      async () => {
        const { chat, id } = await startSubagent(command, "spawn_steerable_subagent");
        expect((await chat.client.request("get_subagents", {})).subagents).toMatchObject([
          { id, status: "running" },
        ]);
        expect(
          await chat.client.request("steer_subagent", {
            subagentId: id,
            message: "steer_probe: you can stop",
          }),
        ).toEqual({});
        // omp runs the subagent as a background job: it ends after the parent's turn, once the message reached it.
        await chat.next(lifecycle("completed"));
        const { messages } = await chat.client.request("get_subagent_messages", { subagentId: id });
        expect(transcriptText(messages)).toContain("steer_probe: you can stop");
        expect(transcriptText(messages)).toContain("Steer received.");
      },
      90_000,
    );

    programTest(
      `${program.name}: the app kills a running subagent; one that is not running is a no-op, and cannot be steered`,
      async () => {
        const { chat, id } = await startSubagent(command, "spawn_long_subagent");
        expect(await chat.client.request("cancel_subagent", { subagentId: id })).toEqual({
          cancelled: true,
        });
        await chat.next(lifecycle("aborted"));
        expect(await chat.client.request("cancel_subagent", { subagentId: id })).toEqual({
          cancelled: false,
        });
        await expect(
          chat.client.request("steer_subagent", {
            subagentId: id,
            message: "steer_probe: too late",
          }),
        ).rejects.toMatchObject({ message: `Subagent not running: ${id}` });
        await chat.next(resultOf("2"));
      },
      90_000,
    );
  }
});
