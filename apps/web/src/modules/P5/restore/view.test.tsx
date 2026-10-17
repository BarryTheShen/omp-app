import {
  AppError,
  type CapabilityMap,
  FolderPath,
  RestorePlan,
  RestorePlanId,
  RestoreResult,
  type RestoreResult as RestoreResultType,
  SnapshotId,
  ThreadId,
} from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ConfirmDialogRequest } from "../../U4/contract/dialog";
import type { DialogHost } from "../../U4/contract/dialog-host";
import { toRestorePlanView, toWorkspaceRestoreResultView } from "../contract";
import { DiffPanel } from "../diff";
import { RestoreView } from "./view";

afterEach(cleanup);

const workspace = FolderPath.parse("/workspace");
const conversation = { threadId: ThreadId.parse("p5-thread"), sessionFile: null, entryId: null };
function plan(snapshotGuarantee: "boundary" | "exact" = "boundary") {
  return toRestorePlanView(
    RestorePlan.parse({
      planId: "restore-plan-1",
      workspace,
      operation: "both",
      snapshotId: SnapshotId.parse("snapshot-1"),
      currentConversation: conversation,
      targetConversation: conversation,
      currentWorkspaceHash: "current",
      targetWorkspaceHash: "target",
      includedPaths: [{ path: "src/app.ts", kind: "file" }],
      excludedPaths: [{ path: ".git", reason: "Protected repository metadata" }],
      externalChanges: [
        { path: "README.md", change: "mode-changed", expectedHash: "before", actualHash: "after" },
      ],
      capturedPathCount: 1,
      snapshotGuarantee,
      destructive: true,
      requiresConfirmation: true,
    }),
  );
}
function dialogHost(confirm: DialogHost["confirm"]): Pick<DialogHost, "confirm"> {
  return { confirm };
}
function result(patch: Partial<RestoreResultType> = {}) {
  return toWorkspaceRestoreResultView(
    RestoreResult.parse({
      planId: "restore-plan-1",
      operation: "both",
      filesRestored: true,
      conversationRestored: true,
      capturedPathCount: 1,
      excludedPaths: [],
      snapshotGuarantee: "boundary",
      externalChanges: [],
      partialFailure: null,
      previousConversation: conversation,
      currentConversation: conversation,
      undoSnapshotId: "snapshot-undo",
      redoAvailable: true,
      ...patch,
    }),
  );
}

describe("P5 restore and diff views", () => {
  test("renders diff loading, empty and recoverable error states", () => {
    const common = { open: true, onOpenChange: vi.fn() };
    const { rerender } = render(<DiffPanel {...common} diff={null} loadState="loading" />);
    expect(screen.getByRole("status").textContent).toContain("Loading");
    rerender(<DiffPanel {...common} diff={null} loadState="empty" />);
    expect(screen.getByText("No file changes were found.")).toBeTruthy();
    rerender(
      <DiffPanel
        {...common}
        diff={null}
        loadState="error"
        error={AppError.parse({ code: "internal", message: "Disk busy", retryable: true })}
        onRetry={() => undefined}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("Disk busy");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  test("shows the restore plan, then honors a declined confirmation", async () => {
    const onRestore = vi.fn();
    const confirm = vi.fn(async () => false);
    render(
      <RestoreView
        plan={plan()}
        dialogHost={dialogHost(confirm)}
        threadId={conversation.threadId}
        onRestore={onRestore}
      />,
    );
    expect(screen.getByText("1 path is included.")).toBeTruthy();
    expect(screen.getByText(/Restore point captured/)).toBeTruthy();
    expect(screen.getByText(/excluded and will not be restored/)).toBeTruthy();
    expect(screen.getByText(".git — Protected repository metadata")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review and restore" }));
    await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    expect(onRestore).not.toHaveBeenCalled();
  });
  test("confirmation uses an operation title and names each restore guarantee", async () => {
    const scenarios: ReadonlyArray<{
      guarantee: ReturnType<typeof plan>["workspaceGuarantee"];
      expected: string;
      capabilities?: CapabilityMap;
    }> = [
      {
        guarantee: "exact",
        expected: "The restore point is exact.",
        capabilities: {
          "upstream.tool-preflight": { state: "available", via: "upstream" },
        },
      },
      {
        guarantee: "boundary",
        expected:
          "The restore point was captured at a quiet boundary; later tool changes may remain.",
      },
      { guarantee: "not-managed", expected: "The restore point has no managed guarantee." },
    ];
    for (const scenario of scenarios) {
      const confirm = vi.fn(async (_request: ConfirmDialogRequest) => false);
      const restorePlan =
        scenario.guarantee === "not-managed"
          ? { ...plan(), workspaceGuarantee: scenario.guarantee }
          : plan(scenario.guarantee);
      const { unmount } = render(
        <RestoreView
          plan={restorePlan}
          capabilities={scenario.capabilities}
          dialogHost={dialogHost(confirm)}
          threadId={conversation.threadId}
          onRestore={() => undefined}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Review and restore" }));
      await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
      const request = confirm.mock.calls[0]?.[0];
      expect(request?.title).toBe("Confirm Restore files and conversation");
      expect(request?.message).toContain(scenario.expected);
      expect(request?.message).toContain("1 external change is listed and may be overwritten.");
      expect(request?.message).toContain("1 path is excluded from restore.");
      unmount();
    }
  });

  test("exact restore plans are hidden when the upstream support is missing", () => {
    render(
      <RestoreView
        plan={plan("exact")}
        dialogHost={dialogHost(vi.fn(async () => false))}
        threadId={conversation.threadId}
        onRestore={() => undefined}
      />,
    );
    expect(screen.getByRole("alert").textContent).toBe(
      "This exact restore point isn't available here. Choose another restore point.",
    );
    expect(screen.queryByText("Exact restore point.")).toBeNull();
  });

  test("renders every external-change sentence and the excluded-path line", () => {
    const base = plan();
    const externalChanges = (
      [
        { path: "added.txt", change: "added" },
        { path: "deleted.txt", change: "deleted" },
        { path: "modified.txt", change: "modified" },
        { path: "permissions.txt", change: "mode-changed" },
      ] as const
    ).map((change) => ({
      ...change,
      expectedHash: "before",
      actualHash: "after",
    }));
    render(
      <RestoreView
        plan={{ ...base, externalChanges }}
        dialogHost={dialogHost(vi.fn(async () => false))}
        threadId={conversation.threadId}
        onRestore={() => undefined}
      />,
    );
    expect(screen.getByText("added.txt — added")).toBeTruthy();
    expect(screen.getByText("deleted.txt — deleted")).toBeTruthy();
    expect(screen.getByText("modified.txt — modified")).toBeTruthy();
    expect(screen.getByText("permissions.txt — permissions changed")).toBeTruthy();
    expect(screen.getByText(".git — Protected repository metadata")).toBeTruthy();
  });

  test("does not restore if the confirmation promise rejects", async () => {
    const onRestore = vi.fn();
    const confirm = vi.fn(async () => {
      throw new Error("dialog unavailable");
    });
    render(
      <RestoreView
        plan={plan()}
        dialogHost={dialogHost(confirm)}
        threadId={conversation.threadId}
        onRestore={onRestore}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Review and restore" }));
    expect(
      await screen.findByText(
        "The restore could not be completed. Choose the restore point again before trying again.",
      ),
    ).toBeTruthy();
    expect(onRestore).not.toHaveBeenCalled();
  });

  test("reports a failed restore and prevents concurrent confirmations", async () => {
    const gate = Promise.withResolvers<boolean>();
    const confirm = vi.fn(() => gate.promise);
    const onRestore = vi.fn(async () => {
      throw new Error("restore failed");
    });
    render(
      <RestoreView
        plan={plan()}
        dialogHost={dialogHost(confirm)}
        threadId={conversation.threadId}
        onRestore={onRestore}
      />,
    );
    const button = screen.getByRole("button", { name: "Review and restore" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(confirm).toHaveBeenCalledOnce();
    gate.resolve(true);
    expect(
      await screen.findByText(
        "The restore could not be completed. Choose the restore point again before trying again.",
      ),
    ).toBeTruthy();
  });

  test("shows complete only when an operation restored an axis and shows partial failure otherwise", () => {
    const confirm = vi.fn(async () => true);
    const completed = result();
    const { rerender } = render(
      <RestoreView
        plan={plan()}
        result={completed}
        dialogHost={dialogHost(confirm)}
        threadId={conversation.threadId}
        onRestore={() => undefined}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe("Restore complete.");
    const completeButton = screen.getByRole("button", {
      name: "Restore complete",
    }) as HTMLButtonElement;
    expect(completeButton.disabled).toBe(true);
    fireEvent.click(completeButton);
    expect(confirm).not.toHaveBeenCalled();

    const nextPlan = { ...plan(), planId: RestorePlanId.parse("restore-plan-2") };
    rerender(
      <RestoreView
        plan={nextPlan}
        result={completed}
        dialogHost={dialogHost(confirm)}
        threadId={conversation.threadId}
        onRestore={() => undefined}
      />,
    );
    expect(
      (screen.getByRole("button", { name: "Review and restore" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(screen.queryByText("Restore complete.")).toBeNull();
    expect(screen.queryByText("No files or conversation were restored.")).toBeNull();
    const partial = result({
      filesRestored: false,
      conversationRestored: false,
      partialFailure: {
        stage: "files",
        message: "File restore failed",
        rollbackAttempted: true,
        rollbackSucceeded: true,
      },
    });
    rerender(
      <RestoreView
        plan={plan()}
        result={partial}
        dialogHost={dialogHost(confirm)}
        threadId={conversation.threadId}
        onRestore={() => undefined}
      />,
    );
    expect(screen.getByText("File restore failed")).toBeTruthy();
    expect(screen.queryByText("Restore complete.")).toBeNull();
    const empty = result({ filesRestored: false, conversationRestored: false });
    rerender(
      <RestoreView
        plan={plan()}
        result={empty}
        dialogHost={dialogHost(confirm)}
        threadId={conversation.threadId}
        onRestore={() => undefined}
      />,
    );
    expect(screen.getByText("No files or conversation were restored.")).toBeTruthy();
  });
});
