import type { FileDiagnostics } from "./models";

const MAX_MESSAGES = 8;

/**
 * The diagnostics omp attached to a file it changed (`FileDiagnosticsResult`, omp v18.12.6
 * `packages/tui/src/tools/lsp.ts:77-88`): the summary, then omp's own text line for each diagnostic. An errored
 * result is drawn as an error, one with messages as a warning, a clean one as plain text.
 */
export function FileDiagnosticsPanel({
  diagnostics,
  slot,
}: {
  readonly diagnostics: FileDiagnostics;
  readonly slot: string;
}) {
  const messages = diagnostics.messages?.slice(0, MAX_MESSAGES) ?? [];
  const hiddenMessages = Math.max(0, (diagnostics.messages?.length ?? 0) - messages.length);
  const className = diagnostics.errored
    ? "text-danger"
    : messages.length > 0
      ? "text-warning"
      : "text-muted-foreground";
  const occurrences = new Map<string, number>();
  return (
    <div className={`flex min-w-0 flex-col gap-1 text-xs ${className}`} data-slot={slot}>
      <span className="font-medium text-muted-foreground">Diagnostics</span>
      {diagnostics.summary && (
        <p>
          {diagnostics.errored ? `Diagnostics error: ${diagnostics.summary}` : diagnostics.summary}
        </p>
      )}
      {messages.map((message) => {
        const occurrence = occurrences.get(message) ?? 0;
        occurrences.set(message, occurrence + 1);
        return <p key={`${message}:${occurrence}`}>{message}</p>;
      })}
      {hiddenMessages > 0 && (
        <p className="text-muted-foreground">
          {hiddenMessages} more diagnostic message{hiddenMessages === 1 ? "" : "s"}.
        </p>
      )}
    </div>
  );
}
