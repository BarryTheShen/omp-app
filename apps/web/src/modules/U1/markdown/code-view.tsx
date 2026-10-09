import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
import type { ThemedToken } from "shiki/core";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Icons } from "@/tokens";
import {
  createBackgroundRun,
  type HighlightRequest,
  recallTokenized,
  rememberTokenized,
  type Tokenized,
  tokenizeNow,
} from "./code-highlight";
import { resolveCodeLanguage } from "./code-language";
import { createThrottledRun, RETOKENIZE_INTERVAL_MS } from "./throttled-run";

/** Code longer than this stays plain text: highlighting a very large file would stall the transcript. */
export const CODE_HIGHLIGHT_LIMIT = 32_000;

/** How long the copy button shows its result. */
const COPY_FEEDBACK_MS = 1200;

/**
 * The lines of a code block, with every line ending as `\n`. Cards number their lines with this, so a
 * number always lines up with the row the view draws.
 */
export function codeLines(code: string): string[] {
  return code.replace(/\r\n?/g, "\n").split("\n");
}

// Shiki's font-style bits (vscode-textmate's FontStyle): italic 1, bold 2, underline 4.
// A negative value means the scope set no style.
const ITALIC = 1;
const BOLD = 2;
const UNDERLINE = 4;

function tokenStyle(token: ThemedToken): CSSProperties {
  const style: CSSProperties = { color: token.color || "var(--code-foreground)" };
  const flags = token.fontStyle !== undefined && token.fontStyle > 0 ? token.fontStyle : 0;
  if ((flags & ITALIC) !== 0) style.fontStyle = "italic";
  if ((flags & BOLD) !== 0) style.fontWeight = 700;
  if ((flags & UNDERLINE) !== 0) style.textDecoration = "underline";
  return style;
}

async function writeClipboard(value: string): Promise<void> {
  if (typeof navigator === "undefined" || navigator.clipboard === undefined) {
    throw new Error("Clipboard unavailable");
  }
  await navigator.clipboard.writeText(value);
}

export interface CodeViewProps {
  readonly code: string;
  /** A fence name or a file extension (`ts`, `python`). Unknown or missing, the code shows as plain text. */
  readonly language?: string;
  /** One number per line of `code`, which shows a gutter. A `null` leaves that row without a number. */
  readonly lineNumbers?: readonly (number | null)[];
  readonly className?: string;
  readonly copyLabel?: string;
  /** Copies in the owner's way (a card's raw-source copy); without it, the code goes to the clipboard. */
  readonly onCopy?: () => void | Promise<void>;
}

type CopyState = "idle" | "copied" | "failed";

/** The colours of line `index`, when `source` tokenized this same text on that line. */
function coloursOf(
  source: Tokenized | null,
  index: number,
  line: string,
): readonly ThemedToken[] | undefined {
  if (source === null) return undefined;
  return source.lines[index] === line ? source.tokens[index] : undefined;
}

/**
 * A code block: its language, its lines, and a copy button. The block's last tokenization is kept as state, so a
 * change that is cheap to colour (a streamed delta, at any length of block) is coloured in the render that shows
 * it. A larger change is tokenized in the background, at most once per interval, and until then the lines it did
 * not touch keep their colours. Colours never belong to other code.
 */
export function CodeView({
  code,
  language: languageName,
  lineNumbers,
  className,
  copyLabel = "Copy code",
  onCopy,
}: CodeViewProps) {
  const rows = useMemo(
    () => codeLines(code).map((line, index) => ({ id: `row-${index}`, line })),
    [code],
  );
  const lines = useMemo(() => rows.map((row) => row.line), [rows]);
  const text = useMemo(() => lines.join("\n"), [lines]);
  const language = resolveCodeLanguage(languageName);
  const bounded = text.length <= CODE_HIGHLIGHT_LIMIT;
  const [last, setLast] = useState<Tokenized | null>(() =>
    language === undefined ? null : recallTokenized(language, lines),
  );
  // A state set during render is applied before the frame is shown, so the change is coloured in its own frame.
  const tokenized =
    language !== undefined && bounded ? tokenizeNow(last, language, lines) : undefined;
  if (tokenized !== undefined && tokenized !== last) setLast(tokenized);

  const [copy, setCopy] = useState<CopyState>("idle");
  // One throttle per block. A background run waits for the previous one to end, then an interval.
  const [scheduler] = useState(() =>
    createThrottledRun<HighlightRequest>({
      intervalMs: RETOKENIZE_INTERVAL_MS,
      run: createBackgroundRun(setLast),
      now: () => performance.now(),
      setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimer: (handle) => window.clearTimeout(handle),
    }),
  );
  const background = language !== undefined && bounded && tokenized === undefined;

  useEffect(() => {
    if (background && language !== undefined) scheduler.request({ language, lines });
    else scheduler.cancel();
  }, [background, language, lines, scheduler]);

  useEffect(() => () => scheduler.cancel(), [scheduler]);

  useEffect(() => {
    if (last !== null) rememberTokenized(last);
  }, [last]);

  useEffect(() => {
    if (copy === "idle") return undefined;
    const timer = window.setTimeout(() => setCopy("idle"), COPY_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [copy]);

  const source = tokenized ?? (bounded && last?.language === language ? last : null);
  const shownRows = rows.map((row, index) => ({
    ...row,
    tokens: coloursOf(source, index, row.line),
  }));
  const coloured = shownRows.some((row) => row.tokens?.some((token) => Boolean(token.color)));

  const copyCode = async (): Promise<void> => {
    try {
      if (onCopy !== undefined) await onCopy();
      else await writeClipboard(code);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  };

  const label = language ?? (languageName?.trim() || "text");
  const copyStatus = copy === "copied" ? "Copied" : copy === "failed" ? "Copy unavailable" : "";
  return (
    <div
      className={cn("border-border bg-muted/30 overflow-hidden rounded-lg border", className)}
      data-code-view
    >
      <div className="border-border/60 bg-muted/60 flex min-w-0 items-center justify-between gap-2 border-b px-3 py-1.5 text-xs">
        <span className="text-muted-foreground min-w-0 truncate font-mono" data-code-language>
          {label}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <span aria-live="polite" className="text-muted-foreground" role="status">
            {copyStatus}
          </span>
          <Button
            aria-label={copyLabel}
            className="text-foreground"
            onClick={() => void copyCode()}
            size="icon-xs"
            title={copyLabel}
            type="button"
            variant="ghost"
          >
            {copy === "copied" ? (
              <Icons.check aria-hidden="true" />
            ) : (
              <Icons.copy aria-hidden="true" />
            )}
          </Button>
        </div>
      </div>
      <pre
        className="max-w-full overflow-x-auto p-3 text-sm leading-relaxed"
        data-code-state={coloured ? "highlighted" : "plain"}
      >
        <code className="font-mono text-(--code-foreground)">
          {shownRows.map((row, index) => (
            <span className="block" key={row.id}>
              {lineNumbers !== undefined && (
                <span
                  aria-hidden="true"
                  className="text-muted-foreground mr-4 inline-block min-w-8 text-right select-none"
                >
                  {lineNumbers[index] ?? ""}
                </span>
              )}
              {row.tokens === undefined
                ? row.line || " "
                : row.tokens.length === 0
                  ? " "
                  : row.tokens.map((token) => (
                      <span data-code-token key={token.offset} style={tokenStyle(token)}>
                        {token.content}
                      </span>
                    ))}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
