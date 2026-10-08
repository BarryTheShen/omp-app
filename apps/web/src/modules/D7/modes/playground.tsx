import { CapabilityStatus, type ThreadId, ThreadId as ThreadIdSchema } from "@omp-app/contracts";
import { useEffect, useMemo } from "react";
import { ConnectedModeControls, ModeController } from "./index";

const threadId: ThreadId = ThreadIdSchema.parse("d7-playground-thread");

function createController(): ModeController {
  const capabilities = {
    "host.command-gateway": CapabilityStatus.parse({ state: "available", via: "host" }),
    "omp.cmd.get_state": CapabilityStatus.parse({ state: "available", via: "rpc" }),
    "omp.cmd.set_fast_mode": CapabilityStatus.parse({ state: "available", via: "rpc" }),
  };
  return new ModeController({
    threadId,
    capabilities,
    gateway: {
      run: async ({ command }) => ({
        command,
        status: "completed",
        agentInvoked: false,
        promptSettled: true,
        sessionSettled: true,
        outputs: [],
        sessionUpdates: [],
        configUpdates: [],
      }),
    },
    fastRpc: {
      getState: async () => ({
        sessionId: threadId,
        fastModeEnabled: false,
        fastModeActive: false,
      }),
      setFastMode: async ({ enabled }) => ({ enabled, active: enabled }),
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
