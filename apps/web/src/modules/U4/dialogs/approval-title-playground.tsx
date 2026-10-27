import type { CapabilityMap, ThreadId, UiRequestId } from "@omp-app/contracts";
import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import { OverlayHost, useOverlayHost } from "@/overlay";
import type { DialogRequest } from "../contract";
import { DialogHostController } from "../host";
import { renderDialogRequest } from "./renderer";

const capabilities: CapabilityMap = { "omp.ui": { state: "available", via: "rpc" } };
const threadId = "approval-title" as ThreadId;

// The text omp sends as an approval's select title: the header rows, then the arguments as JSON.
const APPROVAL_TITLE = [
  "Allow tool: write",
  "Reason: the agent wants to write a file outside the workspace",
  "Arguments:",
  "{",
  '  "path": "/tmp/omp-approval-probe-2334.txt",',
  '  "content": "first line\\n  indented second line\\nthird"',
  "}",
].join("\n");

function ApprovalTitlePlayground() {
  const overlay = useOverlayHost();
  const hostRef = useRef<DialogHostController | null>(null);
  if (hostRef.current === null) {
    hostRef.current = new DialogHostController({
      overlay,
      capabilities,
      answerDialog: async () => {},
      render: renderDialogRequest,
    });
  }
  const host = hostRef.current;
  useEffect(() => () => host.dispose(), [host]);
  const open = () => {
    const request: DialogRequest = {
      kind: "select",
      id: "approval-title-select" as UiRequestId,
      title: APPROVAL_TITLE,
      options: ["Approve", "Deny"],
    };
    void host.open(request, { threadId });
  };
  return (
    <main className="min-h-screen bg-background text-foreground">
      <Button id="open-approval" onClick={open} type="button">
        Open approval
      </Button>
    </main>
  );
}

const root = document.getElementById("approval-title-root");
if (!root) throw new Error("The approval title playground root is missing.");
createRoot(root).render(
  <OverlayHost>
    <ApprovalTitlePlayground />
  </OverlayHost>,
);
