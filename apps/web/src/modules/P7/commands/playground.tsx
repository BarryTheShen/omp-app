import type { CommandRunResult, ThreadId } from "@omp-app/contracts";
import { SlashCommand, ThreadId as ThreadIdSchema } from "@omp-app/contracts";
import { useState } from "react";
import type { PanelState } from "@/modules/U5/panel/contract";
import { CommandReportPanel } from "./report-panel";

const threadId: ThreadId = ThreadIdSchema.parse("command-preview-thread");

const report: CommandRunResult = {
  command: SlashCommand.parse("/stats --port 3847 --host 127.0.0.1"),
  status: "completed",
  agentInvoked: false,
  promptSettled: true,
  sessionSettled: true,
  outputs: [
    {
      text: "Statistics dashboard is ready.\nOpen this address: http://127.0.0.1:3847",
    },
    {
      text: "The report includes context use, token totals, and session cost.",
    },
    {
      text: "Detailed session statistics.\n".repeat(80),
    },
  ],
  sessionUpdates: [{ sessionId: threadId, title: "Context review" }],
  configUpdates: [{ thinkingLevel: "xhigh" }],
};

const initialPanel: PanelState = {
  open: true,
  lifecycle: "populated",
  position: "right",
  title: "Command report",
  description: "Read the result of a command.",
  error: null,
  readOnly: true,
  pendingUpdates: 0,
};

export function CommandPlayground() {
  const [panelState, setPanelState] = useState(initialPanel);

  return (
    <main className="min-h-screen bg-background p-4 text-foreground sm:p-8">
      <header className="mb-5">
        <h1 className="text-xl font-semibold tracking-tight">Command result preview</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Ordered command output, safe updates, and separate response settlement states.
        </p>
      </header>
      <aside
        className="border-sidebar-border bg-sidebar min-w-0 border-s"
        data-u0-right-sidebar="true"
      >
        <CommandReportPanel
          error={null}
          loading={false}
          onOpenChange={(open) => setPanelState((current) => ({ ...current, open }))}
          panelState={panelState}
          result={report}
        />
      </aside>
    </main>
  );
}
