import type { RpcSessionSend, ThreadId } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  isSessionBusyError,
  isStaleCursorError,
  iterateMessagePages,
  loadMessagesPage,
} from "./messages-page";

const threadId = "thread-m" as ThreadId;

function userMessage(text: string): Record<string, unknown> {
  return { role: "user", content: text, timestamp: 1 };
}

interface SendCall {
  readonly cursor: string | undefined;
}

type PageHandler = (cursor: string | undefined) => unknown;

function makeSend(
  handler: PageHandler,
  calls: SendCall[] = [],
): { send: RpcSessionSend; calls: SendCall[] } {
  const send = (async (args: { command: { cursor?: string } }) => {
    calls.push({ cursor: args.command.cursor });
    return handler(args.command.cursor);
  }) as unknown as RpcSessionSend;
  return { send, calls };
}

describe("loadMessagesPage", () => {
  test("requests one page and returns it typed", async () => {
    const { send } = makeSend(() => ({
      messages: [userMessage("hi")],
      totalMessages: 1,
    }));
    const page = await loadMessagesPage(send, threadId, { cursor: "c1", limit: 50 });
    expect(page).toEqual({ messages: [userMessage("hi")], totalMessages: 1 });
  });
});

describe("iterateMessagePages", () => {
  test("drains every page in order and stops at the advertised total", async () => {
    const pages = [
      { messages: [userMessage("one")], totalMessages: 3, nextCursor: "p2" },
      { messages: [userMessage("two")], totalMessages: 3, nextCursor: "p3" },
      { messages: [userMessage("three")], totalMessages: 3 },
    ];
    const { send, calls } = makeSend((cursor) => {
      if (cursor === undefined) return pages[0];
      if (cursor === "p2") return pages[1];
      if (cursor === "p3") return pages[2];
      throw new Error("unexpected cursor");
    });

    const collected: unknown[] = [];
    for await (const page of iterateMessagePages(send, threadId)) collected.push(...page);

    expect(collected).toEqual([userMessage("one"), userMessage("two"), userMessage("three")]);
    expect(calls.map((call) => call.cursor)).toEqual([undefined, "p2", "p3"]);
  });

  test("throws when totalMessages changes between pages", async () => {
    const { send } = makeSend((cursor) =>
      cursor === undefined
        ? { messages: [userMessage("one")], totalMessages: 2, nextCursor: "p2" }
        : { messages: [userMessage("two")], totalMessages: 3 },
    );

    async function drain(): Promise<unknown[]> {
      const collected: unknown[] = [];
      for await (const page of iterateMessagePages(send, threadId)) collected.push(...page);
      return collected;
    }

    await expect(drain()).rejects.toMatchObject({
      appError: { code: "internal", message: expect.stringContaining("inconsistent") },
    });
  });

  test("throws when a cursor repeats instead of looping forever", async () => {
    const { send } = makeSend((cursor) =>
      cursor === undefined
        ? { messages: [userMessage("one")], totalMessages: 2, nextCursor: "p2" }
        : { messages: [userMessage("two")], totalMessages: 2, nextCursor: "p2" },
    );

    async function drain(): Promise<unknown[]> {
      const collected: unknown[] = [];
      for await (const page of iterateMessagePages(send, threadId)) collected.push(...page);
      return collected;
    }

    await expect(drain()).rejects.toMatchObject({
      appError: { code: "internal", message: expect.stringContaining("repeated") },
    });
  });

  test("propagates a session_busy failure untouched", async () => {
    const { send } = makeSend(() => {
      throw new AppFailure({
        code: "omp_error",
        message: "busy",
        retryable: true,
        omp: { command: "get_messages_page", error: "busy", code: "session_busy" },
      });
    });

    try {
      await loadMessagesPage(send, threadId);
      throw new Error("expected loadMessagesPage to throw");
    } catch (error) {
      expect(isSessionBusyError(error)).toBe(true);
      expect(isStaleCursorError(error)).toBe(false);
    }
  });

  test("propagates a stale_cursor failure untouched", async () => {
    const { send } = makeSend(() => {
      throw new AppFailure({
        code: "omp_error",
        message: "stale",
        retryable: false,
        omp: { command: "get_messages_page", error: "stale", code: "stale_cursor" },
      });
    });

    try {
      await loadMessagesPage(send, threadId, { cursor: "old" });
      throw new Error("expected loadMessagesPage to throw");
    } catch (error) {
      expect(isStaleCursorError(error)).toBe(true);
      expect(isSessionBusyError(error)).toBe(false);
    }
  });
});
