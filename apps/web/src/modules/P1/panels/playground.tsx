import { AppFailure } from "@omp-app/contracts";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  type AgentHubActions,
  type AgentHubController,
  type CancelAction,
  createAgentHubController,
} from "./controller";
import {
  FIXTURE_NOW,
  fixtureClock,
  fixtureRoster,
  fixtureWorker,
  lifecycleEvent,
} from "./fixtures";
import { AgentHubPanel } from "./hub";
import type { HubLoad } from "./model";
import { useAgentHub } from "./use-agent-hub";

/** Every visual state of the Agent Hub, chosen with `?scenario=` in the page address. */
export const SCENARIOS = [
  "populated",
  "by-parent",
  "transcript-open",
  "cancelling",
  "cancel-failed",
  "loading",
  "empty",
  "error",
  "unavailable",
  "late-roster",
] as const;
export type Scenario = (typeof SCENARIOS)[number];

const TRANSCRIPT_REASON = "The transcript view is not connected in this playground.";
const SELECTED_KEY = "scan:0";
const LATE_ROSTER_MS = 400;

function loadFor(scenario: Scenario): HubLoad {
  switch (scenario) {
    case "loading":
    case "late-roster":
      return { state: "loading" };
    case "error":
      return {
        state: "error",
        error: {
          code: "omp_error",
          message: "The subagent roster request failed.",
          retryable: true,
        },
      };
    case "unavailable":
      return { state: "unavailable", reason: "This omp does not report its subagents." };
    default:
      return { state: "ready" };
  }
}

function cancelFor(scenario: Scenario): CancelAction {
  if (scenario === "cancelling") {
    return { state: "available", run: () => Promise.withResolvers<unknown>().promise };
  }
  if (scenario === "cancel-failed") {
    return {
      state: "available",
      run: async () => {
        throw new AppFailure({
          code: "not_found",
          message: "Subagent is no longer running",
          retryable: false,
        });
      },
    };
  }
  return { state: "available", run: async () => ({ cancelled: true }) };
}

function actionsFor(scenario: Scenario): AgentHubActions {
  return {
    cancel: cancelFor(scenario),
    openTranscript:
      scenario === "transcript-open"
        ? { state: "available", open: () => undefined }
        : { state: "unavailable", reason: TRANSCRIPT_REASON },
  };
}

async function scenarioController(scenario: Scenario): Promise<AgentHubController> {
  const hasWorkers = scenario !== "empty" && scenario !== "loading" && scenario !== "error";
  const store = await fixtureRoster({
    clock: fixtureClock(),
    workers: hasWorkers
      ? [
          fixtureWorker("scan", 1, {
            description: "Scan the repository",
            task: "List every module and its owner.",
            progress: {
              currentTool: "read",
              toolCount: 6,
              requests: 3,
              tokens: 18_240,
              cost: 0.0213,
              durationMs: 74_000,
              resolvedModel: "fixture-provider/fixture-model:high",
              modelRole: "fast",
            },
          }),
          fixtureWorker("plan", 2, { description: "Plan the change", status: "pending" }),
          fixtureWorker("tests", 3, { description: "Run the tests" }),
          fixtureWorker("review", 4, {
            description: "Review the diff",
            parentToolCallId: "call-review",
          }),
          fixtureWorker("broken", 5, {
            description: "Update the lockfile",
            parentToolCallId: "call-review",
          }),
        ]
      : [],
    events: hasWorkers
      ? [
          { at: FIXTURE_NOW + 30_000, seq: 1, event: lifecycleEvent("tests", 3, "completed") },
          { at: FIXTURE_NOW + 60_000, seq: 2, event: lifecycleEvent("review", 4, "aborted") },
          { at: FIXTURE_NOW + 90_000, seq: 3, event: lifecycleEvent("broken", 5, "failed") },
        ]
      : [],
  });
  const controller = createAgentHubController({
    roster: store,
    initialLoad: loadFor(scenario),
    actions: () => actionsFor(scenario),
  });
  if (scenario === "late-roster") {
    window.setTimeout(() => controller.setLoad({ state: "ready" }), LATE_ROSTER_MS);
  }
  if (scenario === "by-parent") controller.setView("byParent");
  if (hasWorkers) controller.select(SELECTED_KEY);
  if (scenario === "cancelling" || scenario === "cancel-failed")
    void controller.cancel(SELECTED_KEY);
  return controller;
}

function ScenarioPanel({ controller }: { readonly controller: AgentHubController }) {
  const state = useAgentHub(controller);
  return (
    <div className="h-screen w-96 max-w-full" data-testid="p1-hub-playground-panel">
      <AgentHubPanel
        model={state.model}
        onCancel={(key) => void controller.cancel(key)}
        onOpenTranscript={() => undefined}
        onRetry={() => controller.setLoad({ state: "ready" })}
        onSelect={(key) => controller.select(key)}
        onViewChange={(view) => controller.setView(view)}
      />
    </div>
  );
}

function scenarioFromAddress(): Scenario {
  const requested = new URLSearchParams(window.location.search).get("scenario");
  return SCENARIOS.find((scenario) => scenario === requested) ?? "populated";
}

function HubPlayground() {
  const [scenario] = useState<Scenario>(scenarioFromAddress);
  const [controller, setController] = useState<AgentHubController | null>(null);
  useEffect(() => {
    let active = true;
    void scenarioController(scenario).then((next) => {
      if (active) setController(next);
    });
    return () => {
      active = false;
    };
  }, [scenario]);
  return (
    <main className="bg-background text-foreground min-h-screen" data-testid="p1-hub-playground">
      {controller ? <ScenarioPanel controller={controller} /> : null}
    </main>
  );
}

const root = document.getElementById("p1-hub-playground-root");
if (!root) throw new Error("The Agent Hub playground root is missing.");
createRoot(root).render(
  <StrictMode>
    <HubPlayground />
  </StrictMode>,
);
