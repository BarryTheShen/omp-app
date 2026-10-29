import { Copy, Replace, RotateCcw } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * A request that failed, as one strip (Tern's error frame): what omp said, once, and what to do about it. Retry and
 * Switch model are offered on the chat's last word only.
 */
export function FailureRow({
  error,
  latest,
  onRetry,
  onSwitchModel,
}: {
  readonly error: string;
  readonly latest: boolean;
  readonly onRetry: () => Promise<void>;
  readonly onSwitchModel: () => void;
}): ReactNode {
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [whole, setWhole] = useState(false);
  const long = error.length > 280;
  const copy = (): void => {
    navigator.clipboard.writeText(error).then(
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
        className={`text-[0.8125rem] whitespace-pre-wrap break-words text-t1 ${long && !whole ? "line-clamp-4" : ""}`}
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
      <div className="flex flex-wrap gap-2">
        {latest && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setRetryError(null);
              onRetry().catch((failure: unknown) =>
                setRetryError(failure instanceof Error ? failure.message : String(failure)),
              );
            }}
          >
            <RotateCcw />
            Retry
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
    </div>
  );
}
