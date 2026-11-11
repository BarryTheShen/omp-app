import { Clock, Copy, Replace, RotateCcw } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { writeClipboard } from "../clipboard";

/**
 * When a stopped chat continues by itself, in the reader's own clock: the time alone on the same day (`1:51 AM`), with
 * the weekday on a later one (`Mon 1:51 AM`).
 */
export function continueTime(at: number, now: number = Date.now()): string {
  const when = new Date(at);
  const time = when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return when.toDateString() === new Date(now).toDateString()
    ? time
    : `${when.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

const say = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);

/**
 * A request that failed, as one strip (Tern's error frame): what omp said, once, and what to do about it. Retry and
 * Switch model are offered on the chat's last word only. When the app continues the chat by itself after a usage limit
 * (#2781), the strip says when, Retry becomes Continue now, and Don't continue leaves the chat stopped.
 */
export function FailureRow({
  error,
  latest,
  continuesAt,
  onRetry,
  onSwitchModel,
  onDontContinue,
}: {
  readonly error: string;
  readonly latest: boolean;
  /** When the app continues the chat by itself (epoch ms); null when it will not. */
  readonly continuesAt: number | null;
  readonly onRetry: () => Promise<void>;
  readonly onSwitchModel: () => void;
  readonly onDontContinue: () => Promise<void>;
}): ReactNode {
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [whole, setWhole] = useState(false);
  const long = error.length > 280;
  const continuing = latest && continuesAt !== null;
  const copy = (): void => {
    writeClipboard(error).then(
      () => setCopied("copied"),
      () => setCopied("failed"),
    );
  };
  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-lg border border-[color-mix(in_srgb,var(--bad)_35%,transparent)] bg-[color-mix(in_srgb,var(--bad)_6%,transparent)] p-3"
    >
      <span className="text-xs font-medium text-bad-ink">The request failed</span>
      <p
        className={`max-w-[75ch] text-[0.8125rem] whitespace-pre-wrap break-words text-t1 ${long && !whole ? "line-clamp-4" : ""}`}
      >
        {error}
      </p>
      {long && (
        <Button
          variant="link"
          size="xs"
          className="self-start px-0"
          onClick={() => setWhole(!whole)}
        >
          {whole ? "Show less" : "Show all of it"}
        </Button>
      )}
      {latest && continuesAt !== null && (
        <p data-tour="continues-at" className="flex items-center gap-1.5 text-xs text-t2">
          <Clock aria-hidden="true" className="size-3.5 shrink-0" />
          Continues by itself at {continueTime(continuesAt)}, after the usage limit resets.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {latest && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setRetryError(null);
              onRetry().catch((failure: unknown) => setRetryError(say(failure)));
            }}
          >
            <RotateCcw />
            {continuing ? "Continue now" : "Retry"}
          </Button>
        )}
        {continuing && (
          <Button
            size="sm"
            variant="ghost"
            className="text-t2"
            onClick={() => {
              setCancelError(null);
              onDontContinue().catch((failure: unknown) => setCancelError(say(failure)));
            }}
          >
            Don't continue
          </Button>
        )}
        <Button size="sm" variant="ghost" className="text-t2" onClick={copy}>
          <Copy />
          {copied === "copied" ? "Copied" : copied === "failed" ? "Could not copy" : "Copy error"}
        </Button>
        {latest && (
          <Button size="sm" variant="ghost" className="text-t2" onClick={onSwitchModel}>
            <Replace />
            Switch model
          </Button>
        )}
      </div>
      {retryError !== null && <p className="text-xs text-bad-ink">Could not retry: {retryError}</p>}
      {cancelError !== null && (
        <p className="text-xs text-bad-ink">It will still continue: {cancelError}</p>
      )}
    </div>
  );
}
