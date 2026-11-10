import type { OpenQuestionsList, TodoBoard, TodoItem } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { listMarkdown } from "./TodoSection";
import { dashboardLabel, dueIn, openQuestionsIn } from "./waiting";

const record = (id: string, answer: unknown) => ({
  id,
  toolCallId: `call-${id}`,
  questionId: id,
  question: `${id}?`,
  options: [],
  multi: false,
  askedAt: 1,
  answer,
});

const item = (title: string, fields: Partial<TodoItem> = {}): TodoItem =>
  ({
    id: title,
    title,
    notes: "",
    state: "open",
    list: "To do",
    due: null,
    chat: null,
    createdAt: 1,
    updatedAt: 1,
    doneAt: null,
    createdBy: { kind: "person" },
    updatedBy: { kind: "person" },
    ...fields,
  }) as TodoItem;

describe("what waits on the dashboard", () => {
  test("counts the questions with no answer yet, in every chat, and omp's that stop a chat; an answer held for the rest, or a tool's approval, never", () => {
    const held = { picked: ["Yes"], skipped: false, answeredAt: 2, held: true };
    const list = {
      chats: [
        {
          threadId: "a",
          folder: null,
          title: "A",
          records: [record("q1", null), record("q2", held)],
          requests: [],
        },
        {
          threadId: "b",
          folder: null,
          title: "B",
          records: [record("q3", null)],
          requests: [
            { id: "r1", method: "ui.confirm", params: { title: "Deploy?", message: "Now?" } },
            { id: "r2", method: "ui.approve", params: {} },
          ],
        },
        {
          threadId: "c",
          folder: null,
          title: "C",
          records: [],
          requests: [{ id: "r3", method: "ui.select", params: { title: "Branch?", options: [] } }],
        },
      ],
    } as unknown as OpenQuestionsList;
    expect(openQuestionsIn(list)).toBe(4);
  });

  test("counts the to-dos not done that are due today or before; done, dropped or undated ones never", () => {
    const board = {
      items: [
        item("late", { due: "2026-11-08" }),
        item("today", { due: "2026-11-09", state: "doing" }),
        item("tomorrow", { due: "2026-11-10" }),
        item("done", { due: "2026-11-01", state: "done" }),
        item("dropped", { due: "2026-11-01", state: "dropped" }),
        item("undated"),
      ],
      lists: ["To do"],
      revision: 1,
    } as TodoBoard;
    expect(dueIn(board, "2026-11-09")).toBe(2);
    expect(dashboardLabel(3)).toBe("Dashboard, 3 waiting for you");
    expect(dashboardLabel(0)).toBe("Dashboard");
  });

  test("the list as Markdown: a heading per list, a task per item, what stands by it", () => {
    const text = listMarkdown(
      [
        item("Write the plan", { state: "doing", list: "omp-app", due: "2026-11-12" }),
        item("Old", { state: "done", list: "omp-app", due: "2026-11-01" }),
        item("Read chapter 4", { list: "School" }),
      ],
      ["To do", "omp-app", "School"],
    );
    expect(text).toBe(
      "## omp-app\n\n- [ ] Write the plan (doing, due 2026-11-12)\n- [x] Old\n\n## School\n\n- [ ] Read chapter 4\n",
    );
  });
});
