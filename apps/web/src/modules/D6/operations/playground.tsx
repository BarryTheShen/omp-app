import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { fixtureAgent, fixtureClock, fixtureRosterStore } from "@/modules/P1/fixtures/common";
import { RECORDED_PROGRESS } from "@/modules/P1/fixtures/roster";
import { btwModelOf, cleanseModelOf, omfgModelOf, pauseModelOf } from "./model";
import { operationsViews } from "./panels";

const {
  btw: BtwPanel,
  cleanse: CleansePanel,
  omfg: OmfgPanel,
  pause: PausePanel,
} = operationsViews;
const longQuestion = "Q".repeat(200);
const longComplaint = "C".repeat(200);
const showSaveFailure =
  new URLSearchParams(window.location.search).get("scenario") === "save-failed";

function recordedRoster() {
  const store = fixtureRosterStore(fixtureClock(1_000));
  store.mergeSnapshot([
    fixtureAgent("LongProbe", 0, {
      description: `Checker ${"A".repeat(200)}`,
      progress: RECORDED_PROGRESS,
    }),
  ]);
  return store.getSnapshot();
}

const roster = recordedRoster();

function OperationsPlayground() {
  const [notice, setNotice] = useState("Select an operation to see its local result.");
  const selectQuestion = (id: string): void => {
    setNotice(`Selected side question ${id}.`);
  };
  const copyAnswer = (): void => {
    setNotice("The side-question answer is ready to copy.");
  };
  function operationAction(message: string): () => void {
    const action = (): void => {
      setNotice(message);
    };
    return action;
  }
  return (
    <main
      className="min-h-screen bg-background p-4 text-foreground"
      data-testid="d6-5-operations-playground"
    >
      <div className="mx-auto grid max-w-6xl gap-4 lg:grid-cols-2">
        <BtwPanel
          model={btwModelOf({
            turns: [
              {
                id: "question-1",
                question: "Which folder should I inspect?",
                answer: "The selected workspace is ready for inspection.",
                status: "complete",
              },
              {
                id: "question-2",
                question: longQuestion,
                answer: "Streaming a second answer…",
                status: "running",
              },
            ],
            selectedId: "question-2",
            copy: { state: "available" },
            cancel: { state: "available" },
            branch: {
              state: "unavailable",
              reason: "Opening a side question in chat is not available here.",
            },
          })}
          onBranch={operationAction("Opening a side question in chat is unavailable.")}
          onCancel={operationAction("The side question was cancelled locally.")}
          onCopy={copyAnswer}
          onSelect={selectQuestion}
        />
        <CleansePanel
          model={cleanseModelOf({
            status: "running",
            wave: 2,
            totalWaves: 3,
            checker: "repository",
            request: "Check the repository",
            progress: 0.58,
            message: "Two checkers are reporting progress.",
            agentIds: ["LongProbe"],
            roster,
            check: { state: "available" },
            run: { state: "available" },
            cancel: { state: "available" },
          })}
          onCancel={operationAction("Cleanse cancellation is local only.")}
          onCheck={operationAction("Checker discovery is local only.")}
          onRun={operationAction("Cleanse execution is local only.")}
        />
        <OmfgPanel
          model={omfgModelOf({
            status: showSaveFailure ? "failed" : "preview",
            complaint: longComplaint,
            candidate: "Before replying, check the result and name the next action.",
            validation: ["Preview only; nothing has been saved."],
            ...(showSaveFailure
              ? {
                  error: {
                    code: "internal" as const,
                    message: "The rule draft failed.",
                    retryable: true,
                  },
                }
              : {}),
            amend: { state: "available" },
            cancel: { state: "available" },
          })}
          onAmend={operationAction("Rule amendment is local only.")}
          onCancel={operationAction("Rule draft cancelled.")}
          onSave={operationAction("Rule saving is local only.")}
        />
        <PausePanel
          model={pauseModelOf({
            snapshot: {
              open: true,
              openedAt: 1_000,
              elapsedMs: 125_000,
              authoritative: false,
              reason: "Paused locally while you review the work.",
            },
            resume: { state: "available" },
          })}
          onResume={operationAction("Pause screen resumed locally.")}
        />
        <p aria-live="polite" className="text-muted-foreground text-sm" role="status">
          {notice}
        </p>
      </div>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("The operations playground root is missing.");
createRoot(root).render(
  <StrictMode>
    <OperationsPlayground />
  </StrictMode>,
);
