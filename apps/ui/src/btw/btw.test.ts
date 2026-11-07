import type { ChatHostCommand } from "@omp-app/contracts/chat-host";
import { describe, expect, test } from "vitest";
import {
  ANSWER_READY,
  BTW_COMMAND,
  type BtwRecord,
  BtwStore,
  btwQuestion,
  copyText,
  STILL_ANSWERING,
  withBtwCommand,
} from "./btw";

const T = 1_790_000_000_000;

function topic(id: string, createdAt: number, patch: Partial<BtwRecord> = {}): BtwRecord {
  return {
    id,
    leafId: null,
    question: `Question ${id}`,
    answer: "",
    status: "running",
    createdAt,
    updatedAt: createdAt,
    ...patch,
  };
}

/** A store and the lines it said in the chat. */
function store(): { readonly btw: BtwStore; readonly said: string[] } {
  const said: string[] = [];
  return { btw: new BtwStore((text) => said.push(text)), said };
}

describe("/btw in the message box", () => {
  test("reads the question after the command, as omp does, and nothing from other text", () => {
    expect(btwQuestion("/btw")).toBe("");
    expect(btwQuestion("  /btw   What is this chat about?  ")).toBe("What is this chat about?");
    expect(btwQuestion("/btw first line\nsecond line")).toBe("first line\nsecond line");
    expect(btwQuestion("/btwx")).toBeNull();
    expect(btwQuestion("ask /btw later")).toBeNull();
    expect(btwQuestion("/model")).toBeNull();
  });

  test("the menus offer /btw after omp's built-in commands, once", () => {
    const builtin: ChatHostCommand = { name: "new", source: "builtin" };
    const skill: ChatHostCommand = { name: "skill:review", source: "skill" };
    expect(withBtwCommand([builtin, skill])).toEqual([builtin, BTW_COMMAND, skill]);
    expect(withBtwCommand([builtin])).toEqual([builtin, BTW_COMMAND]);
    const listed: ChatHostCommand = { name: "btw", source: "builtin", description: "omp's own" };
    expect(withBtwCommand([listed, skill])).toEqual([listed, skill]);
  });
});

describe("copying an answer", () => {
  test("copies the newest answer that is not blank, with its own whitespace", () => {
    const record = topic("a", T, {
      answer: "  first\n",
      status: "complete",
      followUps: [
        { question: "more", answer: "  second\n", status: "complete", createdAt: T, updatedAt: T },
        { question: "again", answer: "   ", status: "cancelled", createdAt: T, updatedAt: T },
      ],
    });
    expect(copyText(record)).toBe("  second\n");
    expect(copyText(topic("b", T))).toBeUndefined();
  });
});

describe("the side questions' store", () => {
  test("keeps the topics newest first and streams an answer into its running turn only", () => {
    const { btw } = store();
    btw.setRecords([topic("old", T), topic("new", T + 1_000)]);
    expect(btw.getSnapshot().records?.map((record) => record.id)).toEqual(["new", "old"]);

    btw.apply({ type: "btw_delta", recordId: "new", delta: "po" });
    btw.apply({ type: "btw_delta", recordId: "new", delta: "ng" });
    btw.apply({ type: "btw_delta", recordId: "unknown", delta: "lost" });
    expect(btw.getSnapshot().records?.[0]?.answer).toBe("pong");

    btw.put(topic("new", T + 1_000, { answer: "pong", status: "complete" }));
    btw.apply({ type: "btw_delta", recordId: "new", delta: " late" });
    expect(btw.getSnapshot().records?.[0]).toMatchObject({ answer: "pong", status: "complete" });
  });

  test("streams a follow-up into the follow-up, not the first answer", () => {
    const { btw } = store();
    btw.put(
      topic("a", T, {
        answer: "first",
        status: "complete",
        followUps: [
          { question: "more", answer: "", status: "running", createdAt: T, updatedAt: T },
        ],
      }),
    );
    btw.apply({ type: "btw_delta", recordId: "a", delta: "second" });
    const [record] = btw.getSnapshot().records ?? [];
    expect(record?.answer).toBe("first");
    expect(record?.followUps?.[0]?.answer).toBe("second");
  });

  test("keeps the answer streamed so far when omp's answer to the question comes after its first pieces", () => {
    const { btw } = store();
    btw.apply({ type: "btw_record", record: topic("a", T) });
    btw.apply({ type: "btw_delta", recordId: "a", delta: "streamed" });
    btw.asked(topic("a", T));
    expect(btw.getSnapshot().records?.[0]?.answer).toBe("streamed");
  });

  test("/btw asks the panel for the side questions, on the topic just asked, until the panel brings them forward", () => {
    const { btw } = store();
    btw.setRecords([topic("old", T), topic("new", T + 1_000)]);
    btw.reveal("old");
    expect(btw.getSnapshot()).toMatchObject({ selected: "old", wanted: true });
    btw.revealed();
    expect(btw.getSnapshot()).toMatchObject({ selected: "old", wanted: false });
    // `/btw` alone asks again and keeps the topic shown.
    btw.reveal();
    expect(btw.getSnapshot()).toMatchObject({ selected: "old", wanted: true });
  });

  test("says an answer asked here is ready when it ends while the BTW history is put away", () => {
    const { btw, said } = store();
    btw.apply({ type: "btw_record", record: topic("mine", T) });
    btw.asked(topic("mine", T));
    btw.apply({ type: "btw_record", record: topic("theirs", T + 1) });
    btw.setShown(true);
    btw.select("mine");
    btw.setShown(false);
    expect(said).toEqual([STILL_ANSWERING]);

    btw.apply({ type: "btw_record", record: topic("theirs", T + 1, { status: "complete" }) });
    btw.apply({
      type: "btw_record",
      record: topic("mine", T, { answer: "pong", status: "complete" }),
    });
    expect(said).toEqual([STILL_ANSWERING, ANSWER_READY]);
  });

  test("says nothing while the BTW history shows the chat, or when the answer was cancelled", () => {
    const { btw, said } = store();
    btw.apply({ type: "btw_record", record: topic("a", T) });
    btw.asked(topic("a", T));
    btw.setShown(true);
    btw.apply({
      type: "btw_record",
      record: topic("a", T, { status: "complete", answer: "pong" }),
    });
    btw.setShown(false);
    expect(said).toEqual([]);

    const followUp = {
      question: "more",
      answer: "",
      status: "running",
      createdAt: T,
      updatedAt: T,
    } as const;
    btw.asked(topic("a", T, { status: "complete", answer: "pong", followUps: [followUp] }));
    btw.apply({
      type: "btw_record",
      record: topic("a", T, {
        status: "complete",
        answer: "pong",
        followUps: [{ ...followUp, status: "cancelled" }],
      }),
    });
    expect(said).toEqual([]);
  });

  test("a move to another session leaves the old session's topics behind", () => {
    const { btw, said } = store();
    btw.apply({ type: "btw_record", record: topic("a", T) });
    btw.asked(topic("a", T));
    const before = btw.getSnapshot().session;
    btw.reset();
    expect(btw.getSnapshot()).toMatchObject({ records: null, selected: null, session: before + 1 });
    btw.apply({ type: "btw_record", record: topic("a", T, { status: "complete" }) });
    expect(said).toEqual([]);
  });
});
