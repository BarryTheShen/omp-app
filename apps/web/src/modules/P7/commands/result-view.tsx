import type { AppError, CommandRunResult, ConfigInfoUpdate } from "@omp-app/contracts";
import { EmptyState, InlineError, ListRow, Section } from "@/components/blocks";
import { CustomMessageRow } from "@/modules/U1/rows";

export interface CommandResultContentProps {
  readonly result: CommandRunResult | null;
  readonly error: AppError | null;
  readonly loading: boolean;
  readonly onRetry?: () => void;
}

type ThinkingLevel = NonNullable<ConfigInfoUpdate["thinkingLevel"]>;

function thinkingLevelText(level: ThinkingLevel): string {
  switch (level) {
    case "inherit":
      return "Use the model default";
    case "off":
      return "Off";
    case "minimal":
      return "Minimal";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "Extra high";
    case "max":
      return "Maximum";
  }
}

function nextOccurrenceKey(seen: Map<string, number>, identity: string): string {
  const occurrence = seen.get(identity) ?? 0;
  seen.set(identity, occurrence + 1);
  return `${identity}-${occurrence}`;
}

function CommandStatus({ result }: { readonly result: CommandRunResult }) {
  return (
    <Section heading="Command status" headingLevel={3} variant="plain">
      <div aria-live="polite" className="space-y-1" role="status">
        <ListRow
          title={
            result.status === "aborted"
              ? "The command was cancelled before it finished."
              : "The command finished."
          }
        />
        <ListRow
          title={result.agentInvoked ? "A response was started." : "No response was started."}
        />
        <ListRow
          title={
            result.promptSettled ? "The prompt has settled." : "The prompt has not settled yet."
          }
        />
        <ListRow
          title={
            result.sessionSettled ? "The session has settled." : "The session has not settled yet."
          }
        />
      </div>
    </Section>
  );
}

function CommandOutputs({ outputs }: { readonly outputs: CommandRunResult["outputs"] }) {
  const seen = new Map<string, number>();
  return (
    <Section heading="Command output" headingLevel={3} variant="plain">
      {outputs.length === 0 ? (
        <EmptyState
          hint="The command finished without a report."
          title="omp returned no command output."
          variant="compact"
        />
      ) : (
        <div className="min-w-0 space-y-2" data-p7-command-outputs>
          {outputs.map((output) => {
            const identity = `${output.emittedAt ?? "missing"}:${output.text}`;
            return (
              <div data-p7-command-output key={nextOccurrenceKey(seen, identity)}>
                <CustomMessageRow
                  content={output.text}
                  customType="Command output"
                  title="Command output"
                />
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

function ConversationUpdates({
  updates,
}: {
  readonly updates: CommandRunResult["sessionUpdates"];
}) {
  const seen = new Map<string, number>();
  return (
    <Section heading="Conversation updates" headingLevel={3} variant="plain">
      {updates.length === 0 ? (
        <EmptyState title="No conversation details changed." variant="compact" />
      ) : (
        <div className="min-w-0">
          {updates.map((update) => {
            const identity = `${update.sessionId}:${update.title ?? ""}`;
            return (
              <ListRow
                detail={update.title?.trim() || undefined}
                key={nextOccurrenceKey(seen, identity)}
                title={update.title ? "Conversation title changed" : "Conversation details updated"}
              />
            );
          })}
        </div>
      )}
    </Section>
  );
}

function SettingsUpdates({ updates }: { readonly updates: CommandRunResult["configUpdates"] }) {
  const seen = new Map<string, number>();
  return (
    <Section heading="Settings changes" headingLevel={3} variant="plain">
      {updates.length === 0 ? (
        <EmptyState title="No settings changed." variant="compact" />
      ) : (
        <div className="min-w-0">
          {updates.map((update) => {
            const identity = `${update.model?.id ?? ""}:${update.model?.name ?? ""}:${update.thinkingLevel ?? ""}`;
            return (
              <div key={nextOccurrenceKey(seen, identity)}>
                {update.model ? <ListRow detail={update.model.name} title="Model changed" /> : null}
                {update.thinkingLevel !== undefined ? (
                  <ListRow
                    detail={thinkingLevelText(update.thinkingLevel)}
                    title="Thinking level changed"
                  />
                ) : null}
                {!update.model && update.thinkingLevel === undefined ? (
                  <ListRow title="Settings changed" />
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

export function CommandResultContent({
  result,
  error,
  loading,
  onRetry,
}: CommandResultContentProps) {
  return (
    <div aria-busy={loading} className="flex min-w-0 flex-col gap-4" data-p7-command-result>
      {loading ? (
        <p aria-live="polite" className="text-muted-foreground text-sm" role="status">
          Running the command…
        </p>
      ) : null}
      {error ? (
        <InlineError
          heading="The command could not finish"
          message={error.message}
          onRetry={error.retryable ? onRetry : undefined}
          retryLabel="Try again"
        />
      ) : null}
      {result ? (
        <>
          <CommandStatus result={result} />
          <CommandOutputs outputs={result.outputs} />
          <ConversationUpdates updates={result.sessionUpdates} />
          <SettingsUpdates updates={result.configUpdates} />
        </>
      ) : null}
      {!result && !error && !loading ? (
        <EmptyState
          hint="Run a command to see its report and any conversation changes."
          title="No command result yet."
          variant="compact"
        />
      ) : null}
    </div>
  );
}
