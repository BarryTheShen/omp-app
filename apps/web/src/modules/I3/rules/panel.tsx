import type { RuleScope } from "@omp-app/contracts";
import { EmptyState, InlineError, ListRow, Section } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { PanelFocusToken, PanelOpenReason, PanelState } from "../../U5/panel/contract";
import { PanelShell } from "../../U5/panel/shell";
import type { RulesController } from "./controller";

export interface RulesPanelProps {
  readonly controller: RulesController;
  readonly invokingFocus?: PanelFocusToken;
  readonly restoreFocus?: (token: PanelFocusToken) => void;
}

const SCOPES: readonly RuleScope[] = ["global", "project"];

function lifecycle(controller: RulesController): PanelState["lifecycle"] {
  const { state } = controller;
  if (!state.open) return "closed";
  if (state.errorKind === "load") return "error";
  if (state.loading) return "loading";
  if (state.rules.length === 0 && state.query.trim().length === 0) return "empty";
  return state.saving || state.deleting ? "updating" : "populated";
}

export function RulesPanel({ controller, invokingFocus, restoreFocus }: RulesPanelProps) {
  const { state, actions } = controller;
  const panelState: PanelState = {
    open: state.open,
    lifecycle: lifecycle(controller),
    position: "right",
    title: "Rules",
    error: state.errorKind === "load" ? (state.error?.appError ?? null) : null,
    readOnly: false,
    pendingUpdates: 0,
  };
  const disabled = state.loading || state.saving || state.deleting;
  const selected = state.selected;
  const retry = () => {
    if (state.errorAction === "save") return actions.save();
    if (state.errorAction === "delete") return actions.remove();
    if (state.errorAction === "read") return actions.reloadSelected();
    return actions.refresh();
  };
  return (
    <PanelShell
      state={panelState}
      invokingFocus={invokingFocus}
      restoreFocus={restoreFocus}
      onOpenChange={(open, _reason: PanelOpenReason) => (open ? actions.open() : actions.close())}
      onRetry={() => retry()}
      toolbar={
        <Button
          disabled={disabled}
          size="sm"
          type="button"
          variant="outline"
          onClick={() => void actions.refresh()}
        >
          Refresh
        </Button>
      }
      body={
        <div className="flex min-w-0 flex-col gap-4 p-4">
          <Section heading="Rule scope" description="Choose the rules source to review.">
            <fieldset className="flex flex-wrap gap-2">
              <legend className="sr-only">Rule scope</legend>
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
                  {candidate === "global" ? "All projects" : "This project"}
                </Button>
              ))}
            </fieldset>
          </Section>
          {state.errorKind === "action" && state.error && !state.conflict && (
            <InlineError
              message={state.error.appError.message}
              actions={
                <Button size="sm" type="button" variant="outline" onClick={() => void retry()}>
                  Retry
                </Button>
              }
            />
          )}

          <Section heading="Find a rule" description="Search names and rule text.">
            <Input
              aria-label="Search rules"
              value={state.query}
              onChange={(event) => actions.setQuery(event.target.value)}
            />
          </Section>

          {state.rules.length === 0 &&
            state.query.trim().length > 0 &&
            !state.loading &&
            !state.error && (
              <EmptyState
                title="No rules found"
                hint="Try a different search or scope."
                variant="compact"
              />
            )}
          {state.rules.length > 0 && (
            <Section
              heading="Rules"
              description={`${state.rules.length} rule${state.rules.length === 1 ? "" : "s"}`}
            >
              <div className="flex min-w-0 flex-col gap-2" role="listbox" aria-label="Rules">
                {state.rules.map((rule) => (
                  <ListRow
                    key={rule.id}
                    title={rule.name}
                    detail={`${rule.enabled ? "Enabled" : "Disabled"} · ${rule.source === "agent" ? "Saved for all projects" : "Saved for this project"}`}
                    asOption
                    selected={selected?.id === rule.id}
                    onSelect={() => void actions.select(rule.id)}
                  />
                ))}
              </div>
            </Section>
          )}

          {selected && (
            <Section
              heading="Rule details"
              description="Changes are saved when you choose Save rule."
            >
              <div className="flex flex-col gap-3">
                <Textarea
                  aria-label="Rule content"
                  disabled={disabled}
                  value={state.draft}
                  onChange={(event) => actions.setDraft(event.target.value)}
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={disabled || !state.draftDirty || state.conflict}
                    type="button"
                    variant="outline"
                    onClick={() => void actions.save()}
                  >
                    Save rule
                  </Button>
                  <Button
                    disabled={disabled}
                    type="button"
                    variant="outline"
                    onClick={() => actions.setEnabled(!state.enabled)}
                  >
                    {state.enabled ? "Disable rule" : "Enable rule"}
                  </Button>
                  <Button
                    disabled={disabled || state.conflict}
                    type="button"
                    variant="destructive"
                    onClick={() => void actions.remove()}
                  >
                    Delete rule
                  </Button>
                </div>
                {state.conflict && (
                  <InlineError
                    message={
                      state.draftKept
                        ? "Your draft is kept. Reload the newer rule or confirm Overwrite before saving it."
                        : "This rule changed elsewhere. Reload it, keep your draft, or confirm Overwrite before saving."
                    }
                    actions={
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          type="button"
                          variant="outline"
                          onClick={() => void actions.reloadSelected()}
                        >
                          Reload newer rule
                        </Button>
                        <Button
                          size="sm"
                          type="button"
                          variant="outline"
                          onClick={actions.keepDraft}
                        >
                          Keep my draft
                        </Button>
                        <Button
                          size="sm"
                          type="button"
                          variant="outline"
                          onClick={() => void actions.overwrite()}
                        >
                          Overwrite newer rule
                        </Button>
                      </div>
                    }
                  />
                )}
              </div>
            </Section>
          )}
        </div>
      }
    />
  );
}
