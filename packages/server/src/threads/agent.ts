import {
  type FolderPath,
  type ThreadId,
  type WorkThreadAuthor,
  type WorkThreadEntry,
  WorkThreadId,
  WorkThreadKind,
  WorkThreadLink,
  WorkThreadPost,
  WorkThreadState,
  type WorkThreadSummary,
} from "@omp-app/contracts";
import { type ToolCallAnswer, WorkThreadToolRequest } from "@omp-app/contracts/chat-host";
import { z } from "zod";
import { WorkThreadRefused, type WorkThreadStore } from "./store";

/** The chat whose agent called: its id, its folder and its name now. */
export interface ThreadCallingChat {
  readonly threadId: ThreadId;
  readonly folder: FolderPath | null;
  readonly title: string | null;
}

const said = (text: string): ToolCallAnswer => ({ content: [{ type: "text", text }] });
const refused = (text: string): ToolCallAnswer => ({
  content: [{ type: "text", text }],
  isError: true,
});

/** A refused field, in a few words: "title: Too big: expected string to have <=200 characters". */
function issues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "call"}: ${issue.message}`)
    .join("; ");
}

const OpenParams = z.object({
  title: z.string(),
  kind: WorkThreadKind.exclude(["briefing"]),
  text: z.string(),
});
const ReadParams = z.object({ id: WorkThreadId.optional(), state: WorkThreadState.optional() });
const IdParams = z.object({ id: WorkThreadId });
const LinkParams = z.object({
  id: WorkThreadId,
  kind: z.enum(["commit", "issue", "release", "url", "chat"]),
  sha: z.string().optional(),
  repo: z.string().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  version: z.string().optional(),
  chat: z.string().optional(),
});

/** Who wrote an entry, as this chat's agent reads it. */
function whoIn(by: WorkThreadAuthor, chat: ThreadId): string {
  if (by.kind === "person") return "the user";
  if (by.kind === "app") return "the app";
  return by.threadId === chat
    ? "this chat"
    : `chat ${by.threadId}${by.title === null ? "" : ` "${by.title}"`}`;
}

const ownerIn = (summary: WorkThreadSummary, chat: ThreadId): string =>
  summary.owner === null
    ? "no chat (the main chat takes it)"
    : summary.owner === chat
      ? "this chat"
      : `chat ${summary.owner}`;

const progressIn = (summary: WorkThreadSummary): string =>
  summary.progress === null ? "" : `, ${summary.progress.done}/${summary.progress.total}`;

/** One row of the list as the agent reads it. */
function rowOf(summary: WorkThreadSummary, chat: ThreadId): string {
  const waits = summary.unanswered === 0 ? "" : `, ${summary.unanswered} question(s) unanswered`;
  return `- ${summary.id} [${summary.state}${progressIn(summary)}] ${summary.kind}: "${summary.title}", owner ${ownerIn(summary, chat)}${waits}`;
}

/** One entry of a timeline as the agent reads it. */
function entryLines(entry: WorkThreadEntry, chat: ThreadId): string {
  const head = `${entry.id} ${new Date(entry.at).toISOString()} ${whoIn(entry.by, chat)}`;
  switch (entry.type) {
    case "created":
      return `${head} opened it (${entry.kind}):\n${entry.text}`;
    case "update": {
      const bar =
        entry.progress === undefined ? "" : ` (${entry.progress.done}/${entry.progress.total})`;
      return `${head} update${bar}:\n${entry.text}`;
    }
    case "progress":
      return `${head} progress ${entry.progress.done}/${entry.progress.total}`;
    case "question":
      return `${head} asked (ask ${entry.id}):\n${entry.questions.map((question) => `- ${question.id}: ${question.question}`).join("\n")}`;
    case "answer":
      return `${head} answered ${entry.questionId} of ask ${entry.ask}: ${
        entry.answer.skipped
          ? "skipped"
          : [
              ...entry.answer.picked,
              ...(entry.answer.typed === undefined ? [] : [entry.answer.typed]),
            ].join("; ")
      }${entry.answer.note === undefined ? "" : ` (note: ${entry.answer.note})`}`;
    case "sent":
      return `${head} sent the answers to ${entry.questionIds.join(", ")} of ask ${entry.ask}`;
    case "message":
      return `${head} wrote:\n${entry.text}`;
    case "link":
      return `${head} linked ${JSON.stringify(entry.link)}`;
    case "state":
      return `${head} set it ${entry.state}`;
    case "owner":
      return `${head} handed it to ${entry.owner === null ? "no chat" : entry.owner === chat ? "this chat" : `chat ${entry.owner}`}`;
  }
}

/** The link a `thread_link` call names, checked by the contract. */
function linkOf(params: z.infer<typeof LinkParams>): unknown {
  switch (params.kind) {
    case "commit":
      return {
        kind: "commit",
        sha: params.sha,
        ...(params.repo === undefined ? {} : { repo: params.repo }),
      };
    case "issue":
    case "url":
      return {
        kind: params.kind,
        url: params.url,
        ...(params.title === undefined ? {} : { title: params.title }),
      };
    case "release":
      return { kind: "release", version: params.version };
    case "chat":
      return { kind: "chat", threadId: params.chat, title: params.title ?? null };
  }
}

/**
 * Answers a chat's `thread_*` call from Workbench. A thread an agent opens is its chat's; only that chat asks in it, so
 * the answers come back to the agent that asked. A subagent only reads. Every entry names the chat.
 */
export async function answerThreadCall(
  store: WorkThreadStore,
  chat: ThreadCallingChat,
  raw: unknown,
): Promise<ToolCallAnswer> {
  const request = WorkThreadToolRequest.safeParse(raw);
  if (!request.success) return refused(`Not a Workbench call: ${issues(request.error)}`);
  const { tool, agent, params } = request.data;
  if (tool !== "thread_read" && agent === "sub") {
    return refused(
      "A subagent only reads Workbench (thread_read); the chat's own agent changes it.",
    );
  }
  const by: WorkThreadAuthor = { kind: "chat", threadId: chat.threadId, title: chat.title };
  const thread = (id: WorkThreadId): WorkThreadSummary => {
    const summary = store.read(id)?.summary;
    if (summary === undefined)
      throw new WorkThreadRefused(`There is no thread ${id}; thread_read lists them.`);
    return summary;
  };
  const post = async (id: WorkThreadId, value: unknown): Promise<WorkThreadEntry> => {
    const parsed = WorkThreadPost.safeParse(value);
    if (!parsed.success) throw new WorkThreadRefused(issues(parsed.error));
    return (await store.post(thread(id).id, parsed.data, by)).entry;
  };
  try {
    switch (tool) {
      case "thread_open": {
        const parsed = OpenParams.safeParse(params);
        if (!parsed.success) return refused(issues(parsed.error));
        const summary = await store
          .open({ ...parsed.data, owner: chat.threadId }, by)
          .catch((error: unknown) => {
            if (error instanceof z.ZodError) throw new WorkThreadRefused(issues(error));
            throw error;
          });
        return said(
          `Opened thread ${summary.id} "${summary.title}". Post to it with its id: ${summary.id}.`,
        );
      }
      case "thread_read": {
        const parsed = ReadParams.safeParse(params ?? {});
        if (!parsed.success) return refused(issues(parsed.error));
        if (parsed.data.id === undefined) {
          const rows = store
            .list()
            .filter(
              (summary) => parsed.data.state === undefined || summary.state === parsed.data.state,
            );
          return said(
            rows.length === 0
              ? "No threads."
              : `${rows.length} thread(s):\n${rows.map((row) => rowOf(row, chat.threadId)).join("\n")}`,
          );
        }
        const read = store.read(parsed.data.id);
        if (read === null)
          return refused(`There is no thread ${parsed.data.id}; thread_read lists them.`);
        return said(
          [
            rowOf(read.summary, chat.threadId).slice(2),
            ...read.summary.links.map((link) => `link: ${JSON.stringify(link)}`),
            "",
            ...read.entries.map((entry) => entryLines(entry, chat.threadId)),
          ].join("\n"),
        );
      }
      case "thread_update": {
        const parsed = IdParams.safeParse(params);
        if (!parsed.success) return refused(issues(parsed.error));
        const { text, progress } = params as { text?: unknown; progress?: unknown };
        const entry = await post(parsed.data.id, {
          type: "update",
          text,
          ...(progress === undefined ? {} : { progress }),
        });
        return said(`Posted ${entry.id} to thread ${parsed.data.id}.`);
      }
      case "thread_ask": {
        const parsed = IdParams.safeParse(params);
        if (!parsed.success) return refused(issues(parsed.error));
        const summary = thread(parsed.data.id);
        if (summary.owner !== chat.threadId) {
          return refused(
            `Thread ${summary.id} is ${ownerIn(summary, chat.threadId)}'s: only the chat that owns a thread asks in it, so the answers come back to it.`,
          );
        }
        const questions = ((params as { questions?: unknown }).questions ?? []) as unknown[];
        const entry = await post(summary.id, {
          type: "question",
          questions: Array.isArray(questions)
            ? questions.map((question) =>
                typeof question === "object" && question !== null
                  ? { options: [], multi: false, ...question }
                  : question,
              )
            : questions,
        });
        return said(
          `Asked in thread ${summary.id} (ask ${entry.id}). The user answers when they have time; the answers reach this chat as one notice from the thread. Keep working on what does not depend on them, and do not ask again.`,
        );
      }
      case "thread_state": {
        const parsed = IdParams.safeParse(params);
        if (!parsed.success) return refused(issues(parsed.error));
        await post(parsed.data.id, { type: "state", state: (params as { state?: unknown }).state });
        return said(`Thread ${parsed.data.id} is ${(params as { state: string }).state} now.`);
      }
      case "thread_link": {
        const parsed = LinkParams.safeParse(params);
        if (!parsed.success) return refused(issues(parsed.error));
        const link = WorkThreadLink.safeParse(linkOf(parsed.data));
        if (!link.success) return refused(issues(link.error));
        await post(parsed.data.id, { type: "link", link: link.data });
        return said(`Linked to thread ${parsed.data.id}.`);
      }
    }
  } catch (error) {
    if (error instanceof WorkThreadRefused) return refused(error.message);
    throw error;
  }
}
