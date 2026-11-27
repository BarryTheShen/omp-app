/**
 * Workbench threads: one place per bug, feature or piece of work, private to the app (never on GitHub). A thread is a
 * timeline of entries, kept on the server one line each in `<app data>/threads/<id>.jsonl`: who opened it and why, the
 * agent's updates and progress, its questions and the person's answers, messages both ways, links (the chats working
 * on it, commits, issues, releases) and its state. A thread is owned by a chat (omp's session, `ThreadId`), which gets
 * the person's answers and messages; a "work thread" is never that chat itself.
 */
import { z } from "zod";
import type { PortClient, PortHandlers } from "../../core/envelope";
import { definePort } from "../../core/envelope";
import { FolderPath, ThreadId } from "../../core/ids";

/** The longest title, text, question and link label; the most questions in one ask, choices in one question. */
export const WORK_THREAD_TITLE_MAX = 200;
export const WORK_THREAD_TEXT_MAX = 20_000;
export const WORK_THREAD_QUESTIONS_MAX = 20;
export const WORK_THREAD_OPTIONS_MAX = 20;
export const WORK_THREAD_LABEL_MAX = 200;
export const WORK_THREAD_STEPS_MAX = 50;

/** A thread's id: short, so an agent can carry it (`thread_update {id}`). */
export const WorkThreadId = z
  .string()
  .regex(/^[a-z0-9]{6,32}$/, "expected a thread id")
  .brand<"WorkThreadId">();
export type WorkThreadId = z.infer<typeof WorkThreadId>;

/** What the thread is about. The daily briefing keeps its own thread. */
export const WorkThreadKind = z.enum(["bug", "feature", "task", "question", "briefing"]);
export type WorkThreadKind = z.infer<typeof WorkThreadKind>;

/** Where it stands. "waiting" is waiting on the person (an answer, a test only they can run, their go). */
export const WorkThreadState = z.enum(["open", "in_progress", "waiting", "done", "closed"]);
export type WorkThreadState = z.infer<typeof WorkThreadState>;

/** Who wrote an entry: the person (a page), a chat's agent (named by its chat), or the app itself. */
export const WorkThreadAuthor = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("person") }),
  z.strictObject({
    kind: z.literal("chat"),
    threadId: ThreadId,
    /** The chat's name when it wrote; null before omp named it. */
    title: z.string().max(WORK_THREAD_TITLE_MAX).nullable(),
  }),
  z.strictObject({ kind: z.literal("app") }),
]);
export type WorkThreadAuthor = z.infer<typeof WorkThreadAuthor>;

const Title = z.string().trim().min(1).max(WORK_THREAD_TITLE_MAX);
const Text = z.string().trim().min(1).max(WORK_THREAD_TEXT_MAX);
const Label = z.string().trim().min(1).max(WORK_THREAD_LABEL_MAX);

/** How far the work is: `done` of `total` steps, with the steps' names when the agent gave them. */
export const WorkThreadProgress = z
  .strictObject({
    done: z.number().int().min(0),
    total: z.number().int().min(1).max(WORK_THREAD_STEPS_MAX),
    steps: z.array(Label).max(WORK_THREAD_STEPS_MAX).optional(),
  })
  .refine((progress) => progress.done <= progress.total, "done is more than total")
  .refine(
    (progress) => progress.steps === undefined || progress.steps.length === progress.total,
    "steps must name every step",
  );
export type WorkThreadProgress = z.infer<typeof WorkThreadProgress>;

/** Something the thread points at. */
export const WorkThreadLink = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("chat"),
    threadId: ThreadId,
    title: z.string().max(WORK_THREAD_TITLE_MAX).nullable(),
  }),
  z.strictObject({
    kind: z.literal("commit"),
    sha: z.string().regex(/^[0-9a-f]{7,40}$/),
    repo: Label.optional(),
  }),
  z.strictObject({ kind: z.literal("issue"), url: z.url(), title: Label.optional() }),
  z.strictObject({ kind: z.literal("release"), version: Label }),
  z.strictObject({ kind: z.literal("url"), url: z.url(), title: Label.optional() }),
]);
export type WorkThreadLink = z.infer<typeof WorkThreadLink>;

/** One question of an ask, as `ask_async` takes it today. */
export const WorkThreadQuestion = z.strictObject({
  /** The agent's id for it, unique in its ask. */
  id: z.string().trim().min(1).max(64),
  question: Text,
  header: Label.optional(),
  /** Why it asks and what each answer changes, in Markdown. */
  context: z.string().max(WORK_THREAD_TEXT_MAX).optional(),
  /** None: the person writes the answer. */
  options: z
    .array(
      z.strictObject({
        label: Label,
        description: z.string().max(WORK_THREAD_TEXT_MAX).optional(),
      }),
    )
    .max(WORK_THREAD_OPTIONS_MAX),
  multi: z.boolean(),
  recommended: z.number().int().min(0).optional(),
});
export type WorkThreadQuestion = z.infer<typeof WorkThreadQuestion>;

/** What the person did with one question: the choices picked and a written answer, with a note; or a skip. */
export const WorkThreadAnswer = z.strictObject({
  picked: z.array(Label).max(WORK_THREAD_OPTIONS_MAX),
  typed: z.string().max(WORK_THREAD_TEXT_MAX).optional(),
  note: z.string().max(WORK_THREAD_TEXT_MAX).optional(),
  skipped: z.boolean(),
});
export type WorkThreadAnswer = z.infer<typeof WorkThreadAnswer>;

/**
 * What can be added to a thread after it is opened (the entry without its id, time and author, which the store
 * gives). `update` is the agent's progress note; `answer` answers one question of an ask and may be changed until
 * `sent` hands that ask's answers to the owning chat.
 */
const UpdatePost = z.strictObject({
  type: z.literal("update"),
  text: Text,
  progress: WorkThreadProgress.optional(),
});
const ProgressPost = z.strictObject({ type: z.literal("progress"), progress: WorkThreadProgress });
const QuestionPost = z.strictObject({
  type: z.literal("question"),
  questions: z.array(WorkThreadQuestion).min(1).max(WORK_THREAD_QUESTIONS_MAX),
});
const AnswerPost = z.strictObject({
  type: z.literal("answer"),
  /** The `question` entry's id. */
  ask: z.string().min(1).max(64),
  questionId: z.string().min(1).max(64),
  answer: WorkThreadAnswer,
});
const SentPost = z.strictObject({
  type: z.literal("sent"),
  ask: z.string().min(1).max(64),
  questionIds: z.array(z.string().min(1).max(64)).min(1).max(WORK_THREAD_QUESTIONS_MAX),
});
const MessagePost = z.strictObject({ type: z.literal("message"), text: Text });
const LinkPost = z.strictObject({ type: z.literal("link"), link: WorkThreadLink });
const StatePost = z.strictObject({ type: z.literal("state"), state: WorkThreadState });
/** The chat that owns the thread changes (null: none, the main chat takes it). */
const OwnerPost = z.strictObject({ type: z.literal("owner"), owner: ThreadId.nullable() });

export const WorkThreadPost = z.discriminatedUnion("type", [
  UpdatePost,
  ProgressPost,
  QuestionPost,
  AnswerPost,
  SentPost,
  MessagePost,
  LinkPost,
  StatePost,
  OwnerPost,
]);
export type WorkThreadPost = z.infer<typeof WorkThreadPost>;

/** How a thread is opened: its title, kind, first text, and the chat that owns it (null: none yet). */
export const OpenWorkThreadArgs = z.strictObject({
  title: Title,
  kind: WorkThreadKind,
  text: Text,
  owner: ThreadId.nullable(),
});
export type OpenWorkThreadArgs = z.infer<typeof OpenWorkThreadArgs>;

/** Every entry's id (`e1`, `e2`, … in its thread), time (epoch ms) and author. */
const EntryHead = { id: z.string().min(1).max(64), at: z.number(), by: WorkThreadAuthor };

/** One line of a thread's file: the first is always `created`. */
export const WorkThreadEntry = z.discriminatedUnion("type", [
  OpenWorkThreadArgs.extend({ ...EntryHead, type: z.literal("created") }),
  UpdatePost.extend(EntryHead),
  ProgressPost.extend(EntryHead),
  QuestionPost.extend(EntryHead),
  AnswerPost.extend(EntryHead),
  SentPost.extend(EntryHead),
  MessagePost.extend(EntryHead),
  LinkPost.extend(EntryHead),
  StatePost.extend(EntryHead),
  OwnerPost.extend(EntryHead),
]);
export type WorkThreadEntry = z.infer<typeof WorkThreadEntry>;

/** A thread as the list shows it: folded from its entries. */
export const WorkThreadSummary = z.strictObject({
  id: WorkThreadId,
  title: Title,
  kind: WorkThreadKind,
  state: WorkThreadState,
  owner: ThreadId.nullable(),
  createdAt: z.number(),
  createdBy: WorkThreadAuthor,
  /** The latest entry's time: the list's order. */
  updatedAt: z.number(),
  /** The latest progress, null before any. */
  progress: WorkThreadProgress.nullable(),
  /** Questions with no answer yet: what waits on the person. */
  unanswered: z.number().int().min(0),
  links: z.array(WorkThreadLink),
  /** The latest entry that has words, cut short, for the row. */
  last: z.strictObject({ type: z.string(), text: z.string(), at: z.number() }).nullable(),
  entries: z.number().int().min(1),
});
export type WorkThreadSummary = z.infer<typeof WorkThreadSummary>;

/** Where a thread the person opens goes: the main chat, a chat they pick, or a new chat started for it in a folder. */
export const WorkThreadTarget = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("main") }),
  z.strictObject({ kind: z.literal("chat"), threadId: ThreadId }),
  z.strictObject({ kind: z.literal("new"), folder: FolderPath }),
]);
export type WorkThreadTarget = z.infer<typeof WorkThreadTarget>;

const ById = { id: WorkThreadId };

/** The list, and the chat that takes a thread no chat owns (null: none set). */
export const WorkThreadList = z.strictObject({
  threads: z.array(WorkThreadSummary),
  mainChat: ThreadId.nullable(),
});
export type WorkThreadList = z.infer<typeof WorkThreadList>;

/**
 * Workbench (`A0.threads`): the threads, and the person's side of them from any page: opening one for a chat, writing
 * in one, answering its questions, its state and owner. What the person writes or answers goes to the chat that owns
 * the thread at once, as a notice from the thread (`<app-notice source="thread">`), while a turn runs too; a chat
 * that cannot take it now gets it once it is free. Every device hears `changed`.
 */
export const WorkThreadsPort = definePort({
  name: "A0.threads",
  methods: {
    list: { args: z.strictObject({}), result: WorkThreadList },
    read: {
      args: z.strictObject(ById),
      result: z.strictObject({ summary: WorkThreadSummary, entries: z.array(WorkThreadEntry) }),
    },
    /** Opens a thread and hands its first text to the chat it goes to. */
    open: {
      args: z.strictObject({
        title: Title,
        kind: WorkThreadKind,
        text: Text,
        to: WorkThreadTarget,
      }),
      result: WorkThreadSummary,
    },
    /** The person writes in a thread: kept, and sent to its chat. */
    message: { args: z.strictObject({ ...ById, text: Text }), result: WorkThreadSummary },
    /**
     * Answers one question of an ask (or skips it); once every question of the ask has one, the answers go to the
     * chat together. An answer not sent yet can be changed.
     */
    answer: {
      args: z.strictObject({
        ...ById,
        ask: z.string().min(1).max(64),
        questionId: z.string().min(1).max(64),
        answer: WorkThreadAnswer,
      }),
      result: WorkThreadSummary,
    },
    /** Sends the ask's answers ready so far, without waiting for the rest. */
    sendAnswers: {
      args: z.strictObject({ ...ById, ask: z.string().min(1).max(64) }),
      result: WorkThreadSummary,
    },
    setState: {
      args: z.strictObject({ ...ById, state: WorkThreadState }),
      result: WorkThreadSummary,
    },
    /** Hands the thread to another chat (null: the main chat takes it). */
    setOwner: {
      args: z.strictObject({ ...ById, owner: ThreadId.nullable() }),
      result: WorkThreadSummary,
    },
    setMainChat: { args: z.strictObject({ threadId: ThreadId.nullable() }), result: z.null() },
  },
  events: {
    /** A thread changed (null: the main chat did), from any device or chat. */
    changed: { payload: z.strictObject({ id: WorkThreadId.nullable(), at: z.number() }) },
  },
});
export type WorkThreadsPort = typeof WorkThreadsPort;
export type WorkThreadsClient = PortClient<WorkThreadsPort>;
export type WorkThreadsHandlers<Context> = PortHandlers<WorkThreadsPort, Context>;
