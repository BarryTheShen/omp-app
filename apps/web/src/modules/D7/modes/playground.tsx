import {
  CapabilityStatus,
  type ModeChangeRequest,
  type ModeChangeResult,
  type ThreadId,
  ThreadId as ThreadIdSchema,
} from "@omp-app/contracts";
import { useEffect, useMemo } from "react";
import type { GetStateResult, ModeRpc } from "../contract";
import { ConnectedModeControls, ModeController } from "./index";

const threadId: ThreadId = ThreadIdSchema.parse("d7-playground-thread");

/**
 * The typed outcome the server gives each command-gateway change on the fake model: the toggles and the browser
 * window. Slow mode is not among them: the dialog changes it over RPC.
 */
function outcomeFor(request: ModeChangeRequest): ModeChangeResult {
  if (request.mode === "browser") {
    return { outcome: "applied", mode: "browser", visibility: request.visibility };
  }
  return { outcome: "applied", mode: request.mode, on: request.requested };
}

/**
 * omp's get_state for Slow mode, per `?slow=` fixture: not offered (the default, as on the fake model), on, or on
 * with a usage-limit stage (`wrap-up` or `low-priority`), for the screenshots of those states.
 */
function slowFixture(
  value: string | null,
): Pick<GetStateResult, "slowModeSupported" | "slowModeEnabled" | "slowModeScope" | "usageLimit"> {
  const resetsAtSec = Math.floor(Date.now() / 1000) + 2 * 60 * 60;
  switch (value) {
    case "on":
      return { slowModeSupported: true, slowModeEnabled: true, slowModeScope: "global" };
    case "wrap-up":
      return {
        slowModeSupported: true,
        slowModeEnabled: true,
        slowModeScope: "global",
        usageLimit: { stage: "wrap_up", extraUsage: false, resetsAtSec },
      };
    case "low-priority":
      return {
        slowModeSupported: true,
        slowModeEnabled: true,
        slowModeScope: "global",
        usageLimit: { stage: "low_priority", resetsAtSec, allowanceLeftPercent: 62 },
      };
    default:
      return { slowModeSupported: false, slowModeEnabled: false };
  }
}

function createController(): ModeController {
  const params = new URLSearchParams(window.location.search);
  // `?fast=fails` makes every Fast mode change fail, so the error path can be captured.
  const failFast = params.get("fast") === "fails";
  // `?commands=fails` makes every execution-mode command fail; `?commands=fails-after-first` accepts the first
  // one, so a failed change after an accepted one can be captured.
  const commands = params.get("commands");
  // `?slow=` picks Slow mode's fixture (see `slowFixture`).
  const slow = params.get("slow");
  let answered = 0;
  const capabilities = {
    "host.command-gateway": CapabilityStatus.parse({ state: "available", via: "host" }),
    "omp.cmd.get_state": CapabilityStatus.parse({ state: "available", via: "rpc" }),
    "omp.cmd.set_fast_mode": CapabilityStatus.parse({ state: "available", via: "rpc" }),
    "omp.cmd.set_slow_mode": CapabilityStatus.parse({ state: "available", via: "rpc" }),
  };
  const rpc: ModeRpc = {
    getState: async () => ({
      sessionId: threadId,
      fastModeEnabled: false,
      fastModeActive: false,
      ...slowFixture(slow),
    }),
    setFastMode: async ({ enabled }) => {
      if (failFast) throw new Error("omp did not answer the Fast mode change.");
      return { enabled, active: enabled };
    },
    setSlowMode: async ({ enabled }) => ({ enabled }),
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
    rpc,
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
