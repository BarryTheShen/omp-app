import { cn } from "cn";
import { ExternalLink, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import type { ShellRunView } from "./rows";
import type { ChatNotice } from "./store";

// Terminal colour and cursor codes; the box shows the text without them.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the escape character is the point
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/** A `!` or `$` run as Tern's run box: the command, what it printed, and how it ended; a running command has Stop. */
export function ShellBlock({
  run,
  onStop,
}: {
  readonly run: ShellRunView;
  readonly onStop: () => Promise<void>;
}): ReactNode {
  const output = run.output.replace(ANSI, "").trimEnd();
  const ending = run.running
    ? "running…"
    : run.cancelled
      ? "cancelled"
      : run.exitCode === undefined
        ? "ended"
        : `exit ${run.exitCode}`;
  const failed = !run.running && !run.cancelled && run.exitCode !== undefined && run.exitCode !== 0;
  return (
    <figure
      aria-label={`${run.method === "bash" ? "Shell" : "Python"} run: ${run.input}`}
      className="w-full overflow-hidden rounded-lg border border-l2 bg-(--code-bg) font-mono text-xs"
    >
      <figcaption className="flex items-center gap-2 border-b border-l2 px-3 py-1.5">
        <span className="text-t3">{run.method === "bash" ? "$" : ">>>"}</span>
        <span className="min-w-0 flex-1 truncate text-t1">{run.input}</span>
        {run.excludeFromContext && <span className="shrink-0 text-t3">not in context</span>}
      </figcaption>
      {output !== "" && (
        <pre className="max-h-72 overflow-auto px-3 py-2 whitespace-pre-wrap break-words text-t2">
          {output}
        </pre>
      )}
      <div
        className={`flex items-center gap-2 px-3 py-1 ${failed ? "text-bad-ink" : "text-t3"} ${
          output === "" ? "" : "border-t border-l2"
        }`}
      >
        <span>{ending}</span>
        {run.truncated && <span>· output cut short</span>}
        {/* omp can stop a running `!` command; a `$` run has no stop in omp's host. */}
        {run.running && run.method === "bash" && (
          <Button
            variant="ghost"
            size="xs"
            aria-label="Stop the command"
            className="ml-auto h-5 px-1.5 font-sans text-t2"
            onClick={() => void onStop()}
          >
            Stop
          </Button>
        )}
      </div>
    </figure>
  );
}

const NOTICE_TEXT: Record<Exclude<ChatNotice["level"], "status">, string> = {
  output: "font-mono text-xs text-t2",
  info: "font-sans text-[0.8125rem] text-t1",
  warning: "font-sans text-[0.8125rem] text-warn-ink",
  error: "font-sans text-[0.8125rem] text-bad-ink",
};

/**
 * What a built-in command printed, or omp's notification, kept until it is dismissed; omp's status lines stay dim. A
 * service this chat started that was shared (#2788) has Open: a one-time link into it on this device.
 */
export function NoticeRow({
  notice,
  onDismiss,
  onShareOpened,
}: {
  readonly notice: ChatNotice;
  readonly onDismiss: (id: number) => void;
  readonly onShareOpened?: (shareId: string) => void;
}): ReactNode {
  if (notice.level === "status") return <StatusLine text={notice.text} />;
  const share = notice.share;
  return (
    <div
      role={notice.level === "error" ? "alert" : "status"}
      className="flex w-full items-start gap-2 rounded-lg border border-l2 bg-raise px-3 py-2"
    >
      <pre
        className={`min-w-0 flex-1 whitespace-pre-wrap break-words ${NOTICE_TEXT[notice.level]}`}
      >
        {notice.text}
      </pre>
      {share !== undefined &&
        (share.url === null ? (
          <Button size="xs" variant="secondary" disabled>
            <ExternalLink /> Open
          </Button>
        ) : (
          <a
            href={share.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => onShareOpened?.(share.id)}
            className={buttonVariants({ size: "xs", variant: "secondary" })}
          >
            <ExternalLink /> Open
          </a>
        ))}
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Dismiss"
        className="text-t3"
        onClick={() => onDismiss(notice.id)}
      >
        <X />
      </Button>
    </div>
  );
}

/**
 * One of omp's status lines too long for a toast, as omp's terminal shows it: a dim line in the chat, here cut to one
 * line (the tools omp mounted at its start fill many). A click shows all of it.
 */
function StatusLine({ text }: { readonly text: string }): ReactNode {
  const [whole, setWhole] = useState(false);
  return (
    <button
      type="button"
      aria-expanded={whole}
      className={cn(
        "w-full min-w-0 rounded-md px-1 text-left font-sans text-[0.8125rem] text-t3 outline-none hover:text-t2 focus-visible:ring-2 focus-visible:ring-ring",
        whole ? "whitespace-pre-wrap break-words" : "truncate",
      )}
      onClick={() => setWhole((shown) => !shown)}
    >
      {text}
    </button>
  );
}
