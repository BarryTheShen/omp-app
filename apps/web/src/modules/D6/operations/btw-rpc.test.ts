import { AppFailure, type OmpWire, ThreadId } from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import { SlashCommand } from "@/modules/D2/contract";
import { routeSlashText } from "@/modules/D2/slash/routing";
import { REAL_COMMAND_LIST } from "@/modules/D2/slash/test-support";
import { BtwRpcController, type BtwRpcSource, btwSlashCommand } from "./btw-rpc";

type OmpHistoryRecord = OmpWire.BtwHistoryRecord;
type Notification = Parameters<Parameters<BtwRpcSource["subscribe"]>[0]>[0];

function record(overrides: Partial<OmpHistoryRecord> = {}): OmpHistoryRecord {
  return {
    id: "topic-1",
    question: "What changed?",
    answer: "The answer.",
    status: "complete",
    createdAt: 1,
    updatedAt: 2,
    leafId: null,
    ...overrides,
  };
}

function sourceFor() {
  const listeners = new Set<(event: Notification, replayed?: boolean) => void>();
  const send = vi.fn(async (args: { readonly command: { readonly type: string } }) => {
    if (args.command.type === "get_btw_history") return { records: [record()] };
    if (args.command.type === "btw") return { record: record({ answer: "New answer." }) };
    return { cancelled: true };
  });
  const source: BtwRpcSource = {
    send: send as BtwRpcSource["send"],
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { listeners, send, source };
}

describe("BtwRpcController", () => {
  test("loads history through the typed command and handles a final record", async () => {
    const { send, source } = sourceFor();
    const controller = new BtwRpcController({ threadId: ThreadId.parse("thread-btw"), source });
    controller.start();
    await vi.waitFor(() => expect(controller.getSnapshot().turns).toHaveLength(1));
    expect(send).toHaveBeenCalledWith({
      threadId: ThreadId.parse("thread-btw"),
      command: { type: "get_btw_history" },
    });
    await controller.ask("Follow up", "topic-1");
    expect(controller.getSnapshot().turns[0]?.answer).toBe("New answer.");
    expect(controller.getSnapshot().turns).toHaveLength(1);
  });

  test("applies btw_delta and btw_record notifications and calls btw_cancel", async () => {
    const { listeners, source, send } = sourceFor();
    const controller = new BtwRpcController({ threadId: ThreadId.parse("thread-btw"), source });
    controller.start();
    await vi.waitFor(() => expect(controller.getSnapshot().turns).toHaveLength(1));
    const event = (frame: Notification, replayed = false): void => {
      listeners.forEach((listener) => {
        listener(frame, replayed);
      });
    };
    event({ type: "btw_delta", recordId: "topic-1", delta: " More." });
    expect(controller.getSnapshot().turns[0]?.answer).toBe("The answer. More.");
    event({ type: "btw_record", record: record({ answer: "Final answer." }) });
    expect(controller.getSnapshot().turns[0]?.answer).toBe("Final answer.");
    await controller.cancel("topic-1");
    expect(send).toHaveBeenCalledWith({
      threadId: ThreadId.parse("thread-btw"),
      command: { type: "btw_cancel", recordId: "topic-1" },
    });
  });
  test("the typed slash command sends a question instead of refusing it as terminal-only", async () => {
    const { source } = sourceFor();
    const controller = new BtwRpcController({ threadId: ThreadId.parse("thread-btw"), source });
    controller.start();
    await vi.waitFor(() => expect(controller.getSnapshot().turns).toHaveLength(1));
    const command = btwSlashCommand(controller);
    expect(command.name).toBe("btw");
    await command.run({ args: "What changed?" });
    expect(controller.getSnapshot().turns.at(-1)?.answer).toBe("New answer.");
  });
  test("preserves follow-ups and ignores replayed deltas", async () => {
    const { listeners, source } = sourceFor();
    const controller = new BtwRpcController({ threadId: ThreadId.parse("thread-btw"), source });
    controller.start();
    await vi.waitFor(() => expect(controller.getSnapshot().turns).toHaveLength(1));
    const emit = (frame: Notification, replayed = false): void => {
      listeners.forEach((listener) => {
        listener(frame, replayed);
      });
    };
    emit({
      type: "btw_record",
      record: record({
        followUps: [
          {
            question: "A follow-up",
            answer: "Follow-up answer.",
            status: "running",
            createdAt: 3,
            updatedAt: 4,
          },
        ],
      }),
    });
    emit({ type: "btw_delta", recordId: "topic-1", delta: " duplicate" }, true);
    emit({ type: "btw_delta", recordId: "topic-1", delta: " plus" });
    expect(controller.getSnapshot().turns).toHaveLength(2);
    expect(controller.getSnapshot().turns.at(-1)?.answer).toBe("Follow-up answer. plus");
  });

  test("the app command wins before the captured catalog", async () => {
    const { source } = sourceFor();
    const controller = new BtwRpcController({ threadId: ThreadId.parse("thread-btw"), source });
    const command = btwSlashCommand(controller);
    const route = routeSlashText(
      "/btw What changed?",
      REAL_COMMAND_LIST.map((entry) => SlashCommand.parse(entry)),
      [command],
    );
    expect(route).toMatchObject({ kind: "app", command });
  });
  test("the app command takes precedence over the terminal-only fallback", async () => {
    const { source } = sourceFor();
    const controller = new BtwRpcController({ threadId: ThreadId.parse("thread-btw"), source });
    const command = btwSlashCommand(controller);
    const entries = REAL_COMMAND_LIST.map((entry) => SlashCommand.parse(entry));
    expect(routeSlashText("/btw What changed?", entries, [])?.kind).toBe("app");
    expect(routeSlashText("/btw What changed?", entries, [command])).toMatchObject({
      kind: "app",
      command,
    });
  });
  test("surfaces failed asks and unsuccessful cancels", async () => {
    const source: BtwRpcSource = {
      send: vi.fn(async ({ command }: { readonly command: { readonly type: string } }) => {
        if (command.type === "get_btw_history") return { records: [] };
        if (command.type === "btw") throw new Error("The side question failed.");
        return { cancelled: false };
      }) as BtwRpcSource["send"],
      subscribe: () => () => undefined,
    };
    const controller = new BtwRpcController({ threadId: ThreadId.parse("thread-btw"), source });
    await expect(controller.ask("Fail")).rejects.toThrow("The side question failed.");
    await expect(controller.cancel("topic-1")).rejects.toThrow(
      "The side question could not be cancelled.",
    );
  });
  test("drops the optimistic row when the real record arrives", async () => {
    const source: BtwRpcSource = {
      send: vi.fn(async ({ command }: { readonly command: { readonly type: string } }) => {
        if (command.type === "btw") return { record: record({ id: "real-topic" }) };
        return { records: [] };
      }) as BtwRpcSource["send"],
      subscribe: () => () => undefined,
    };
    const controller = new BtwRpcController({ threadId: ThreadId.parse("thread-btw"), source });
    await controller.ask("A new question");
    expect(controller.getSnapshot().turns).toHaveLength(1);
    expect(controller.getSnapshot().turns[0]?.id).toBe("real-topic");
  });

  test("reverses newest-first history and selects the newest topic", async () => {
    const newest = record({ id: "newest", question: "New", createdAt: 2, updatedAt: 3 });
    const oldest = record({ id: "oldest", question: "Old", createdAt: 1, updatedAt: 2 });
    const source: BtwRpcSource = {
      send: vi.fn(async () => ({ records: [newest, oldest] })) as BtwRpcSource["send"],
      subscribe: () => () => undefined,
    };
    const controller = new BtwRpcController({ threadId: ThreadId.parse("thread-btw"), source });
    await controller.refresh();
    expect(controller.getSnapshot().turns.map((turn) => turn.id)).toEqual(["oldest", "newest"]);
    expect(controller.getSnapshot().selectedId).toBe("newest");
  });

  test("cancels a follow-up by its topic and omits pending ids", async () => {
    const { listeners, send, source } = sourceFor();
    const controller = new BtwRpcController({ threadId: ThreadId.parse("thread-btw"), source });
    controller.start();
    await vi.waitFor(() => expect(controller.getSnapshot().turns).toHaveLength(1));
    const recordWithFollowUp = record({
      followUps: [
        {
          question: "Follow up",
          answer: "Answer",
          status: "running",
          createdAt: 3,
          updatedAt: 4,
        },
      ],
    });
    listeners.forEach((listener) => {
      listener({ type: "btw_record", record: recordWithFollowUp });
    });
    await controller.cancel("topic-1:4");
    await controller.cancel("pending-123");
    const cancelCalls = send.mock.calls.filter(([args]) => args.command.type === "btw_cancel");
    expect(cancelCalls[0]?.[0].command).toEqual({ type: "btw_cancel", recordId: "topic-1" });
    expect(cancelCalls[1]?.[0].command).toEqual({ type: "btw_cancel" });
  });

  test("distinguishes unavailable refresh failures from internal failures", async () => {
    const unavailable: BtwRpcSource = {
      send: vi.fn(async () => {
        throw new AppFailure({
          code: "unavailable",
          message: "Side questions are not available.",
          retryable: false,
        });
      }) as BtwRpcSource["send"],
      subscribe: () => () => undefined,
    };
    const unavailableController = new BtwRpcController({
      threadId: ThreadId.parse("thread-btw"),
      source: unavailable,
    });
    await unavailableController.refresh();
    expect(unavailableController.getSnapshot().lifecycle).toBe("unavailable");
    expect(unavailableController.getSnapshot().error).toMatchObject({
      code: "unavailable",
      message: "Side questions are not available.",
    });

    const failed: BtwRpcSource = {
      send: vi.fn(async () => {
        throw new Error("history broke");
      }) as BtwRpcSource["send"],
      subscribe: () => () => undefined,
    };
    const failedController = new BtwRpcController({
      threadId: ThreadId.parse("thread-btw"),
      source: failed,
    });
    await failedController.refresh();
    expect(failedController.getSnapshot().lifecycle).toBe("error");
    expect(failedController.getSnapshot().error?.message).toBe("history broke");
  });

  test("selects the new topic when a record arrives", async () => {
    const { listeners, source } = sourceFor();
    const controller = new BtwRpcController({ threadId: ThreadId.parse("thread-btw"), source });
    controller.start();
    await vi.waitFor(() => expect(controller.getSnapshot().turns).toHaveLength(1));
    listeners.forEach((listener) => {
      listener({ type: "btw_record", record: record({ id: "new-topic" }) });
    });
    expect(controller.getSnapshot().selectedId).toBe("new-topic");
  });

  test("selects the latest follow-up when a record arrives with follow-ups", async () => {
    const { listeners, source } = sourceFor();
    const controller = new BtwRpcController({ threadId: ThreadId.parse("thread-btw"), source });
    controller.start();
    await vi.waitFor(() => expect(controller.getSnapshot().turns).toHaveLength(1));
    listeners.forEach((listener) => {
      listener({
        type: "btw_record",
        record: record({
          id: "topic-2",
          followUps: [
            {
              question: "First follow-up",
              answer: "One.",
              status: "complete",
              createdAt: 5,
              updatedAt: 6,
            },
            {
              question: "Second follow-up",
              answer: "Two.",
              status: "running",
              createdAt: 7,
              updatedAt: 8,
            },
          ],
        }),
      });
    });
    expect(controller.getSnapshot().selectedId).toBe("topic-2:8");
  });
});
