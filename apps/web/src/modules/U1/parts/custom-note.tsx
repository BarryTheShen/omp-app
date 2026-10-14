import { createContext, type ReactNode, useContext, useState } from "react";
import { Button } from "@/components/ui/button";
import { MarkdownContent } from "../markdown";
import {
  describeSkillPrompt,
  SKILL_PROMPT_CUSTOM_TYPE,
  SkillPromptCard,
} from "./skill-prompt-card";

/** What `metadata.custom` carries for a custom message (set by R0's conversion). */
export interface CustomNoteSource {
  readonly customType: string;
  readonly details: unknown;
  /** The message's text, as omp saved it. */
  readonly text: string;
}

export interface CustomNoteView {
  /** A short plain-English heading, when the kind of message is known. */
  readonly heading: string | undefined;
  readonly body: string;
  /**
   * The body is omp's full text: the note shows the heading as its one line and keeps the body behind a
   * "Full message" control.
   */
  readonly bodyInDetails?: boolean;
}

/** A worker a background-job notice names, as the chat's roster knows it: how it ended, and its transcript. */
export interface WorkerNote {
  readonly status: "pending" | "running" | "completed" | "failed" | "aborted" | "stopped";
  /** Why the worker failed, in the words the server gave; the notice shows it after "failed:". */
  readonly reason?: string;
  /** The worker's transcript, shown on request. */
  readonly transcript: ReactNode;
}

/** The worker a notice names, by its id; undefined when the chat does not know it. The app provides it. */
export type WorkerNoteLookup = (jobId: string) => WorkerNote | undefined;

export const WorkerNoteContext = createContext<WorkerNoteLookup | undefined>(undefined);

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value
    ? Reflect.get(value, key)
    : undefined;
}

/** The task jobs a notice names, when every job it names is a task. A notice that also names a command keeps its text. */
function workerJobIds(source: CustomNoteSource): readonly string[] | undefined {
  if (source.customType !== "async-result") return undefined;
  const jobs = field(source.details, "jobs");
  if (!Array.isArray(jobs) || jobs.length === 0) return undefined;
  const ids: string[] = [];
  for (const job of jobs) {
    const id = field(job, "jobId");
    if (typeof id !== "string" || field(job, "type") !== "task") return undefined;
    ids.push(id);
  }
  return ids;
}

/** How a worker ended, in plain words, from the roster's typed status. omp's own text is not read here. */
const WORKER_ENDINGS: Record<WorkerNote["status"], string> = {
  pending: "has ended",
  running: "has ended",
  completed: "finished",
  failed: "failed",
  aborted: "was aborted",
  stopped: "was stopped",
};

/** A worker's line in its notice: how it ended, and for a failure, why, when the server gave the reason. */
function workerHeading(jobId: string, worker: WorkerNote): string {
  if (worker.status === "failed" && worker.reason !== undefined)
    return `${jobId} failed: ${worker.reason}`;
  return `${jobId} ${WORKER_ENDINGS[worker.status]}.`;
}

/**
 * omp wraps the text it sends the model in a tag of its own (`<system-notice>...</system-notice>`).
 * The tag is for the model: a note shows what is inside it. Text without such a wrapper is unchanged.
 */
export function withoutWrapper(text: string): string {
  const match = /^\s*<([a-z][a-z0-9_-]*)(?:\s[^>]*)?>\s*([\s\S]*?)\s*<\/\1>\s*$/i.exec(text);
  return match?.[2] ?? text.trim();
}

/** omp's own cut for a tangent's work (`packages/tui/src/chat/background-tan-message.ts:7-13`, v18.9.1). */
const TANGENT_WORK_CHARACTERS = 56;

/** A tangent's work on one line: whitespace joined, then cut to 56 characters with the last one an ellipsis. */
function previewOf(work: string): string {
  const line = work.replace(/\s+/g, " ").trim();
  if (line.length <= TANGENT_WORK_CHARACTERS) return line;
  return `${line.slice(0, TANGENT_WORK_CHARACTERS - 1)}…`;
}

/**
 * The heading and body of one of omp's own messages. Headings come from the message's kind and its
 * `details` (never from reading omp's prose); an unknown kind shows its text under no heading.
 */
export function describeCustomMessage(source: CustomNoteSource): CustomNoteView {
  const { customType, details, text } = source;
  switch (customType) {
    case "irc:incoming": {
      const from = field(details, "from");
      const message = field(details, "message");
      return {
        heading: typeof from === "string" ? `Message from ${from}` : "Message from another agent",
        body: typeof message === "string" ? message : withoutWrapper(text),
      };
    }
    case "async-result":
      return { heading: "Background job finished", body: withoutWrapper(text) };
    case "advisor": {
      const notes = field(details, "notes");
      const lines = Array.isArray(notes)
        ? notes.flatMap((note) => {
            const line = field(note, "note");
            return typeof line === "string" ? [line] : [];
          })
        : [];
      return {
        heading: "Advisor note",
        body: lines.length > 0 ? lines.join("\n\n") : withoutWrapper(text),
      };
    }
    case "launch-completion":
      return { heading: "Process finished", body: withoutWrapper(text) };
    case "background-tan-dispatch": {
      const jobId = field(details, "jobId");
      const work = field(details, "work");
      const job = typeof jobId === "string" ? `background job ${jobId}` : "a background job";
      const preview = typeof work === "string" ? previewOf(work) : "";
      const heading =
        preview === "" ? `Tangent sent to ${job}` : `Tangent sent to ${job}: ${preview}`;
      return { heading, body: withoutWrapper(text), bodyInDetails: true };
    }
    default:
      return { heading: undefined, body: withoutWrapper(text) };
  }
}

/** The workers a notice names: one line each, how it ended, and its transcript on request. */
function WorkerNotes({
  jobIds,
  lookup,
}: {
  readonly jobIds: readonly string[];
  readonly lookup: WorkerNoteLookup | undefined;
}) {
  return (
    <div
      className="flex min-w-0 flex-col gap-2"
      data-custom-type="async-result"
      data-slot="u1-custom-note"
    >
      {jobIds.map((jobId) => (
        <WorkerLine key={jobId} jobId={jobId} worker={lookup?.(jobId)} />
      ))}
    </div>
  );
}

function WorkerLine({
  jobId,
  worker,
}: {
  readonly jobId: string;
  readonly worker: WorkerNote | undefined;
}) {
  const [open, setOpen] = useState(false);
  if (worker === undefined) {
    return (
      <div className="flex min-w-0 flex-col gap-1" data-slot="u1-custom-note-worker">
        <p className="text-foreground text-xs font-medium" data-slot="u1-custom-note-heading">
          {`${jobId} has ended.`}
        </p>
        <p className="text-muted-foreground text-xs">Its transcript is not available here.</p>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-1" data-slot="u1-custom-note-worker">
      <p className="text-foreground text-xs font-medium" data-slot="u1-custom-note-heading">
        {workerHeading(jobId, worker)}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-expanded={open}
        className="self-start"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "Hide transcript" : "View transcript"}
      </Button>
      {open && (
        <div className="min-w-0" data-slot="u1-custom-note-transcript">
          {worker.transcript}
        </div>
      )}
    </div>
  );
}

/** One of omp's own messages in the transcript: a muted note, its heading, and its text. */
export function CustomNote({ source }: { readonly source: CustomNoteSource }) {
  const lookup = useContext(WorkerNoteContext);
  const jobIds = workerJobIds(source);
  if (jobIds !== undefined) return <WorkerNotes jobIds={jobIds} lookup={lookup} />;
  if (source.customType === SKILL_PROMPT_CUSTOM_TYPE) {
    return (
      <div
        className="flex min-w-0 flex-col"
        data-custom-type={source.customType}
        data-slot="u1-custom-note"
      >
        <SkillPromptCard view={describeSkillPrompt(source.details, source.text)} />
      </div>
    );
  }
  const { heading, body, bodyInDetails } = describeCustomMessage(source);
  const fullText = (
    <div className="max-h-80 min-w-0 overflow-auto" data-slot="u1-custom-note-body">
      <MarkdownContent text={body} variant="compact" />
    </div>
  );
  return (
    <div
      className="flex min-w-0 flex-col gap-1"
      data-custom-type={source.customType}
      data-slot="u1-custom-note"
    >
      {heading !== undefined && (
        <p className="text-foreground text-xs font-medium" data-slot="u1-custom-note-heading">
          {heading}
        </p>
      )}
      {bodyInDetails === true ? (
        <details className="min-w-0" data-slot="u1-custom-note-details">
          <summary className="text-muted-foreground cursor-pointer rounded-sm text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            Full message
          </summary>
          <div className="mt-2">{fullText}</div>
        </details>
      ) : (
        fullText
      )}
    </div>
  );
}
