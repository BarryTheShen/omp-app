import type { CapabilityMap, ThreadId, UiRequestId } from "@omp-app/contracts";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import { OverlayHost, useOverlayHost } from "@/overlay";
import type { ApprovalRequest } from "../contract";
import { renderDialogRequest } from "../dialogs";
import { DialogHostController } from "../host";
import { ApprovalPortController } from "./approval";

const capabilities: CapabilityMap = { "omp.ui": { state: "available", via: "omp" } };
const threadId = "u4-4-playground" as ThreadId;

function ApprovalPlayground() {
  const overlay = useOverlayHost();
  const hostRef = useRef<DialogHostController | null>(null);
  const approvalRef = useRef<ApprovalPortController | null>(null);
  const [lastDecision, setLastDecision] = useState("No decision yet");
  if (hostRef.current === null) {
    hostRef.current = new DialogHostController({
      overlay,
      capabilities,
      answerDialog: async () => {},
      render: renderDialogRequest,
    });
    approvalRef.current = new ApprovalPortController({ dialogHost: hostRef.current });
  }
  const host = hostRef.current;
  const approval = approvalRef.current;
  if (!approval) throw new Error("Approval controller is missing.");
  useEffect(() => () => host.dispose(), [host]);

  const openApproval = () => {
    const request: ApprovalRequest = {
      kind: "select",
      id: "u4-4-approval" as UiRequestId,
      toolCallId: "u4-4-tool-call" as never,
      toolName: "workspace.write",
      title: "Allow this tool?",
      options: ["Approve once", "Approve for this session", "Deny"],
      approveOption: "Approve once",
      details: { reason: "The tool wants to write a workspace file." },
    };
    void approval.resolve(request, { threadId }).then(
      (decision) => setLastDecision(JSON.stringify(decision)),
      (error: unknown) =>
        setLastDecision(error instanceof Error ? error.message : "Approval failed"),
    );
  };

  return (
    <main className="min-h-screen bg-background text-foreground" data-testid="u4-4-playground">
      <header className="border-border bg-card flex items-center justify-between border-b px-6 py-4">
        <div>
          <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            omp / U4
          </p>
          <h1 className="text-xl font-semibold">Approval playground</h1>
        </div>
        <p className="text-muted-foreground max-w-xs text-end text-xs" data-testid="last-decision">
          {lastDecision}
        </p>
      </header>
      <section className="mx-auto flex min-h-[70vh] w-full max-w-3xl flex-col justify-center gap-5 px-6 py-12">
        <div className="border-border bg-card rounded-xl border p-6 shadow-sm">
          <p className="text-muted-foreground text-sm">Tool approval</p>
          <p className="mt-2 text-base">
            The decision is fail-closed and is answered through one typed path.
          </p>
        </div>
        <Button id="open-approval" type="button" onClick={openApproval}>
          Review approval
        </Button>
      </section>
    </main>
  );
}

const root = document.getElementById("u4-4-playground-root");
if (!root) throw new Error("U4.4 playground root is missing.");
createRoot(root).render(
  <OverlayHost>
    <ApprovalPlayground />
  </OverlayHost>,
);
