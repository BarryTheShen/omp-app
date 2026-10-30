/**
 * The chat host's `/btw` side questions (omp's `RpcBtwController`), end to end on the fake model provider: an answer
 * streams and ends complete, a follow-up joins its topic, the history keeps both, a second question while one runs is
 * refused in omp's words, a cancel ends it with the answer so far, and a new chat cancels a running one. Runs from
 * source and compiled (`sdk-chat-host-harness.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { BtwRecordEvent } from "@omp-app/contracts/chat-host";
import { type Chat, chatHostChats, PROGRAMS, realTest } from "./sdk-chat-host-harness";

type BtwRecord = BtwRecordEvent["record"];

const chats = chatHostChats();
afterEach(() => chats.stopAll(), 60_000);

/** The turn a topic shows last: its latest follow-up, else its first question (omp's `getBtwLatestTurn`). */
const latestTurn = (record: BtwRecord) => record.followUps?.at(-1) ?? record;

/** The first record event from `mark` on that shows topic `id` with its latest turn in `status`. */
async function recordIn(chat: Chat, mark: number, id: string, status: string): Promise<BtwRecord> {
  const event = await chat.nextAfter(
    mark,
    (candidate) =>
      candidate.type === "btw_record" &&
      candidate.record.id === id &&
      latestTurn(candidate.record).status === status,
  );
  if (event.type !== "btw_record") throw new Error(`Not a side question's record: ${event.type}`);
  return event.record;
}

/** The answer pieces topic `id` streamed from `mark` on, joined. */
const streamed = (chat: Chat, mark: number, id: string): string =>
  chat.events
    .slice(mark)
    .flatMap(({ event }) =>
      event.type === "btw_delta" && event.recordId === id ? [event.delta] : [],
    )
    .join("");

describe("the chat host's side questions", () => {
  for (const program of PROGRAMS) {
    const programTest = program.command === undefined ? test.skip : realTest;
    const command = program.command ?? [];

    programTest(
      `${program.name}: a side question streams its answer, a follow-up joins its topic, and the history keeps both`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        const asked = chat.events.length;
        const { record } = await chat.client.request("btw", {
          question: "What is this chat about?",
        });
        expect(record).toMatchObject({
          question: "What is this chat about?",
          answer: "",
          status: "running",
        });
        const answered = await recordIn(chat, asked, record.id, "complete");
        expect(answered.answer).toBe("pong");
        expect(streamed(chat, asked, record.id)).toBe("pong");

        const followed = chat.events.length;
        const more = await chat.client.request("btw", {
          question: "Say more.",
          recordId: record.id,
        });
        expect(more.record.id).toBe(record.id);
        expect(latestTurn(more.record)).toMatchObject({
          question: "Say more.",
          answer: "",
          status: "running",
        });
        const second = await recordIn(chat, followed, record.id, "complete");
        expect(second).toMatchObject({
          question: "What is this chat about?",
          answer: "pong",
          followUps: [{ question: "Say more.", answer: "pong", status: "complete" }],
        });

        const { records } = await chat.client.request("get_btw_history", {});
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          id: record.id,
          status: "complete",
          followUps: [{ question: "Say more.", status: "complete" }],
        });
        // A side question is not a turn of the chat.
        const { entries } = await chat.client.request("get_entries", {});
        expect(entries.filter((entry) => entry.type === "message")).toEqual([]);
      },
      90_000,
    );

    programTest(
      `${program.name}: a second side question is refused while one runs, and a cancel ends it with its answer so far`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        const asked = chat.events.length;
        const { record } = await chat.client.request("btw", { question: "stream_steady" });
        await chat.nextAfter(
          asked,
          (event) => event.type === "btw_delta" && event.recordId === record.id,
        );
        await expect(
          chat.client.request("btw", { question: "Another one?" }),
        ).rejects.toMatchObject({
          code: "failed",
          message: "A /btw question is still running; cancel it first",
        });
        expect(await chat.client.request("btw_cancel", { recordId: "another-topic" })).toEqual({
          cancelled: false,
        });
        expect(await chat.client.request("btw_cancel", { recordId: record.id })).toEqual({
          cancelled: true,
        });
        const cancelled = await recordIn(chat, asked, record.id, "cancelled");
        expect(cancelled.answer).toBe(streamed(chat, asked, record.id));
        expect(await chat.client.request("btw_cancel", {})).toEqual({ cancelled: false });

        const next = chat.events.length;
        const { record: again } = await chat.client.request("btw", { question: "Another one?" });
        expect(again.id).not.toBe(record.id);
        expect((await recordIn(chat, next, again.id, "complete")).answer).toBe("pong");
      },
      90_000,
    );

    programTest(
      `${program.name}: a new chat cancels a running side question and starts with none`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        const asked = chat.events.length;
        const { record } = await chat.client.request("btw", { question: "stream_steady" });
        await chat.nextAfter(
          asked,
          (event) => event.type === "btw_delta" && event.recordId === record.id,
        );
        expect(await chat.client.request("new_session", {})).toEqual({ cancelled: false });
        await recordIn(chat, asked, record.id, "cancelled");
        expect(await chat.client.request("get_btw_history", {})).toEqual({ records: [] });
      },
      90_000,
    );
  }
});
