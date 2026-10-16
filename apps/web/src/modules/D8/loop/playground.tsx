import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { LoopControls, type LoopRunState } from "./view";

function LoopPlayground() {
  const [run, setRun] = useState<LoopRunState>("idle");
  return (
    <main className="min-h-screen bg-background p-4 text-foreground" data-testid="loop-playground">
      <LoopControls
        gate={{ state: "available" }}
        onPause={() => setRun("paused")}
        onResume={() => setRun("running")}
        onStart={() => setRun("running")}
        onStop={() => setRun("idle")}
        run={run}
      />
    </main>
  );
}

createRoot(document.getElementById("loop-playground-root") as HTMLElement).render(
  <StrictMode>
    <LoopPlayground />
  </StrictMode>,
);
