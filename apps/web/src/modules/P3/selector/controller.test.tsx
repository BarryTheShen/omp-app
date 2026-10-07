import {
  AppFailure,
  EntryId as EntryIdSchema,
  ThreadId as ThreadIdSchema,
} from "@omp-app/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderDialogRequest } from "@/modules/U4/dialogs/renderer";
import { DialogHostController } from "@/modules/U4/host";
import { OverlayHost, useStableOverlayHost } from "@/overlay";
import type { BranchMessage, BranchMessageSelectorPort } from "../contract";
import type { P3EditSelection, P3EditSource } from "../edit";
import type { P3PreviousMessageSelectorOptions } from "./controller";
import { useP3PreviousMessageSelectorController } from "./controller";
import { PreviousMessageSelectorView } from "./view";

afterEach(cleanup);

const TRIGGER = "Edit an earlier message";

type SelectorHarnessProps = Omit<
  P3PreviousMessageSelectorOptions,
  "dialogs" | "available" | "onCurrentBranch"
> &
  Partial<Pick<P3PreviousMessageSelectorOptions, "available" | "onCurrentBranch">>;

function SelectorHarness({
  available = true,
  onCurrentBranch = () => true,
  ...options
}: SelectorHarnessProps) {
  const overlay = useStableOverlayHost();
  const hostRef = useRef<DialogHostController | null>(null);
  if (hostRef.current === null) {
    hostRef.current = new DialogHostController({
      overlay,
      answerExtensionUi: async () => undefined,
      render: renderDialogRequest,
    });
  }
  const dialogs = hostRef.current;
  useEffect(() => () => dialogs.dispose(), [dialogs]);

  const controller = useP3PreviousMessageSelectorController({
    ...options,
    available,
    onCurrentBranch,
    dialogs,
  });
  return <PreviousMessageSelectorView {...controller} />;
}

function renderSelector(options: SelectorHarnessProps) {
  return render(
    <OverlayHost>
      <SelectorHarness {...options} />
    </OverlayHost>,
  );
}

function messageFor(entry: string, text: string): BranchMessage {
  return { entryId: EntryIdSchema.parse(entry), text };
}

function selectionFor(threadId: string, entryId: string, text: string): P3EditSelection {
  const typedThreadId = ThreadIdSchema.parse(threadId);
  const typedEntryId = EntryIdSchema.parse(entryId);
  const message: BranchMessage = { entryId: typedEntryId, text };
  const image = { type: "image", mimeType: "image/png", data: "c2NyYXRjaA==" };
  const attachmentRefs = [{ id: "attachment-1", name: "notes.txt", mediaType: "text/plain" }];
  const source: P3EditSource = {
    editSource: {
      threadId: typedThreadId,
      entryId: typedEntryId,
      parentId: null,
      originalText: text,
      originalImages: [image],
      sourceHeadId: "head-1",
    },
    composerSource: {
      text,
      images: [image],
      attachmentRefs,
      sourceMessageId: String(typedEntryId),
    },
  };
  return { message, ...source };
}

describe("previous-message selector", () => {
  test("selects the chosen message through U4 and restores focus to its trigger", async () => {
    const threadId = ThreadIdSchema.parse("thread-a");
    const first = selectionFor(String(threadId), "entry-a", "First question");
    const second = selectionFor(String(threadId), "entry-b", "Second question");
    const messages = [first.message, second.message];
    const branchMessages: BranchMessageSelectorPort = {
      list: async () => messages,
    };
    const onSelect = vi.fn((_selection: P3EditSelection) => undefined);
    const resolveSource = vi.fn(async (message: BranchMessage) =>
      message.entryId === second.message.entryId ? second : first,
    );
    renderSelector({
      branchMessages,
      threadId,
      resolveSource,
      onSelect,
    });

    const trigger = screen.getByRole("button", { name: TRIGGER });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: TRIGGER })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("option", { name: "Second question" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Choose" }));

    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(second));
    expect(resolveSource).toHaveBeenCalledWith(second.message, expect.any(AbortSignal));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  test("lists the current branch newest first, each row labelled by its first words", async () => {
    const messages = [
      messageFor("entry-1", "First question"),
      messageFor("entry-2", "Second question"),
      messageFor("entry-3", "Third question"),
    ];
    renderSelector({
      branchMessages: { list: async () => messages },
      threadId: ThreadIdSchema.parse("thread-order"),
      resolveSource: async () => null,
      onSelect: () => undefined,
    });

    fireEvent.click(screen.getByRole("button", { name: TRIGGER }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Third question", "Second question", "First question"]);
  });

  test("cuts a long message to its first words and keeps the whole message as detail", async () => {
    const text =
      "Compare the retry policy in the billing worker with the sync worker and list every difference you find, including the timeouts.";
    renderSelector({
      branchMessages: {
        list: async () => [messageFor("entry-long", text), messageFor("entry-blank", "   ")],
      },
      threadId: ThreadIdSchema.parse("thread-long-label"),
      resolveSource: async () => null,
      onSelect: () => undefined,
    });

    fireEvent.click(screen.getByRole("button", { name: TRIGGER }));
    const dialog = await screen.findByRole("dialog");
    const [blank, long] = within(dialog).getAllByRole("option");
    expect(blank?.textContent).toBe("Message without text");
    expect(long?.textContent).toBe(
      `Compare the retry policy in the billing worker with the…${text}`,
    );
  });

  test("gives a repeated label a number, so the answer names exactly one message", async () => {
    const threadId = ThreadIdSchema.parse("thread-repeats");
    const earlier = messageFor("entry-1", "Continue");
    const messages = [earlier, messageFor("entry-2", "Other"), messageFor("entry-3", "Continue")];
    const onSelect = vi.fn((_selection: P3EditSelection) => undefined);
    const resolveSource = vi.fn(async (message: BranchMessage) =>
      selectionFor(String(threadId), String(message.entryId), message.text),
    );
    renderSelector({
      branchMessages: { list: async () => messages },
      threadId,
      resolveSource,
      onSelect,
    });

    fireEvent.click(screen.getByRole("button", { name: TRIGGER }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Continue", "Other", "Continue (2)"]);
    fireEvent.click(within(dialog).getByRole("option", { name: "Continue (2)" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Choose" }));

    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
    expect(resolveSource).toHaveBeenCalledWith(earlier, expect.any(AbortSignal));
  });

  test("leaves out messages that are not on the current branch", async () => {
    const messages = [
      messageFor("entry-kept", "Kept question"),
      messageFor("entry-abandoned", "Abandoned question"),
      messageFor("entry-latest", "Latest question"),
    ];
    renderSelector({
      branchMessages: { list: async () => messages },
      onCurrentBranch: (entryId) => String(entryId) !== "entry-abandoned",
      threadId: ThreadIdSchema.parse("thread-branch"),
      resolveSource: async () => null,
      onSelect: () => undefined,
    });

    fireEvent.click(screen.getByRole("button", { name: TRIGGER }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Latest question", "Kept question"]);
  });

  test("shows the empty state when no message is on the current branch", async () => {
    renderSelector({
      branchMessages: { list: async () => [messageFor("entry-old", "Abandoned")] },
      onCurrentBranch: () => false,
      threadId: ThreadIdSchema.parse("thread-no-branch"),
      resolveSource: async () => null,
      onSelect: () => undefined,
    });

    fireEvent.click(screen.getByRole("button", { name: TRIGGER }));
    expect((await screen.findByText("No earlier messages to edit.")).textContent).toBe(
      "No earlier messages to edit.",
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("shows one line of empty-state copy and uses no other term for the feature", async () => {
    renderSelector({
      branchMessages: { list: async () => [] },
      threadId: ThreadIdSchema.parse("thread-empty"),
      resolveSource: async () => null,
      onSelect: () => undefined,
    });

    fireEvent.click(screen.getByRole("button", { name: TRIGGER }));
    const empty = await screen.findByText("No earlier messages to edit.");
    expect(empty.textContent).toBe("No earlier messages to edit.");
    expect(screen.queryByText(/There are no/)).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.textContent ?? "").not.toMatch(/previous/i);
  });

  test("shows a recoverable load error and retries the typed list request", async () => {
    const branchMessages: BranchMessageSelectorPort = {
      list: vi
        .fn<BranchMessageSelectorPort["list"]>()
        .mockRejectedValueOnce(new Error("private path must not be shown"))
        .mockResolvedValue([]),
    };
    renderSelector({
      branchMessages,
      threadId: ThreadIdSchema.parse("thread-retry"),
      resolveSource: async () => null,
      onSelect: () => undefined,
    });

    fireEvent.click(screen.getByRole("button", { name: TRIGGER }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent ?? "").toContain("Earlier messages could not be loaded.");
    expect(alert.textContent ?? "").not.toContain("private path");
    expect(document.body.textContent ?? "").not.toMatch(/previous/i);
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect((await screen.findByText("No earlier messages to edit.")).textContent).toBe(
      "No earlier messages to edit.",
    );
    expect(branchMessages.list).toHaveBeenCalledTimes(2);
  });

  test("keeps focus on the trigger when Try again fails again", async () => {
    const branchMessages: BranchMessageSelectorPort = {
      list: vi.fn<BranchMessageSelectorPort["list"]>().mockRejectedValue(new Error("Offline")),
    };
    renderSelector({
      branchMessages,
      threadId: ThreadIdSchema.parse("thread-retry-focus"),
      resolveSource: async () => null,
      onSelect: () => undefined,
    });

    const trigger = screen.getByRole("button", { name: TRIGGER });
    trigger.focus();
    fireEvent.click(trigger);
    const alert = await screen.findByRole("alert");
    const retry = within(alert).getByRole("button", { name: "Try again" });
    retry.focus();
    fireEvent.click(retry);

    await waitFor(() => expect(branchMessages.list).toHaveBeenCalledTimes(2));
    await screen.findByRole("alert");
    expect(document.activeElement).toBe(trigger);
  });

  test("returns focus to the trigger after a keyboard retry opens the dialog and Escape closes it", async () => {
    const threadId = ThreadIdSchema.parse("thread-retry-escape");
    const selected = selectionFor(String(threadId), "entry-retry", "Question");
    const branchMessages: BranchMessageSelectorPort = {
      list: vi
        .fn<BranchMessageSelectorPort["list"]>()
        .mockRejectedValueOnce(new Error("Offline"))
        .mockResolvedValue([selected.message]),
    };
    renderSelector({
      branchMessages,
      threadId,
      resolveSource: async () => selected,
      onSelect: () => undefined,
    });

    const trigger = screen.getByRole("button", { name: TRIGGER });
    trigger.focus();
    fireEvent.click(trigger);
    const alert = await screen.findByRole("alert");
    const retry = within(alert).getByRole("button", { name: "Try again" });
    retry.focus();
    fireEvent.click(retry);

    const dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  test("cancels the open dialog when its conversation changes", async () => {
    const threadId = ThreadIdSchema.parse("thread-before-switch");
    const nextThreadId = ThreadIdSchema.parse("thread-after-switch");
    const selected = selectionFor(String(threadId), "entry-switch", "Question");
    const onSelect = vi.fn((_selection: P3EditSelection) => undefined);
    const options: SelectorHarnessProps = {
      branchMessages: { list: async () => [selected.message] },
      threadId,
      resolveSource: async () => selected,
      onSelect,
    };
    const { rerender } = renderSelector(options);
    const trigger = screen.getByRole("button", { name: TRIGGER });
    trigger.focus();
    fireEvent.click(trigger);
    await screen.findByRole("dialog");

    rerender(
      <OverlayHost>
        <SelectorHarness {...options} threadId={nextThreadId} />
      </OverlayHost>,
    );

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onSelect).not.toHaveBeenCalled();
  });

  test("drops a source that resolves after the conversation changed", async () => {
    const threadId = ThreadIdSchema.parse("thread-stale-source");
    const nextThreadId = ThreadIdSchema.parse("thread-stale-source-next");
    const selected = selectionFor(String(threadId), "entry-pending", "Question");
    const pending = Promise.withResolvers<P3EditSource>();
    const resolveSource = vi.fn(() => pending.promise);
    const onSelect = vi.fn((_selection: P3EditSelection) => undefined);
    const options: SelectorHarnessProps = {
      branchMessages: { list: async () => [selected.message] },
      threadId,
      resolveSource,
      onSelect,
    };
    const { rerender } = renderSelector(options);
    fireEvent.click(screen.getByRole("button", { name: TRIGGER }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("option", { name: "Question" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Choose" }));
    await waitFor(() => expect(resolveSource).toHaveBeenCalledTimes(1));

    rerender(
      <OverlayHost>
        <SelectorHarness {...options} threadId={nextThreadId} />
      </OverlayHost>,
    );
    await act(async () => {
      pending.resolve(selected);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(onSelect).not.toHaveBeenCalled();
  });

  test("aborts a pending message list when the selector unmounts", async () => {
    const seen: { signal?: AbortSignal } = {};
    const list = vi.fn((_threadId: unknown, signal?: AbortSignal) => {
      seen.signal = signal;
      return Promise.withResolvers<readonly BranchMessage[]>().promise;
    });
    const { unmount } = renderSelector({
      branchMessages: { list },
      threadId: ThreadIdSchema.parse("thread-unmount"),
      resolveSource: async () => null,
      onSelect: () => undefined,
    });

    fireEvent.click(screen.getByRole("button", { name: TRIGGER }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    expect(seen.signal?.aborted).toBe(false);
    unmount();
    expect(seen.signal?.aborted).toBe(true);
  });

  test("stays busy while the chosen message resolves and ignores a second open", async () => {
    const threadId = ThreadIdSchema.parse("thread-busy");
    const selected = selectionFor(String(threadId), "entry-busy", "Question");
    const pending = Promise.withResolvers<P3EditSource>();
    const resolveSource = vi.fn(() => pending.promise);
    const list = vi.fn(async () => [selected.message]);
    const onSelect = vi.fn((_selection: P3EditSelection) => undefined);
    renderSelector({ branchMessages: { list }, threadId, resolveSource, onSelect });

    const trigger = screen.getByRole("button", { name: TRIGGER });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("option", { name: "Question" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Choose" }));

    expect((await screen.findByRole("status")).textContent).toBe("Opening the message…");
    expect(trigger.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(trigger);
    expect(list).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(resolveSource).toHaveBeenCalledTimes(1));
    pending.resolve(selected);
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(selected));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  test("cancels from the dialog and returns focus without selecting a message", async () => {
    const selected = selectionFor("thread-cancel", "entry-cancel", "Question");
    const onSelect = vi.fn((_selection: P3EditSelection) => undefined);
    renderSelector({
      branchMessages: { list: async () => [selected.message] },
      threadId: ThreadIdSchema.parse("thread-cancel"),
      resolveSource: async () => selected,
      onSelect,
    });

    const trigger = screen.getByRole("button", { name: TRIGGER });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onSelect).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  test("returns focus to the trigger after a pointer open that did not focus it", async () => {
    const selected = selectionFor("thread-pointer", "entry-pointer", "Question");
    renderSelector({
      branchMessages: { list: async () => [selected.message] },
      threadId: ThreadIdSchema.parse("thread-pointer"),
      resolveSource: async () => selected,
      onSelect: () => undefined,
    });

    const trigger = screen.getByRole("button", { name: TRIGGER });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  test("announces loading and ignores a duplicate open while messages are being fetched", async () => {
    const pending = Promise.withResolvers<readonly BranchMessage[]>();
    const list = vi.fn(() => pending.promise);
    renderSelector({
      branchMessages: { list },
      threadId: ThreadIdSchema.parse("thread-loading"),
      resolveSource: async () => null,
      onSelect: () => undefined,
    });

    const trigger = screen.getByRole("button", { name: TRIGGER });
    trigger.focus();
    fireEvent.click(trigger);
    expect((await screen.findByRole("status")).textContent).toContain("Loading earlier messages");
    expect(trigger).toHaveProperty("disabled", false);
    expect(trigger.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    expect(list).toHaveBeenCalledTimes(1);

    pending.resolve([]);
    expect((await screen.findByText("No earlier messages to edit.")).textContent).toBe(
      "No earlier messages to edit.",
    );
  });

  test("hides internal error details behind the safe load message", async () => {
    const branchMessages: BranchMessageSelectorPort = {
      list: async () => {
        throw new AppFailure({
          code: "internal",
          message: "A private path must not be shown.",
          retryable: false,
        });
      },
    };
    renderSelector({
      branchMessages,
      threadId: ThreadIdSchema.parse("thread-internal-error"),
      resolveSource: async () => null,
      onSelect: () => undefined,
    });

    fireEvent.click(screen.getByRole("button", { name: TRIGGER }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent ?? "").toContain("Earlier messages could not be loaded.");
    expect(alert.textContent ?? "").not.toContain("private path");
    expect(within(alert).queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.getByRole("button", { name: TRIGGER })).toHaveProperty("disabled", true);
  });

  test("hides the action when omp cannot list earlier messages (AP2, AP6)", () => {
    const list = vi.fn(async (): Promise<readonly BranchMessage[]> => []);
    renderSelector({
      available: false,
      branchMessages: { list },
      threadId: ThreadIdSchema.parse("thread-unavailable"),
      resolveSource: async () => null,
      onSelect: () => undefined,
    });

    // Nothing is offered: no trigger, no disabled button, no explanation of a missing feature.
    expect(screen.queryByRole("button", { name: TRIGGER })).toBeNull();
    expect(document.querySelector('[data-slot="p3-previous-message-selector"]')).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });

  test.each(["thread", "entry", "composer"] as const)(
    "rejects a resolved source with a stale %s identity",
    async (identity) => {
      const threadId = ThreadIdSchema.parse("thread-source-check");
      const selected = selectionFor(String(threadId), "entry-selected", "Question");
      const wrongSource =
        identity === "thread"
          ? selectionFor("different-thread", "entry-selected", "Question")
          : identity === "entry"
            ? selectionFor(String(threadId), "entry-other", "Question")
            : {
                ...selected,
                composerSource: {
                  ...selected.composerSource,
                  sourceMessageId: "entry-other",
                },
              };
      const onSelect = vi.fn((_selection: P3EditSelection) => undefined);
      renderSelector({
        branchMessages: { list: async () => [selected.message] },
        threadId,
        resolveSource: async () => wrongSource,
        onSelect,
      });

      fireEvent.click(screen.getByRole("button", { name: TRIGGER }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByRole("option", { name: "Question" }));
      fireEvent.click(within(dialog).getByRole("button", { name: "Choose" }));

      const alert = await screen.findByRole("alert");
      expect(alert.textContent ?? "").toContain("The selected message changed. Choose it again.");
      expect(onSelect).not.toHaveBeenCalled();
    },
  );
});
