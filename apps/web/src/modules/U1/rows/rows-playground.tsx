import { createRoot } from "react-dom/client";
import { AppShell } from "@/shell";
import {
  CustomMessageRow,
  FileMentionRow,
  ProviderErrorRow,
  RetryRecoveryRow,
  SessionEntryRow,
  TerminalErrorRow,
  ToolResultAttachmentRow,
} from "./index";

function RowsPlayground() {
  return (
    <AppShell
      leftSidebar={<div className="p-4 text-xs">U1.6 row fixture</div>}
      rightSidebar={<div className="p-4 text-xs">Row handoff slots</div>}
      threadHeader={<div className="text-sm font-medium">Special transcript rows</div>}
      transcript={
        <div className="h-full overflow-y-auto py-4">
          <CustomMessageRow
            customType="extension.notice"
            detail="Safe fallback body"
            content="A custom extension notice"
          />
          <FileMentionRow
            files={[
              { path: "src/app.ts", lineCount: 42 },
              { path: "assets/logo.png", image: true },
              { path: "archive.zip", skippedReason: "binary file" },
            ]}
          />
          <SessionEntryRow detail="fake-model → fast-model" kind="model-change" />
          <SessionEntryRow detail="Summary available" kind="compaction-summary" />
          <SessionEntryRow detail="Parent → feature branch" kind="branch-summary" />
          <ProviderErrorRow
            details="Provider returned a bounded diagnostic payload."
            message="Provider unavailable"
            provider="fixture-provider"
            status={503}
          />
          <RetryRecoveryRow
            attempt={2}
            delaySeconds={5}
            providerError="temporary provider failure"
            state="retrying"
            total={3}
          />
          <RetryRecoveryRow attempt={2} state="recovered" total={3} />
          <TerminalErrorRow
            message="The conversation stopped unexpectedly."
            onRetry={() => undefined}
            retryable
          />
          <ToolResultAttachmentRow
            files={[{ detail: "text/plain · 2 KB", name: "result.txt" }]}
            images={[
              {
                alt: "Tool result chart",
                src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='96'%3E%3Crect width='240' height='96' fill='lightblue'/%3E%3C/svg%3E",
              },
            ]}
            toolCallId="call-fixture"
          />
        </div>
      }
    />
  );
}

const root = document.getElementById("u1-rows-playground-root");
if (!root) throw new Error("U1.6 rows playground root is missing.");
createRoot(root).render(<RowsPlayground />);
