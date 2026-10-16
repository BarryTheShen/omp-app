// The P5 decorator reports below are the contract's shapes (contract.ts:61-68). P5 is not mounted and omp reports no
// workspace fields, so these are inputs this test writes, not omp output.

import type { ThreadId } from "@omp-app/contracts";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { EditRunDecorator, EditRunResult } from "../contract";
import { BRANCHED_CHAT, USER_WITH_IMAGE } from "../fixtures/omp-branch";
import type { P3RunState, P3SentState } from "../runs/status";
import { P3RunStatusView } from "../runs/view";
import { editAppend, renderRun } from "./run-harness";

afterEach(cleanup);

/** The sent state of a finished edit; a run in another phase fails the test here. */
function sentOf(state: P3RunState): P3SentState {
  if (state.phase !== "sent") throw new Error(`expected a sent run, got ${state.phase}`);
  return state;
}

/** The status the person sees after an edit, drawn in the new chat the edit opened. */
function showSent(state: P3SentState) {
  return render(
    <P3RunStatusView
      canRetry={false}
      onDismiss={() => undefined}
      onOpenSource={() => undefined}
      onRetry={() => undefined}
      openError={null}
      showOpenSource
      state={state}
    />,
  );
}

async function editImageMessage(decorator?: EditRunDecorator): Promise<P3SentState> {
  const run = renderRun(decorator === undefined ? {} : { decorator });
  await act(async () => {
    await run.handlers.onEdit(editAppend(String(USER_WITH_IMAGE), "Explain again"));
  });
  return sentOf(run.runs.status.getSnapshot());
}

/** A boundary restore: the files went back to the last checkpoint, one file did not, and one changed outside omp. */
function partialRestore(threadId: ThreadId): EditRunResult {
  return {
    threadId,
    admitted: true,
    settled: false,
    workspaceGuarantee: "boundary",
    externalChanges: ["example.txt"],
    partialFailure: "example.txt could not be restored",
  };
}

describe("acceptance (CC9): the conversation branch and the workspace restore are told apart", () => {
  test("a boundary restore is said, with the file that changed outside omp and the one that could not be restored", async () => {
    const state = await editImageMessage(async (request, edit) => {
      await edit(request);
      return partialRestore(BRANCHED_CHAT);
    });

    showSent(state);

    expect(state).toMatchObject({
      workspaceGuarantee: "boundary",
      externalChanges: ["example.txt"],
    });
    expect(screen.getByText(/Workspace files were restored to the last checkpoint\./)).toBeTruthy();
    expect(
      screen.getByText(
        "Some workspace files could not be restored: example.txt could not be restored",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Changed outside omp: example.txt")).toBeTruthy();
  });

  test("an exact restore is said as an exact restore to the state before the message", async () => {
    const state = await editImageMessage(async (request, edit) => {
      await edit(request);
      return {
        threadId: BRANCHED_CHAT,
        admitted: true,
        settled: false,
        workspaceGuarantee: "exact",
        externalChanges: [],
      };
    });

    showSent(state);

    expect(state.workspaceGuarantee).toBe("exact");
    expect(
      screen.getByText(/Workspace files were restored to the state before this message\./),
    ).toBeTruthy();
  });

  test("an undecorated edit says it branched and says nothing about files (issue 1379)", async () => {
    const state = await editImageMessage();

    showSent(state);

    expect(state.workspaceGuarantee).toBe("not-managed");
    expect(screen.getByText("Sent in this new chat, branched from the original.")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/file|restored|checkpoint|workspace/i);
  });

  test("a boundary restore with nothing left over reports no partial failure and no external change", async () => {
    const state = await editImageMessage(async (request, edit) => {
      await edit(request);
      return {
        threadId: request.source.threadId,
        admitted: true,
        settled: false,
        workspaceGuarantee: "boundary",
        externalChanges: [],
      };
    });

    expect(state).toMatchObject({
      partialFailure: null,
      workspaceGuarantee: "boundary",
      externalChanges: [],
    });
  });
});
