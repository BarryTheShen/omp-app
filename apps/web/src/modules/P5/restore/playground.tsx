import { FolderPath, RestorePlan, RestoreResult, SnapshotId, ThreadId } from "@omp-app/contracts";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ConfirmDialogRequest } from "../../U4/contract/dialog";
import type { DialogHost } from "../../U4/contract/dialog-host";
import type { DialogResponse } from "../../U4/contract/responses";
import { ConfirmDialog } from "../../U4/dialogs/confirm";
import type { DialogRenderContext } from "../../U4/host/dialog-host";
import {
  toRestorePlanView,
  toWorkspaceRestoreResultView,
  type WorkspaceRestoreResultView,
} from "../contract";
import { RestoreView } from "./view";

const workspace = FolderPath.parse("/workspace");
const threadId = ThreadId.parse("p5-playground");
const conversation = { threadId, sessionFile: null, entryId: null };
const plan = toRestorePlanView(
  RestorePlan.parse({
    planId: "p5-playground-plan",
    workspace,
    operation: "both",
    snapshotId: SnapshotId.parse("p5-playground-snapshot"),
    currentConversation: conversation,
    targetConversation: conversation,
    currentWorkspaceHash: "current-hash",
    targetWorkspaceHash: "snapshot-hash",
    includedPaths: [{ path: "src/app.ts", kind: "file" }],
    excludedPaths: [{ path: ".git", reason: "Protected repository metadata" }],
    externalChanges: [
      {
        path: "README.md",
        change: "mode-changed",
        expectedHash: "old-hash",
        actualHash: "new-hash",
      },
    ],
    capturedPathCount: 1,
    snapshotGuarantee: "boundary",
    destructive: true,
    requiresConfirmation: true,
  }),
);

function RestorePlayground() {
  const [confirmation, setConfirmation] = useState<{
    readonly request: ConfirmDialogRequest;
    readonly resolve: (confirmed: boolean) => void;
  } | null>(null);
  const [result, setResult] = useState<WorkspaceRestoreResultView | null>(null);
  const host: Pick<DialogHost, "confirm"> = {
    confirm: (request) => new Promise<boolean>((resolve) => setConfirmation({ request, resolve })),
  };
  const onRestore = async () => {
    setResult(
      toWorkspaceRestoreResultView(
        RestoreResult.parse({
          planId: plan.planId,
          operation: plan.operation,
          filesRestored: true,
          conversationRestored: true,
          capturedPathCount: plan.capturedPathCount,
          excludedPaths: plan.excludedPaths.map((path) => path.path),
          snapshotGuarantee: plan.snapshotGuarantee,
          externalChanges: plan.externalChanges,
          partialFailure: null,
          previousConversation: conversation,
          currentConversation: conversation,
          undoSnapshotId: SnapshotId.parse("p5-undo-snapshot"),
          redoAvailable: true,
        }),
      ),
    );
  };
  const context: DialogRenderContext | null = confirmation
    ? {
        request: confirmation.request,
        threadId,
        signal: new AbortController().signal,
        answer: async (response: DialogResponse) => {
          if (response.kind === "confirm") confirmation.resolve(response.confirmed);
          setConfirmation(null);
        },
        cancel: async () => {
          confirmation.resolve(false);
          setConfirmation(null);
        },
        keepDraft: () => undefined,
      }
    : null;
  return (
    <main
      className="bg-background text-foreground min-h-screen p-4"
      data-testid="p5-restore-playground"
    >
      <div className="mx-auto max-w-2xl rounded-xl border bg-card text-card-foreground shadow-sm">
        <RestoreView
          plan={plan}
          result={result}
          dialogHost={host}
          threadId={threadId}
          onRestore={onRestore}
        />
      </div>
      {confirmation && context ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
          <div
            role="dialog"
            aria-modal="true"
            className="bg-popover text-popover-foreground w-full max-w-md rounded-xl border p-5 shadow-xl"
          >
            <ConfirmDialog request={confirmation.request} context={context} />
          </div>
        </div>
      ) : null}
    </main>
  );
}

createRoot(document.getElementById("p5-restore-root") as HTMLElement).render(<RestorePlayground />);
