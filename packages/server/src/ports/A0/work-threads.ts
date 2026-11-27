import {
  AppFailure,
  type StreamKey,
  streamKey,
  type TaskTarget,
  type ThreadId,
  type WorkThreadAnswer,
  type WorkThreadAuthor,
  WorkThreadId,
  type WorkThreadKind,
  type WorkThreadList,
  type WorkThreadQuestion,
  type WorkThreadState,
  type WorkThreadSummary,
  WorkThreadsPort,
  type WorkThreadTarget,
  withAppNotice,
} from "@omp-app/contracts";
import type { PortRegistration } from "../../registry/ports";
import { WorkThreadRefused, type WorkThreadStore } from "../../threads/store";

/** Where a thread's notices come from in a chat. */
export const THREAD_NOTICE_SOURCE = "thread";

export interface WorkThreadsContext {
  readonly store: WorkThreadStore;
  /**
   * Puts a notice into a chat: at once, also while a turn runs, else once the chat is free; a `new` target starts a
   * chat for it. Answers the chat it went to, when known.
   */
  readonly deliver: (target: TaskTarget, text: string) => Promise<ThreadId | null>;
  /** Publishes an event into the replay hub. */
  readonly publish: (stream: StreamKey, payload: unknown) => unknown;
  readonly now?: () => number;
}

/** A page's change is the person's. */
const PERSON: WorkThreadAuthor = { kind: "person" };
/** What the app itself writes (whose chat took a thread). */
const APP: WorkThreadAuthor = { kind: "app" };

/** A change a thread cannot take reaches the page as its own words, not as a server fault. */
async function refusedAsArgs<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof WorkThreadRefused) {
      throw new AppFailure({ code: "invalid_args", message: error.message, retryable: false });
    }
    throw error;
  }
}

/** The thread as a notice names it: its id (what the chat's tools take) and its title. */
const named = (summary: Pick<WorkThreadSummary, "id" | "title">): string =>
  `Thread ${summary.id} "${summary.title}"`;

/** The notice that hands a thread the person opened to its chat. */
export function openedNotice(
  summary: WorkThreadSummary,
  kind: WorkThreadKind,
  text: string,
): string {
  return [
    `${named(summary)} (${kind}), opened by the person for this chat:`,
    "",
    text,
    "",
    `Take it up, and post your updates, questions and answers in the thread (its id: ${summary.id}).`,
  ].join("\n");
}

/** The notice for what the person wrote in a thread. */
export function messageNotice(summary: WorkThreadSummary, text: string): string {
  return [
    `${named(summary)}: the person wrote:`,
    "",
    text,
    "",
    `Answer in the thread (${summary.id}).`,
  ].join("\n");
}

/** The notice for a thread handed to this chat from another, or from none. */
export function handedNotice(summary: WorkThreadSummary): string {
  const last = summary.last === null ? "" : `\n\nIts latest: ${summary.last.text}`;
  return `${named(summary)} (${summary.kind}, ${summary.state.replace("_", " ")}) is now this chat's.${last}\n\nRead it before you take it up (its id: ${summary.id}).`;
}

/** An answer's lines: the one choice alone, else each as a list item, then the written answer and the note. */
function answerLines(answer: WorkThreadAnswer): string[] {
  const lines: string[] = [];
  if (answer.picked.length === 1 && answer.typed === undefined) lines.push(answer.picked[0] ?? "");
  else for (const label of answer.picked) lines.push(`- ${label}`);
  if (answer.typed !== undefined && answer.typed.trim() !== "") lines.push(answer.typed.trim());
  if (answer.note !== undefined && answer.note.trim() !== "")
    lines.push(`Note: ${answer.note.trim()}`);
  return lines;
}

/**
 * The notice for answers sent together, in the order asked; a skipped question is not in it (a skip gets no answer),
 * and answers that are all skips send nothing (null).
 */
export function answersNotice(
  summary: WorkThreadSummary,
  questions: readonly WorkThreadQuestion[],
  answers: ReadonlyMap<string, WorkThreadAnswer>,
): string | null {
  const given = questions.filter((question) => {
    const answer = answers.get(question.id);
    return answer !== undefined && !answer.skipped;
  });
  if (given.length === 0) return null;
  const parts = given.map((question) =>
    [
      `"${question.header ?? question.question}" (${question.id}):`,
      ...answerLines(answers.get(question.id) as WorkThreadAnswer),
    ].join("\n"),
  );
  const heading = given.length === 1 ? "answer to your question" : "answers to your questions";
  return [`${named(summary)}: the person's ${heading}:`, "", parts.join("\n\n")].join("\n");
}

/**
 * Workbench's port (`A0.threads`): the threads, the person's side of them, and `changed` to every device after each
 * change. What the person writes and answers goes to the thread's chat (its owner, else the main chat) as a notice.
 */
export function createWorkThreadsRuntime(context: WorkThreadsContext): {
  readonly registration: PortRegistration;
  readonly stop: () => void;
} {
  const now = context.now ?? Date.now;
  const changed = streamKey(WorkThreadsPort.name, "changed");
  const { store } = context;
  const stop = store.subscribe((summary) =>
    context.publish(changed, { id: summary.id, at: now() }),
  );

  const found = (id: unknown): WorkThreadSummary => {
    const summary = store.read(WorkThreadId.parse(id))?.summary;
    if (summary === undefined) {
      throw new AppFailure({
        code: "not_found",
        message: `There is no thread ${String(id)}.`,
        retryable: false,
      });
    }
    return summary;
  };
  /** The chat a thread's notices go to: its owner, else the main chat; null when neither is there. */
  const chatOf = (summary: WorkThreadSummary): ThreadId | null => summary.owner ?? store.mainChat();
  const deliverTo = async (threadId: ThreadId, text: string): Promise<void> => {
    try {
      await context.deliver({ kind: "chat", threadId }, withAppNotice(THREAD_NOTICE_SOURCE, text));
    } catch (error) {
      throw new AppFailure({
        code: "unavailable",
        message: `Kept in the thread, but it could not reach its chat: ${error instanceof Error ? error.message : String(error)}`,
        retryable: false,
      });
    }
  };
  /** Sends an ask's answers that are ready and not sent yet: marks them sent, then hands them to the chat. */
  const sendReady = async (summary: WorkThreadSummary, ask: string): Promise<WorkThreadSummary> => {
    const state = store.askOf(summary.id, ask);
    if (state === null) throw new WorkThreadRefused(`there is no ask ${ask}`);
    const ready = state.questions.filter(
      (question) => state.answers.has(question.id) && !state.sent.has(question.id),
    );
    if (ready.length === 0) throw new WorkThreadRefused("no answer waits to be sent");
    const { summary: after } = await store.post(
      summary.id,
      { type: "sent", ask, questionIds: ready.map((question) => question.id) },
      PERSON,
    );
    const text = answersNotice(after, ready, state.answers);
    const chat = chatOf(after);
    if (text !== null && chat !== null) await deliverTo(chat, text);
    return after;
  };

  const handlers = {
    list: (): WorkThreadList => ({ threads: store.list(), mainChat: store.mainChat() }),
    read: (args: unknown) => {
      const summary = found((args as { id: string }).id);
      return { summary, entries: [...(store.read(summary.id)?.entries ?? [])] };
    },
    open: (args: unknown): Promise<WorkThreadSummary> =>
      refusedAsArgs(async () => {
        const { title, kind, text, to } = args as {
          title: string;
          kind: WorkThreadKind;
          text: string;
          to: WorkThreadTarget;
        };
        const owner =
          to.kind === "chat" ? to.threadId : to.kind === "main" ? store.mainChat() : null;
        if (to.kind === "main" && owner === null)
          throw new WorkThreadRefused("No main chat is set: pick a chat, or start a new one.");
        const summary = await store.open({ title, kind, text, owner }, PERSON);
        const notice = withAppNotice(THREAD_NOTICE_SOURCE, openedNotice(summary, kind, text));
        const target: TaskTarget =
          owner === null ? (to as TaskTarget) : { kind: "chat", threadId: owner };
        let took: ThreadId | null;
        try {
          took = await context.deliver(target, notice);
        } catch (error) {
          throw new AppFailure({
            code: "unavailable",
            message: `The thread is open, but it could not reach a chat: ${error instanceof Error ? error.message : String(error)}`,
            retryable: false,
          });
        }
        if (owner === null && took !== null) {
          return (await store.post(summary.id, { type: "owner", owner: took }, APP)).summary;
        }
        return summary;
      }),
    message: (args: unknown): Promise<WorkThreadSummary> =>
      refusedAsArgs(async () => {
        const { id, text } = args as { id: string; text: string };
        const { summary } = await store.post(found(id).id, { type: "message", text }, PERSON);
        const chat = chatOf(summary);
        if (chat !== null) await deliverTo(chat, messageNotice(summary, text));
        return summary;
      }),
    answer: (args: unknown): Promise<WorkThreadSummary> =>
      refusedAsArgs(async () => {
        const { id, ask, questionId, answer } = args as {
          id: string;
          ask: string;
          questionId: string;
          answer: WorkThreadAnswer;
        };
        const { summary } = await store.post(
          found(id).id,
          { type: "answer", ask, questionId, answer },
          PERSON,
        );
        const state = store.askOf(summary.id, ask);
        const complete =
          state?.questions.every((question) => state.answers.has(question.id)) === true;
        return complete ? sendReady(summary, ask) : summary;
      }),
    sendAnswers: (args: unknown): Promise<WorkThreadSummary> =>
      refusedAsArgs(async () => {
        const { id, ask } = args as { id: string; ask: string };
        return sendReady(found(id), ask);
      }),
    setState: (args: unknown): Promise<WorkThreadSummary> =>
      refusedAsArgs(async () => {
        const { id, state } = args as { id: string; state: WorkThreadState };
        return (await store.post(found(id).id, { type: "state", state }, PERSON)).summary;
      }),
    setOwner: (args: unknown): Promise<WorkThreadSummary> =>
      refusedAsArgs(async () => {
        const { id, owner } = args as { id: string; owner: ThreadId | null };
        const before = found(id);
        if (before.owner === owner) return before;
        const { summary } = await store.post(before.id, { type: "owner", owner }, PERSON);
        const chat = chatOf(summary);
        if (chat !== null) await deliverTo(chat, handedNotice(summary));
        return summary;
      }),
    setMainChat: async (args: unknown): Promise<null> => {
      await store.setMainChat((args as { threadId: ThreadId | null }).threadId);
      context.publish(changed, { id: null, at: now() });
      return null;
    },
  };
  return { registration: { port: WorkThreadsPort, context, handlers }, stop };
}
