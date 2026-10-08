import { useId } from "react";
import { EmptyState, Section, SettingRow, Toolbar } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import type { PanelOpenReason, PanelState } from "../../U5/panel/contract";
import { PanelShell } from "../../U5/panel/shell";
import type { GoalStatus } from "../contract";
import type { GoalPanelSnapshot } from "./controller";

const GOAL_STATUS_LABELS: Record<GoalStatus, string> = {
  active: "Active",
  paused: "Paused",
  "budget-limited": "Budget limited",
  complete: "Complete",
  dropped: "Dropped",
};

export interface GoalPanelViewProps {
  readonly open: boolean;
  readonly position: PanelState["position"];
  readonly snapshot: GoalPanelSnapshot;
  readonly onOpenChange: (open: boolean, reason: PanelOpenReason) => void;
  readonly onRefresh: () => void;
  readonly onCreate: () => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onDrop: () => void;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function formatDuration(seconds: number): string {
  const totalSeconds = Math.round(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainder = totalSeconds % 60;
  const parts = [
    hours > 0 ? `${hours} ${hours === 1 ? "hour" : "hours"}` : null,
    minutes > 0 ? `${minutes} ${minutes === 1 ? "minute" : "minutes"}` : null,
    remainder > 0 || totalSeconds === 0
      ? `${remainder} ${remainder === 1 ? "second" : "seconds"}`
      : null,
  ];
  return parts.filter((part) => part !== null).join(" ");
}

function ActionButton({
  label,
  availability,
  busy,
  onClick,
  destructive = false,
}: {
  readonly label: string;
  readonly availability: GoalPanelSnapshot["createAvailability"];
  readonly busy: boolean;
  readonly onClick: () => void;
  readonly destructive?: boolean;
}) {
  return (
    <Button
      disabled={busy || availability.state !== "available"}
      size="sm"
      title={availability.state === "unavailable" ? availability.reason : label}
      type="button"
      variant={destructive ? "destructive" : "outline"}
      onClick={onClick}
    >
      {label}
    </Button>
  );
}

export function GoalPanelView({
  open,
  position,
  snapshot,
  onOpenChange,
  onRefresh,
  onCreate,
  onPause,
  onResume,
  onDrop,
}: GoalPanelViewProps) {
  const objectiveId = useId();
  const busy = snapshot.pending !== null;
  const goal = snapshot.goal;
  const panelState: PanelState = {
    open,
    lifecycle: snapshot.lifecycle,
    position,
    title: "Goal",
    description: "See the objective, progress, and budget for this conversation.",
    error: snapshot.error,
    readOnly: false,
    pendingUpdates: 0,
  };
  const toolbar = (
    <Button
      disabled={busy}
      size="sm"
      title="Refresh goal status"
      type="button"
      variant="ghost"
      onClick={onRefresh}
    >
      Refresh
    </Button>
  );

  let body = null;
  if (goal === null && snapshot.lifecycle === "populated") {
    body = (
      <EmptyState
        title={snapshot.capabilityMessage ? "Goal controls are unavailable" : "No goal is active"}
        hint={
          snapshot.capabilityMessage ?? "Create a goal to give this conversation a clear objective."
        }
        variant="compact"
        action={
          <ActionButton
            availability={snapshot.createAvailability}
            busy={busy}
            label="Create a goal"
            onClick={onCreate}
          />
        }
      />
    );
  } else if (snapshot.lifecycle === "error" && !goal) {
    body = null;
  } else if (goal) {
    const statusLabel = GOAL_STATUS_LABELS[goal.status];
    const continuation = snapshot.continuation;
    const updateReason =
      snapshot.editAvailability.state === "unavailable" ? snapshot.editAvailability.reason : "";
    const actions = (
      <Toolbar ariaLabel="Goal actions">
        {snapshot.showPause ? (
          <ActionButton
            availability={snapshot.pauseAvailability}
            busy={busy}
            label="Pause goal"
            onClick={onPause}
          />
        ) : null}
        {snapshot.showResume ? (
          <ActionButton
            availability={snapshot.resumeAvailability}
            busy={busy}
            label="Resume goal"
            onClick={onResume}
          />
        ) : null}
        {snapshot.showDrop ? (
          <ActionButton
            availability={snapshot.dropAvailability}
            busy={busy}
            destructive
            label="Drop goal"
            onClick={onDrop}
          />
        ) : null}
      </Toolbar>
    );
    const budgetText =
      goal.tokenBudget === undefined
        ? "No token budget set"
        : `${formatNumber(goal.tokenBudget)} tokens`;

    body = (
      <div className="flex min-w-0 flex-col gap-4">
        {snapshot.capabilityMessage ? (
          <p className="text-muted-foreground text-sm" role="status">
            {snapshot.capabilityMessage}
          </p>
        ) : null}
        {snapshot.notice ? (
          <p className="text-muted-foreground text-sm" role="status">
            {snapshot.notice}
          </p>
        ) : null}
        <Section heading="Objective" headingId={objectiveId} variant="plain">
          <p className="break-words whitespace-pre-wrap px-2 text-sm">{goal.objective}</p>
        </Section>
        <Section heading="Progress and budget" variant="plain">
          <SettingRow title="Status">{statusLabel}</SettingRow>
          <SettingRow title="Tokens used">{formatNumber(goal.tokensUsed)}</SettingRow>
          <SettingRow title="Token budget">{budgetText}</SettingRow>
          <SettingRow title="Time used">{formatDuration(goal.timeUsedSeconds)}</SettingRow>
        </Section>
        {continuation ? (
          <Section heading="Continuation" variant="plain">
            <SettingRow title="Status">{continuation.label}</SettingRow>
          </Section>
        ) : null}
        <Section heading="Actions" variant="plain">
          {actions}
          <Toolbar ariaLabel="Goal editing">
            {snapshot.showCreate ? (
              <ActionButton
                availability={snapshot.createAvailability}
                busy={busy}
                label="Create a goal"
                onClick={onCreate}
              />
            ) : null}
            <Button disabled title={updateReason} type="button" variant="outline">
              Edit goal
            </Button>
            <Button disabled title={updateReason} type="button" variant="outline">
              Change budget
            </Button>
          </Toolbar>
          <p className="text-muted-foreground mt-2 px-2 text-xs">{updateReason}</p>
        </Section>
      </div>
    );
  } else if (snapshot.lifecycle === "loading" || snapshot.lifecycle === "updating") {
    body = null;
  }

  return (
    <PanelShell
      body={body}
      className="min-w-0"
      onOpenChange={onOpenChange}
      onRetry={onRefresh}
      state={panelState}
      toolbar={toolbar}
    />
  );
}
