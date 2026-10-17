import type { MemoryEntry, MemoryScope } from "@omp-app/contracts";
import { EmptyState, ListRow, Section } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { PanelFocusToken, PanelOpenReason, PanelState } from "../../U5/panel/contract";
import { PanelShell } from "../../U5/panel/shell";
import {
  MEMORY_COMMAND_LABELS,
  MEMORY_COMMANDS,
  type MemoryCommand,
  requiresMemoryCommandExecutor,
} from "./commands";
import type { MemoryCenterController } from "./controller";

export interface MemoryCenterPanelProps {
  readonly controller: MemoryCenterController;
  readonly invokingFocus?: PanelFocusToken;
  readonly restoreFocus?: (token: PanelFocusToken) => void;
}

const SCOPES: readonly MemoryScope[] = ["global", "project", "session"];

function scopeLabel(scope: MemoryScope): string {
  return scope === "global" ? "All projects" : scope === "project" ? "This project" : "This chat";
}

function lifecycle(controller: MemoryCenterController): PanelState["lifecycle"] {
  if (!controller.state.open) return "closed";
  if (controller.state.error) return "error";
  if (controller.state.loading) return "loading";
  if (controller.state.entries.length === 0) return "empty";
  return controller.state.saving || controller.state.deleting ? "updating" : "populated";
}

function commandGroup(commands: readonly MemoryCommand[]): readonly MemoryCommand[] {
  return commands.filter((command) => MEMORY_COMMANDS.includes(command));
}
function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "date unavailable" : date.toLocaleDateString();
}
function entryTitle(entry: MemoryEntry, index: number): string {
  const label = entry.metadata.label;
  return typeof label === "string" && label.trim().length > 0 ? label : `Memory item ${index + 1}`;
}
export function MemoryCenterPanel({
  controller,
  invokingFocus,
  restoreFocus,
}: MemoryCenterPanelProps) {
  const { state, actions } = controller;
  const panelState: PanelState = {
    open: state.open,
    lifecycle: lifecycle(controller),
    position: "right",
    title: "Memory",
    description: "Review and maintain memory by scope without exposing private backend details.",
    error: state.error?.appError ?? null,
    readOnly: !state.canEdit,
    pendingUpdates: 0,
  };
  const disabled = state.loading || state.saving || state.deleting;
  const selected = state.selected;
  const destructive = commandGroup(["clear", "mm-seed"]);

  return (
    <PanelShell
      state={panelState}
      invokingFocus={invokingFocus}
      restoreFocus={restoreFocus}
      onOpenChange={(open, _reason: PanelOpenReason) => (open ? actions.open() : actions.close())}
      onRetry={() => {
        if (state.errorAction === "save") return actions.save();
        if (state.errorAction === "delete") return actions.remove();
        return actions.refresh();
      }}
      toolbar={
        <Button
          disabled={disabled}
          size="sm"
          type="button"
          variant="outline"
          onClick={() => actions.refresh()}
        >
          Refresh
        </Button>
      }
      body={
        <div className="flex min-w-0 flex-col gap-4 p-4">
          <Section heading="Memory scope" description="Choose which memory source to review.">
            <fieldset className="flex flex-wrap gap-2">
              <legend className="sr-only">Memory scope</legend>
              {SCOPES.map((candidate) => (
                <Button
                  key={candidate}
                  aria-pressed={state.scope === candidate}
                  disabled={disabled}
                  size="sm"
                  type="button"
                  variant={state.scope === candidate ? "default" : "outline"}
                  onClick={() => void actions.setScope(candidate)}
                >
                  {scopeLabel(candidate)}
                </Button>
              ))}
            </fieldset>
          </Section>

          {!state.canEdit && (
            <p
              className="rounded-lg border border-warning/40 bg-warning-surface p-3 text-sm"
              role="status"
            >
              {state.unavailableReason}
            </p>
          )}

          {state.entries.length === 0 && !state.loading && !state.error && (
            <EmptyState
              title="No memory in this scope"
              hint="Memory saved for this scope will appear here."
              variant="compact"
            />
          )}

          {state.entries.length > 0 && (
            <Section
              heading="Saved memory"
              description={`${state.entries.length} item${state.entries.length === 1 ? "" : "s"}`}
            >
              <div className="flex min-w-0 flex-col gap-2" role="listbox" aria-label="Saved memory">
                {state.entries.map((entry, index) => (
                  <ListRow
                    key={entry.id}
                    title={entryTitle(entry, index)}
                    detail={`${entry.sensitive ? "Private memory" : "Visible memory"} · updated ${dateLabel(entry.updatedAt)}`}
                    asOption
                    selected={selected?.id === entry.id}
                    onSelect={() => void actions.select(entry.id)}
                  />
                ))}
              </div>
            </Section>
          )}

          {selected && (
            <Section
              heading="Memory details"
              description={`Memory source: ${scopeLabel(selected.scope)} · updated ${dateLabel(selected.updatedAt)}`}
            >
              <div className="flex flex-col gap-3">
                <Textarea
                  aria-label="Memory content"
                  disabled={!state.canEdit || disabled || selected.sensitive}
                  value={
                    selected.sensitive
                      ? "This memory is marked private and its content is hidden."
                      : state.draft
                  }
                  onChange={(event) => actions.setDraft(event.target.value)}
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={!state.canEdit || disabled || !state.draftDirty}
                    type="button"
                    variant="outline"
                    onClick={() => void actions.save()}
                  >
                    Save memory
                  </Button>
                  <Button
                    disabled={!state.canEdit || disabled}
                    type="button"
                    variant="destructive"
                    onClick={() => void actions.remove()}
                  >
                    Delete memory
                  </Button>
                </div>
                {state.draftConflict && (
                  <p
                    className="rounded-lg border border-warning/40 bg-warning-surface p-3 text-sm"
                    role="status"
                  >
                    Memory changed elsewhere while you were editing. Keep your draft or reload the
                    newer memory.
                    <span className="mt-2 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        type="button"
                        variant="outline"
                        onClick={() => void actions.reloadDraft()}
                      >
                        Reload newer memory
                      </Button>
                      <Button size="sm" type="button" variant="outline" onClick={actions.keepDraft}>
                        Keep my draft
                      </Button>
                    </span>
                  </p>
                )}
              </div>
            </Section>
          )}
        </div>
      }
      footer={
        <div className="flex flex-wrap gap-2 px-4 py-3">
          {destructive.map((command) => (
            <Button
              key={command}
              disabled={
                !state.canEdit ||
                disabled ||
                state.command?.status === "pending" ||
                (requiresMemoryCommandExecutor(command) && !state.commandGatewayAvailable)
              }
              type="button"
              variant="outline"
              onClick={() => void actions.runCommand(command)}
            >
              {MEMORY_COMMAND_LABELS[command]}
            </Button>
          ))}
          <fieldset className="flex flex-wrap gap-2">
            <legend className="sr-only">Memory commands</legend>
            {commandGroup([
              "view",
              "stats",
              "diagnose",
              "enqueue",
              "mm-list",
              "mm-show",
              "mm-history",
              "mm-refresh",
              "mm-reload",
            ]).map((command) => (
              <Button
                key={command}
                disabled={
                  disabled ||
                  state.command?.status === "pending" ||
                  (requiresMemoryCommandExecutor(command) && !state.commandGatewayAvailable) ||
                  (command === "mm-show" && selected === undefined)
                }
                size="sm"
                type="button"
                variant="ghost"
                onClick={() => void actions.runCommand(command)}
              >
                {MEMORY_COMMAND_LABELS[command]}
              </Button>
            ))}
          </fieldset>
          {!state.commandGatewayAvailable && (
            <p className="basis-full text-sm text-muted-foreground" role="status">
              Some memory actions are unavailable because omp cannot return safe results for them
              yet.
            </p>
          )}
          {state.command && (
            <p className="text-muted-foreground basis-full text-sm" role="status">
              {state.command.status === "pending"
                ? "Working on memory…"
                : (state.command.message ??
                  state.command.error?.appError.message ??
                  "The memory command failed.")}
            </p>
          )}
        </div>
      }
    />
  );
}
