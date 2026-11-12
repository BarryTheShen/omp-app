import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppFailure, type FolderPath, type QueuedTask, type ThreadId } from "@omp-app/contracts";
import type { ProcessTimer } from "../../process/omp-process";
import {
  TASK_RESET_GRACE_MS,
  TASKS_TICK_MS,
  type TaskDelivery,
  TaskQueue,
  type TaskQueueDeps,
  tasksFile,
} from "./tasks";

const A = "chat-a" as ThreadId;
const B = "chat-b" as ThreadId;
const FOLDER = "/work/project" as FolderPath;
const MIN = 60_000;

/** A clock and timers the test moves by hand. */
class FakeTimer implements ProcessTimer {
  now = 1_790_000_000_000;
  #next = 1;
  readonly timers = new Map<number, { at: number; handler: () => void }>();
  setTimeout(handler: () => void, delayMs: number): unknown {
    const id = this.#next++;
    this.timers.set(id, { at: this.now + delayMs, handler });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.timers]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.timers.delete(due[0]);
      this.now = due[1].at;
      due[1].handler();
      await settle();
    }
    this.now = end;
  }
}

async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A queue whose chats answer from `answers` (sent when none is given), recording each message sent, in order. */
function setup(more: Partial<TaskQueueDeps> = {}) {
  const timer = new FakeTimer();
  const sent: string[] = [];
  const answers = new Map<string, TaskDelivery["outcome"][]>();
  let ids = 0;
  let changes = 0;
  const queue = new TaskQueue({
    now: () => timer.now,
    timer,
    load: async () => [],
    save: async () => undefined,
    deliver: async (target, text) => {
      const key = target.kind === "chat" ? target.threadId : `new:${target.folder}`;
      const outcome = answers.get(key)?.shift() ?? "sent";
      if (outcome === "gone") return { outcome, problem: "The chat is no longer on the server." };
      if (outcome !== "sent") return { outcome };
      sent.push(`${key}: ${text}`);
      return {
        outcome,
        threadId: (target.kind === "chat" ? target.threadId : "new-chat") as ThreadId,
      };
    },
    resetOf: async () => timer.now + 60 * MIN,
    changed: () => {
      changes += 1;
    },
    newId: () => `task-${++ids}`,
    ...more,
  });
  return { timer, sent, answers, queue, changes: () => changes };
}

const toChat = (threadId: ThreadId) => ({ kind: "chat" as const, threadId });
const free = { kind: "free" as const };

describe("the task queue (#14)", () => {
  test("tasks go in order, one per chat at a time: a chat's next task waits until the turn the last one started ends", async () => {
    const { sent, queue } = setup();
    await queue.add({ text: "first for A", target: toChat(A), when: free });
    await queue.add({ text: "second for A", target: toChat(A), when: free });
    await queue.add({ text: "for B", target: toChat(B), when: free });
    await settle();
    expect(sent).toEqual(["chat-a: first for A", "chat-b: for B"]);
    expect(queue.list().map((task) => task.state)).toEqual(["waiting", "sent", "sent"]);

    queue.onTurnEnd(A);
    await settle();
    expect(sent).toEqual(["chat-a: first for A", "chat-b: for B", "chat-a: second for A"]);
  });

  test("a busy, paused or held chat keeps its task waiting, and it goes at a later look once the chat is free", async () => {
    const { timer, sent, answers, queue } = setup();
    answers.set(A, ["busy", "held", "paused"]);
    await queue.add({ text: "when free", target: toChat(A), when: free });
    await settle();
    expect(sent).toEqual([]);
    await timer.advance(2 * TASKS_TICK_MS);
    expect(sent).toEqual([]);
    await timer.advance(TASKS_TICK_MS);
    expect(sent).toEqual(["chat-a: when free"]);
  });

  test("a task waits for its time, one for the reset waits for it and a minute, and Send now lets one go at once", async () => {
    const { timer, sent, queue } = setup();
    const start = timer.now;
    await queue.add({
      text: "at ten past",
      target: toChat(A),
      when: { kind: "at", at: start + 10 * MIN },
    });
    await queue.add({ text: "after the reset", target: toChat(B), when: { kind: "reset" } });
    expect(queue.list().find((task) => task.text === "after the reset")?.after).toBe(
      start + 60 * MIN,
    );
    await timer.advance(10 * MIN - 1);
    expect(sent).toEqual([]);
    await timer.advance(1);
    expect(sent).toEqual(["chat-a: at ten past"]);
    await timer.advance(50 * MIN + TASK_RESET_GRACE_MS - 1 - 10 * MIN + 10 * MIN);
    expect(sent).toEqual(["chat-a: at ten past"]);
    await timer.advance(1);
    expect(sent).toEqual(["chat-a: at ten past", "chat-b: after the reset"]);

    await queue.add({
      text: "tomorrow",
      target: toChat(B),
      when: { kind: "at", at: start + 24 * 60 * MIN },
    });
    queue.onTurnEnd(B);
    const later = queue.list().find((task) => task.text === "tomorrow");
    queue.sendNow({ id: later?.id ?? "" });
    await settle();
    expect(sent.at(-1)).toBe("chat-b: tomorrow");
  });

  test("a reset with no reading, or for a new chat, is refused in words", async () => {
    const { queue } = setup({ resetOf: async () => null });
    await expect(
      queue.add({ text: "later", target: toChat(A), when: { kind: "reset" } }),
    ).rejects.toThrow("No reading of this chat's provider's 5-hour window yet");
    await expect(
      queue.add({
        text: "later",
        target: { kind: "new", folder: FOLDER },
        when: { kind: "reset" },
      }),
    ).rejects.toBeInstanceOf(AppFailure);
    expect(queue.list()).toEqual([]);
  });

  test("hasWaitingFor says whether a task still waits to go into the chat, not once it was sent or for another chat", async () => {
    let busy = true;
    const { timer, queue } = setup({
      deliver: async (target) =>
        busy
          ? { outcome: "busy" }
          : {
              outcome: "sent",
              threadId: target.kind === "chat" ? target.threadId : ("new-chat" as ThreadId),
            },
    });
    await queue.add({ text: "later for A", target: toChat(A), when: free });
    await queue.add({
      text: "for a new chat",
      target: { kind: "new", folder: FOLDER },
      when: free,
    });
    await settle();
    expect(queue.hasWaitingFor(A)).toBe(true);
    expect(queue.hasWaitingFor(B)).toBe(false);
    // Sent at a later look: nothing waits for the chat any more.
    busy = false;
    await timer.advance(TASKS_TICK_MS);
    expect(queue.hasWaitingFor(A)).toBe(false);
  });

  test("a task for a chat that is gone fails with the reason; a new chat's task goes to the chat it made", async () => {
    const { sent, answers, queue } = setup();
    answers.set(A, ["gone"]);
    await queue.add({ text: "lost", target: toChat(A), when: free });
    await queue.add({ text: "start", target: { kind: "new", folder: FOLDER }, when: free });
    await settle();
    expect(sent).toEqual(["new:/work/project: start"]);
    const byText = (text: string) => queue.list().find((task) => task.text === text);
    expect(byText("start")).toMatchObject({ state: "sent", sentTo: "new-chat" });
    expect(byText("lost")).toMatchObject({
      state: "failed",
      problem: "The chat is no longer on the server.",
    });
  });

  test("a moved task goes before the one it was put before, and the waiting tasks outlive a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-app-tasks-"));
    try {
      const file = tasksFile(join(dir, "tasks.json"));
      const { answers, queue } = setup(file);
      answers.set(A, ["busy", "busy", "busy", "busy"]);
      await queue.add({ text: "one", target: toChat(A), when: free });
      await queue.add({ text: "two", target: toChat(A), when: free });
      queue.move({ id: "task-2", before: "task-1" });
      expect(queue.list().map((task) => task.text)).toEqual(["two", "one"]);
      await queue.saved();

      const again = setup(file);
      await again.queue.restore();
      await settle();
      // The kept order holds: "two" is the first of A's, so it goes first.
      expect(again.sent).toEqual(["chat-a: two"]);
      expect(again.queue.list().map((task: QueuedTask) => [task.text, task.state])).toEqual([
        ["one", "waiting"],
        ["two", "sent"],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
