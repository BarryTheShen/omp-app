import { type CapabilityMap, ThreadId } from "@omp-app/contracts";
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { OverlayHost, useStableOverlayHost } from "../../../overlay";
import { renderDialogRequest } from "../../U4/dialogs";
import { DialogHostController } from "../../U4/host";
import { loopGate } from "../loop/gate";
import { LoopControls } from "../loop/view";
import { GuidedGoalController } from "./controller";
import { useGuidedGoal } from "./hook";
import { GuidedGoalView } from "./view";

const playgroundCapabilities: CapabilityMap = {
  "omp.cmd.goal": { state: "available", via: "omp" },
};

/** A stand-in for omp in the visual playground only: every create succeeds at once. */
const playgroundAutonomy = {
  goal: async () => ({ goal: null, state: null }),
  subscribeGoal: () => () => {},
};

const playgroundGoal = {
  getSnapshot: () => null,
  subscribe: () => () => {},
};

interface PlaygroundProps {
  readonly controller: GuidedGoalController;
  readonly message: string;
  readonly onMessageChange: (text: string) => void;
}

function GuidedPlayground({ controller, message, onMessageChange }: PlaygroundProps) {
  const view = useGuidedGoal(controller);
  const evidenceState = new URLSearchParams(window.location.search).get("state");
  const snapshot =
    evidenceState === "interviewing"
      ? { ...view.snapshot, status: "interviewing" as const, createReason: null }
      : evidenceState === "creating"
        ? { ...view.snapshot, status: "creating" as const, createReason: null }
        : evidenceState === "blocked"
          ? {
              ...view.snapshot,
              status: "idle" as const,
              createReason: "A goal is already active. Drop it before creating another.",
            }
          : view.snapshot;
  return (
    <main
      className="flex min-h-screen flex-col gap-6 bg-background p-4 text-foreground"
      data-testid="d8-4-guided-playground"
    >
      <div className="w-full max-w-xl">
        <GuidedGoalView onRetry={view.retry} onStart={view.start} snapshot={snapshot} />
      </div>
      <div className="w-full max-w-xl">
        <label className="flex flex-col gap-2 text-sm">
          Message box
          <textarea
            aria-label="Message box"
            className="min-h-24 rounded-md border bg-background p-2"
            onChange={(event) => onMessageChange(event.target.value)}
            value={message}
          />
        </label>
      </div>
      <div className="w-full max-w-xl">
        <LoopControls
          gate={loopGate({})}
          onPause={() => undefined}
          onResume={() => undefined}
          onStart={() => undefined}
          onStop={() => undefined}
          run="idle"
        />
      </div>
    </main>
  );
}

function Playground() {
  const overlay = useStableOverlayHost();
  const [controller, setController] = useState<GuidedGoalController | null>(null);
  const [message, setMessage] = useState("");
  const messageRef = useRef("");

  const changeMessage = (text: string) => {
    messageRef.current = text;
    setMessage(text);
  };

  useEffect(() => {
    const dialogs = new DialogHostController({
      overlay,
      capabilities: playgroundCapabilities,
      answerDialog: async () => {
        throw new Error("The playground has no omp to answer.");
      },
      render: renderDialogRequest,
    });
    const next = new GuidedGoalController({
      threadId: ThreadId.parse("thread-playground"),
      autonomy: playgroundAutonomy,
      dialogs,
      capabilities: () => playgroundCapabilities,
      goal: playgroundGoal,
      restoreFocus: () =>
        requestAnimationFrame(() =>
          document.querySelector<HTMLButtonElement>("[data-testid=guided-start]")?.focus(),
        ),
      composer: {
        read: () => messageRef.current,
        write: async (text) => {
          messageRef.current = text;
          setMessage(text);
        },
      },
    });
    setController(next);
    return () => {
      next.dispose();
      dialogs.dispose();
    };
  }, [overlay]);

  return controller === null ? null : (
    <GuidedPlayground controller={controller} message={message} onMessageChange={changeMessage} />
  );
}

createRoot(document.getElementById("d8-4-guided-playground-root") as HTMLElement).render(
  <StrictMode>
    <OverlayHost>
      <Playground />
    </OverlayHost>
  </StrictMode>,
);
