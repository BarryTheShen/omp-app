import {
  CapabilityStatus,
  type ModeChangeRequest,
  type ModeChangeResult,
  type ThreadId,
  ThreadId as ThreadIdSchema,
} from "@omp-app/contracts";
import { useEffect, useMemo } from "react";
import { ConnectedModeControls, ModeController } from "./index";

const threadId: ThreadId = ThreadIdSchema.parse("d7-playground-thread");

/**
 * The typed outcome the server gives each mode change on the fake model: the toggles and the browser window
 * change, and slow mode is not offered (the fake model has no slow mode).
 */
function outcomeFor(request: ModeChangeRequest): ModeChangeResult {
  if (request.mode === "browser") {
    return { outcome: "applied", mode: "browser", visibility: request.visibility };
  }
  if (request.mode === "slow") {
    return { outcome: "unsupported", mode: "slow", reason: "model-has-no-slow-mode" };
  }
  return { outcome: "applied", mode: request.mode, on: request.requested };
}

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
      change: async ({ request }) => {
        if (commands === "fails" || (commands === "fails-after-first" && answered > 0)) {
          throw new Error("omp did not answer the execution-mode command.");
        }
        answered += 1;
        return outcomeFor(request);
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
