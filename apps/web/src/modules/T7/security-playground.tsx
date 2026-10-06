import { createRoot } from "react-dom/client";
import "../../index.css";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { SecurityScanCard } from "./security";

function props(
  toolCallId: string,
  args: Record<string, unknown>,
  result: unknown,
  status: ToolRendererProps["status"] = { type: "complete" },
): ToolRendererProps {
  return {
    type: "tool-call",
    toolCallId,
    toolName: "security_scan",
    args,
    argsText: JSON.stringify(args),
    result,
    status,
  } as unknown as ToolRendererProps;
}

function SecurityPlayground() {
  return (
    <main
      className="bg-background text-foreground min-h-screen px-4 py-8 sm:px-8"
      data-testid="t7-security-playground"
    >
      <header className="border-border bg-card mx-auto w-full max-w-3xl rounded-xl border p-4 shadow-xs">
        <h1 className="text-lg font-semibold tracking-tight">Security scan cards</h1>
        <p className="text-muted-foreground text-sm">
          Scan progress, cloud findings by severity, and finding validation
        </p>
      </header>
      <section className="border-border bg-card mx-auto mt-6 flex w-full max-w-3xl flex-col gap-5 rounded-xl border p-4 shadow-xs sm:p-6">
        <SecurityScanCard
          rendererProps={props(
            "security-findings",
            { action: "cloud_status", cloud_configuration_id: "cfg-1" },
            {
              content: [{ type: "text", text: "Codex Security cloud scan cfg-1: scanning." }],
              details: {
                action: "cloud_status",
                cloudStats: {
                  configurationId: "cfg-1",
                  currentStep: "scanning_commits",
                  pendingCommits: 3,
                  finishedCommits: 42,
                  failedCommits: 1,
                  findingCounts: { critical: 1, high: 2, medium: 5, low: 3, informational: 0 },
                },
              },
            },
          )}
        />
        <SecurityScanCard
          rendererProps={props(
            "security-clean",
            { action: "status", operation_id: "op-7" },
            {
              content: [{ type: "text", text: "Security scan scan-7: completed; 0 finding(s)." }],
              details: {
                action: "status",
                operation: {
                  operationId: "op-7",
                  planId: "plan-7",
                  scanId: "scan-7",
                  phase: "completed",
                  createdAt: "2026-10-05T10:00:00Z",
                  updatedAt: "2026-10-05T10:12:00Z",
                  findingCount: 0,
                },
              },
            },
          )}
        />
        <SecurityScanCard
          rendererProps={props(
            "security-validation",
            {
              action: "validate",
              scan_id: "scan-7",
              finding_id: "F-12",
              validation_status: "error",
              validation_summary: "The reproduction script could not run.",
            },
            {
              content: [{ type: "text", text: "Finding F-12 validation is now error." }],
              details: { action: "validate", finding: { id: "F-12", validationStatus: "error" } },
            },
          )}
        />
        <SecurityScanCard
          rendererProps={props(
            "security-running",
            {
              action: "preflight",
              target_kind: "scoped_path",
              include_paths: ["src/", "packages/server/"],
            },
            undefined,
            { type: "running" },
          )}
        />
      </section>
    </main>
  );
}

const root = document.getElementById("t7-security-playground-root");
if (!root) throw new Error("Security scan playground root is missing.");
createRoot(root).render(<SecurityPlayground />);
