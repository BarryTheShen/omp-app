import { CapabilityStatus, type ThreadId, ThreadId as ThreadIdSchema } from "@omp-app/contracts";
import { useEffect, useMemo } from "react";
import { ConnectedModeControls, ModeController } from "./index";

const threadId: ThreadId = ThreadIdSchema.parse("d7-playground-thread");

/**
 * The reply omp gives for each command, as omp words it (omp v18.6.1 source and real omp runs). The rows show
 * omp's reply as it is; the tests check that the words around it are plain.
 */
const OMP_REPLIES: Readonly<Record<string, string>> = {
  "/computer on":
    "Computer use enabled for this session. Computer use: enabled · prelude: active · configured: display=active, maxWidth=3840, maxHeight=2400",
  "/computer off": "Computer use disabled for this session.",
  "/extended-context on": "Extended context enabled.",
  "/extended-context off": "Extended context disabled.",
  "/slow on": "Slow mode on: requests use the flex tier (lower cost, higher latency).",
  "/slow off": "Slow mode off.",
  "/browser visible": "Browser mode: visible",
  "/browser headless": "Browser mode: headless",
};

function createController(): ModeController {
  // `?fast=fails` makes every Fast mode change fail, so the error path can be captured.
  const failFast = new URLSearchParams(window.location.search).get("fast") === "fails";
  // `?commands=fails` makes every execution-mode command fail; `?commands=fails-after-first` accepts the first
  // one, so a failed change after an accepted one can be captured.
  const commands = new URLSearchParams(window.location.search).get("commands");
  let answered = 0;
  const capabilities = {
    "host.command-gateway": CapabilityStatus.parse({ state: "available", via: "host" }),
    "omp.cmd.get_state": CapabilityStatus.parse({ state: "available", via: "rpc" }),
    "omp.cmd.set_fast_mode": CapabilityStatus.parse({ state: "available", via: "rpc" }),
  };
  return new ModeController({
    threadId,
    capabilities,
    gateway: {
      run: async ({ command }) => {
        if (commands === "fails" || (commands === "fails-after-first" && answered > 0)) {
          throw new Error("omp did not answer the execution-mode command.");
        }
        answered += 1;
        const reply = OMP_REPLIES[command] ?? "";
        return {
          command,
          status: "completed",
          agentInvoked: false,
          promptSettled: true,
          sessionSettled: true,
          outputs: reply === "" ? [] : [{ text: reply }],
          sessionUpdates: [],
          configUpdates: [],
        };
      },
    },
    fastRpc: {
      getState: async () => ({
        sessionId: threadId,
        fastModeEnabled: false,
        fastModeActive: false,
      }),
      setFastMode: async ({ enabled }) => {
        if (failFast) throw new Error("omp did not answer the Fast mode change.");
        return { enabled, active: enabled };
      },
    },
  });
}

export function D7ModesPlayground() {
  const controller = useMemo(createController, []);
  useEffect(() => () => controller.dispose(), [controller]);
  return (
    <main className="min-h-screen bg-background p-4 text-foreground sm:p-8">
      <div className="mx-auto max-w-4xl" data-testid="d7-3-modes-playground">
        <ConnectedModeControls controller={controller} />
      </div>
    </main>
  );
}
