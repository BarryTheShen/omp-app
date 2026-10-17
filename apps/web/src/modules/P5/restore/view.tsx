import type { CapabilityMap, ThreadId } from "@omp-app/contracts";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ConfirmDialogRequest } from "../../U4/contract/dialog";
import type { DialogHost } from "../../U4/contract/dialog-host";
import type { RestoreOperation, RestorePlanView, WorkspaceRestoreResultView } from "../contract";
import { createRestorePlanViewModel } from "./model";

export type RestoreViewProps = {
  readonly plan: RestorePlanView | null;
  readonly result?: WorkspaceRestoreResultView | null;
  readonly capabilities?: CapabilityMap;
  readonly dialogHost: Pick<DialogHost, "confirm">;
  readonly threadId: ThreadId;
  readonly onRestore: () => void | Promise<void>;
};

const OPERATION_LABELS: Readonly<Record<RestoreOperation, string>> = {
  "files-only": "Restore files only",
  "conversation-only": "Rewind conversation only",
  both: "Restore files and conversation",
  redo: "Redo restore",
  "edit-resend": "Restore before editing and resend",
};

export function RestoreView({
  plan,
  result,
  capabilities = {},
  dialogHost,
  threadId,
  onRestore,
}: RestoreViewProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const requestNumber = useRef(0);
  if (!plan) return <p role="status">Choose a restore point to see a plan.</p>;
  let viewModel: ReturnType<typeof createRestorePlanViewModel>;
  try {
    viewModel = createRestorePlanViewModel(plan, capabilities);
  } catch {
    return (
      <p role="alert">
        This exact restore point isn't available here. Choose another restore point.
      </p>
    );
  }
  const confirmation = (): ConfirmDialogRequest => ({
    kind: "confirm",
    id: `app-p5-restore-${plan.planId}-${++requestNumber.current}` as ConfirmDialogRequest["id"],
    title: `Confirm ${OPERATION_LABELS[plan.operation]}`,
    message: confirmationMessage(plan),
  });
  const restore = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const confirmed = await dialogHost.confirm(confirmation(), { threadId, origin: "app" });
      if (confirmed) await onRestore();
    } catch {
      setError(
        "The restore could not be completed. Choose the restore point again before trying again.",
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const currentResult = result?.planId === plan.planId ? result : null;
  const complete =
    currentResult !== null &&
    !currentResult.partialFailure &&
    (currentResult.filesRestored || currentResult.conversationRestored);
  return (
    <section aria-label="Restore plan" className="flex flex-col gap-3 p-4">
      <h2 className="font-medium">{OPERATION_LABELS[plan.operation]}</h2>
      <p className="text-muted-foreground text-sm">
        {viewModel.guarantee === "exact"
          ? "Exact restore point."
          : viewModel.guarantee === "boundary"
            ? "Restore point captured at a quiet boundary; changes after that point may remain."
            : "This restore point is not managed by the app."}
      </p>
      <p className="text-muted-foreground text-sm">
        {plan.capturedPathCount} {plan.capturedPathCount === 1 ? "path is" : "paths are"} included.
      </p>
      {plan.includedPaths.map((item) => (
        <p key={item.path}>{item.path}</p>
      ))}
      {plan.externalChanges.length > 0 ? (
        <div role="alert">
          <p>External changes will be overwritten:</p>
          {plan.externalChanges.map((change) => (
            <p key={change.path}>
              {change.path} —{" "}
              {change.change === "added"
                ? "added"
                : change.change === "deleted"
                  ? "deleted"
                  : change.change === "modified"
                    ? "modified"
                    : "permissions changed"}
            </p>
          ))}
        </div>
      ) : null}
      {plan.excludedPaths.length > 0 ? (
        <div>
          <p>These paths are excluded and will not be restored:</p>
          {plan.excludedPaths.map((item) => (
            <p key={item.path}>
              {item.path} — {item.reason}
            </p>
          ))}
        </div>
      ) : null}
      <Button
        type="button"
        variant="destructive"
        disabled={busy || complete}
        onClick={() => void restore()}
      >
        {complete ? "Restore complete" : busy ? "Restoring…" : "Review and restore"}
      </Button>
      {error ? <p role="alert">{error}</p> : null}
      {currentResult?.partialFailure ? (
        <p role="alert">{currentResult.partialFailure.message}</p>
      ) : null}
      {complete ? <p role="status">Restore complete.</p> : null}
      {currentResult && !complete && !currentResult.partialFailure ? (
        <p role="alert">No files or conversation were restored.</p>
      ) : null}
      {currentResult?.externalChanges.map((change) => (
        <p key={change.path}>Changed since restore: {change.path}</p>
      ))}
    </section>
  );
}

function confirmationMessage(plan: RestorePlanView): string {
  const guarantee =
    plan.workspaceGuarantee === "exact"
      ? "The restore point is exact."
      : plan.workspaceGuarantee === "boundary"
        ? "The restore point was captured at a quiet boundary; later tool changes may remain."
        : "The restore point has no managed guarantee.";
  const external =
    plan.externalChanges.length > 0
      ? ` ${plan.externalChanges.length} external ${plan.externalChanges.length === 1 ? "change is" : "changes are"} listed and may be overwritten.`
      : "";
  const excluded =
    plan.excludedPaths.length > 0
      ? ` ${plan.excludedPaths.length} ${plan.excludedPaths.length === 1 ? "path is" : "paths are"} excluded from restore.`
      : "";
  return `${OPERATION_LABELS[plan.operation]}. ${guarantee}${external}${excluded}`;
}
