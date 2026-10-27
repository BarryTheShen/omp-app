/**
 * Goal mode on the chat host (SDK plan H5.2g2), end to end on the fake model provider. omp's default leaves automatic
 * continuation off for the app's chats (`goal.continuationModes` lists `interactive` only); the continuation test turns
 * it on with `rpc`. Runs from source and compiled (`sdk-chat-host-harness.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { type Chat, chatHostChats, PROGRAMS, realTest } from "./sdk-chat-host-harness";

const chats = chatHostChats();
afterEach(() => chats.stopAll(), 60_000);

async function toolNames(chat: Chat): Promise<string[]> {
  return (await chat.client.request("get_state", {})).dumpTools.map((tool) => tool.name);
}

describe("goal mode on the chat host", () => {
  for (const program of PROGRAMS) {
    const programTest = program.command === undefined ? test.skip : realTest;
    const command = program.command ?? [];

    programTest(
      `${program.name}: a goal is created, paused, resumed and dropped, with omp's refusals, and the goal tool comes and goes`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        expect(await chat.client.request("goal", { op: "get" })).toEqual({
          goal: null,
          state: null,
        });
        await expect(chat.client.request("goal", { op: "create" })).rejects.toMatchObject({
          message: "objective is required when op=create",
        });
        await expect(chat.client.request("goal", { op: "resume" })).rejects.toMatchObject({
          message: "No paused goal to resume.",
        });
        expect(await toolNames(chat)).not.toContain("goal");

        const created = await chat.client.request("goal", {
          op: "create",
          objective: "Ship the release",
          token_budget: 5000,
        });
        expect(created).toMatchObject({
          goal: { objective: "Ship the release", status: "active", tokenBudget: 5000 },
          state: { enabled: true },
        });
        expect(await toolNames(chat)).toContain("goal");
        await expect(
          chat.client.request("goal", { op: "create", objective: "Another one" }),
        ).rejects.toMatchObject({
          message: "A goal is already active. Drop it before creating another.",
        });

        expect(await chat.client.request("goal", { op: "pause" })).toMatchObject({
          goal: { status: "paused" },
        });
        expect(await toolNames(chat)).not.toContain("goal");
        expect(await chat.client.request("goal", { op: "resume" })).toMatchObject({
          goal: { status: "active" },
          state: { enabled: true },
        });
        expect(await toolNames(chat)).toContain("goal");

        await chat.client.request("goal", { op: "drop" });
        expect(await toolNames(chat)).not.toContain("goal");
        expect((await chat.client.request("goal", { op: "get" })).state?.enabled ?? false).toBe(
          false,
        );
      },
      60_000,
    );

    programTest(
      `${program.name}: with continuation on, a new goal starts a turn of its own, and the session settles after it`,
      async () => {
        const chat = await chats.start(command, {
          config: "goal:\n  continuationModes:\n    - rpc\n",
        });
        await chat.client.hello;
        await chat.client.request("goal", { op: "create", objective: "Ship the release" });
        await chat.next((event) => event.type === "agent_start");
        await chat.next((event) => event.type === "session_settled");
        // The turn came from the goal, not from a prompt: no prompt was sent, so no prompt result.
        expect(chat.events.some(({ event }) => event.type === "prompt_result")).toBe(false);
      },
      60_000,
    );
  }
});
