// The fixture rows retain their recorded ids and text; this test accepts every row returned by that recording.
import { EntryId as EntryIdSchema, type ThreadId } from "@omp-app/contracts";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { BranchMessageSelectorPort } from "../contract";
import { P3EditComposerHandoff, type P3EditSelection } from "../edit";
import { BRANCH_MESSAGES, SOURCE_CHAT, USER_TEXT_ONLY } from "../fixtures/omp-branch";
import { captureP3EditSource } from "../runs/source";
import {
  type P3PreviousMessageDialogHost,
  useP3PreviousMessageSelectorController,
} from "../selector/controller";
import { sourceStore } from "./run-harness";

afterEach(cleanup);

describe("acceptance: a row from get_branch_messages opens the edit composer on its own message", () => {
  test("the chosen row keeps its entry id through the list, the dialog and the composer, and Cancel restores focus and calls the cancel hook", async () => {
    const store = sourceStore();
    const listed: ThreadId[] = [];
    const branchMessages: BranchMessageSelectorPort = {
      list: async (threadId) => {
        listed.push(threadId);
        return BRANCH_MESSAGES.messages.map((row) => ({
          entryId: EntryIdSchema.parse(row.entryId),
          text: row.text,
        }));
      },
    };
    let labelsShown: readonly string[] = [];
    const dialogs: P3PreviousMessageDialogHost = {
      open: async (request) => {
        labelsShown = request.options;
        // The older message is the second row: the answer names its label, so the entry id must come from the row.
        return {
          outcome: "answered",
          response: { kind: "select", value: request.options[1] ?? "" },
        };
      },
    };
    const selected: P3EditSelection[] = [];
    const { result } = renderHook(() =>
      useP3PreviousMessageSelectorController({
        threadId: SOURCE_CHAT,
        available: true,
        branchMessages,
        dialogs,
        // The recording's branch response leaves no abandoned row to filter; accept every recorded row here.
        onCurrentBranch: () => true,
        resolveSource: async (message) => captureP3EditSource(store, message.entryId),
        onSelect: (selection) => {
          selected.push(selection);
        },
      }),
    );
    const trigger = document.createElement("button");
    document.body.append(trigger);

    await act(async () => {
      await result.current.actions.onOpen(trigger);
    });

    expect(listed).toEqual([SOURCE_CHAT]);
    // The controller offers the rows the predicate accepts.
    expect(labelsShown).toEqual(["Explain", "Earlier question"]);
    const selection = selected[0];
    if (selection === undefined) throw new Error("the selector made no selection");
    expect(selected).toHaveLength(1);
    expect(selection.message.entryId).toBe(USER_TEXT_ONLY);
    expect(selection.editSource.entryId).toBe(USER_TEXT_ONLY);
    expect(selection.composerSource.sourceMessageId).toBe(String(USER_TEXT_ONLY));

    let cancelled = 0;
    const restoreFocus = (): void => {
      if (trigger.isConnected) trigger.focus();
    };
    render(
      <P3EditComposerHandoff
        onCancel={() => {
          cancelled += 1;
        }}
        onSubmitReplacement={() => undefined}
        restoreFocus={restoreFocus}
        selection={selection}
      />,
    );
    expect(screen.getByRole("textbox", { name: "Edit message" })).toHaveProperty(
      "value",
      "Earlier question",
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel edit" }));

    expect(cancelled).toBe(1);
    expect(document.activeElement).toBe(trigger);
    // Restoring the composer's draft text is U2.7's (EditComposerHooks.cancel); this test does not claim it.
    trigger.remove();
  });
});
