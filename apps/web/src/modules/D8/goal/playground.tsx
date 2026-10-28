import { StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import type { Goal, GoalState } from "../contract";
import { continuationStatus } from "../contract";
import type { GoalPanelSnapshot } from "./controller";
import { GoalPanelView } from "./view";

const initialGoal: Goal = {
  id: "goal-playground",
  objective: "Keep the project healthy and ready to ship",
  status: "active",
  tokensUsed: 18_420,
  timeUsedSeconds: 3_725,
  createdAt: 1,
  updatedAt: 2,
  tokenBudget: 50_000,
};

function GoalPlayground() {
  const [goal, setGoal] = useState(initialGoal);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState(
    () => !new URLSearchParams(window.location.search).has("closed"),
  );
  const openButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = (token: string) => {
    if (token === "goal-panel-open") openButton.current?.focus();
  };
  const goalState: GoalState = {
    goal,
    state: { enabled: true, mode: "active", goal },
    source: "request",
    sessionSettled: true,
  };
  const canPause = goal.status === "active" || goal.status === "budget-limited";
  const canResume = goal.status === "paused";
  const canDrop = canPause || canResume;
  const canCreate = goal.status === "complete" || goal.status === "dropped";
  const snapshot: GoalPanelSnapshot = {
    lifecycle: "populated",
    goalState,
    goal,
    continuation: continuationStatus(goal, ["interactive"]),
    pending: null,
    error: null,
    notice,
    capabilityMessage: null,
    showCreate: canCreate,
    showPause: canPause,
    showResume: canResume,
    showDrop: canDrop,
    createAvailability: canCreate
      ? { state: "available" }
      : { state: "unavailable", reason: "Finish the current goal first." },
    pauseAvailability: canPause
      ? { state: "available" }
      : { state: "unavailable", reason: "This goal cannot be paused in its current state." },
    resumeAvailability: canResume
      ? { state: "available" }
      : { state: "unavailable", reason: "This goal is not paused." },
    dropAvailability: canDrop
      ? { state: "available" }
      : { state: "unavailable", reason: "This goal can no longer be dropped." },
    editAvailability: {
      state: "unavailable",
      reason: "Editing the goal and its token budget is not available yet.",
      capability: "upstream.goal-update",
    },
    budgetAvailability: {
      state: "unavailable",
      reason: "Editing the goal and its token budget is not available yet.",
      capability: "upstream.goal-update",
    },
  };
  const updateStatus = (status: Goal["status"]) => {
    setGoal((current) => ({ ...current, status, updatedAt: current.updatedAt + 1 }));
    setNotice(null);
  };

  return (
    <main className="min-h-screen bg-background text-foreground" data-testid="goal-playground">
      <Button ref={openButton} onClick={() => setOpen(true)} type="button" variant="outline">
        Open goal panel
      </Button>
      <GoalPanelView
        open={open}
        position="right"
        snapshot={snapshot}
        invokingFocus="goal-panel-open"
        onOpenChange={(nextOpen) => setOpen(nextOpen)}
        restoreFocus={restoreFocus}
        onRefresh={() => setNotice("The latest goal status is shown.")}
        onCreate={() => updateStatus("active")}
        onPause={() => updateStatus("paused")}
        onResume={() => updateStatus("active")}
        onDrop={() => updateStatus("dropped")}
      />
    </main>
  );
}

const root = document.getElementById("goal-playground-root");
if (!root) throw new Error("Goal playground root is missing.");

createRoot(root).render(
  <StrictMode>
    <GoalPlayground />
  </StrictMode>,
);
