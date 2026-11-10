import type { AppClient } from "@omp-app/client";
import {
  type OpenQuestionsList,
  QuestionsPort,
  type TodoBoard,
  TodosPort,
} from "@omp-app/contracts";
import { isOmpQuestion } from "@omp-app/contracts/chat-host";
import { useEffect, useState } from "react";
import { follow } from "../follow";

/** Today as `YYYY-MM-DD`, in this device's own time. */
function today(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/** How many questions wait for an answer, in every chat: its agent's open ones, and omp's that stop it. */
export function openQuestionsIn(list: OpenQuestionsList): number {
  return list.chats.reduce(
    (count, chat) =>
      count +
      chat.records.filter((record) => record.answer === null).length +
      chat.requests.filter(isOmpQuestion).length,
    0,
  );
}

/** How many to-dos not done are due today or before. */
export function dueIn(board: TodoBoard, on: string = today()): number {
  return board.items.filter(
    (item) =>
      (item.state === "open" || item.state === "doing") && item.due !== null && item.due <= on,
  ).length;
}

/**
 * What waits for you on the dashboard (D7): every chat's open questions and the to-dos due today or before, kept current
 * from the server's events; read again each hour, so a day that turns counts the next day's. An older server has none.
 */
export function useDashboardWaiting(client: AppClient): number {
  const [questions, setQuestions] = useState(0);
  const [due, setDue] = useState(0);
  useEffect(() => {
    let active = true;
    const readQuestions = (): void => {
      client
        .port(QuestionsPort)
        .list({})
        .then(
          (listed) => active && setQuestions(openQuestionsIn(listed)),
          () => undefined,
        );
    };
    const readTodos = (): void => {
      client
        .port(TodosPort)
        .list({})
        .then(
          (board) => active && setDue(dueIn(board)),
          () => undefined,
        );
    };
    readQuestions();
    readTodos();
    const stopQuestions = follow(client.subscribe(QuestionsPort, "changed"), readQuestions);
    const stopTodos = follow(client.subscribe(TodosPort, "changed"), readTodos);
    const hourly = setInterval(readTodos, 3_600_000);
    return () => {
      active = false;
      stopQuestions();
      stopTodos();
      clearInterval(hourly);
    };
  }, [client]);
  return questions + due;
}

/** The dashboard button's name: what waits is said, as the Questions button says it. */
export const dashboardLabel = (waiting: number): string =>
  waiting > 0 ? `Dashboard, ${waiting} waiting for you` : "Dashboard";

/** Runs `act` on the dashboard's element `selector` once the dashboard shows it, for up to `waitMs`. */
function onceShown(selector: string, act: (element: HTMLElement) => void, waitMs = 3_000): void {
  const until = performance.now() + waitMs;
  const look = (): void => {
    const element = document.querySelector<HTMLElement>(`[data-tour="dashboard"] ${selector}`);
    if (element !== null) {
      act(element);
      return;
    }
    if (performance.now() < until) requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
}

/** The to-do list's field for a new item, once the dashboard shows it: brought into view with the caret in it. */
export function focusNewTodo(): void {
  onceShown('input[aria-label="New to-do"]', (field) => {
    field.scrollIntoView({ block: "center" });
    field.focus();
  });
}

/** The to-do list, once the dashboard shows it: brought into view at the top. */
export function showTodoList(): void {
  onceShown('[aria-label="To-do list"]', (list) => list.scrollIntoView({ block: "start" }));
}
