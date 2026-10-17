import {
  type AppendMessage,
  AssistantRuntimeProvider,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import {
  type EntryId,
  EntryId as EntryIdSchema,
  ThreadId as ThreadIdSchema,
} from "@omp-app/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { OmpRuntimeStore } from "@/modules/R0/store";
import type { P3EditSelection } from "../edit";
import { P3EditSurface, type P3EditTarget, p3EditTargetFromSelection } from "./edit-surface";
import { createP3Runs, type P3Runs } from "./runs";
import { sourceThread, storeWithUserMessage, userEntry } from "./test-support";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

interface HarnessProps {
  readonly store: OmpRuntimeStore;
  readonly runs: P3Runs;
  readonly target: P3EditTarget | null;
  readonly onClose: () => void;
  readonly onEdit: (message: AppendMessage) => void;
}

function Harness({ store, runs, target, onClose, onEdit }: HarnessProps) {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: [],
    onNew: async () => undefined,
    onEdit: async (message) => onEdit(message),
    convertMessage: (value) => value,
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <P3EditSurface onClose={onClose} runs={runs} store={store} target={target} />
    </AssistantRuntimeProvider>
  );
}

/** A row button in the page, focused as if the person had just pressed it. */
function rowTrigger(): HTMLButtonElement {
  const trigger = document.createElement("button");
  trigger.type = "button";
  document.body.append(trigger);
  trigger.focus();
  return trigger;
}
test("keeps the selected entry when focus is in the composer or on the page body", () => {
  const selection = { editSource: { entryId: userEntry } } as P3EditSelection;
  const composer = document.createElement("textarea");
  document.body.append(composer);
  composer.focus();
  expect(p3EditTargetFromSelection(selection, document.activeElement)).toMatchObject({
    entryId: userEntry,
    trigger: null,
  });

  document.body.tabIndex = -1;
  document.body.focus();
  expect(p3EditTargetFromSelection(selection, document.activeElement)).toMatchObject({
    entryId: userEntry,
    trigger: null,
  });
});

const NEW_CHAT = ThreadIdSchema.parse("branch-of-source");
const EDIT = {
  kind: "edit",
  sourceEntryId: userEntry,
  sourceThreadId: sourceThread,
  replacement: { text: "Explain again", images: [] },
} as const;

const secondEntry = EntryIdSchema.parse("second-entry");

/** A chat with two stored user messages, the second a reply to the first, as omp's session file stores them. */
function storeWithTwoMessages(): OmpRuntimeStore {
  const store = new OmpRuntimeStore({ threadId: sourceThread });
  const record = (id: EntryId, parentId: EntryId | null, text: string) => ({
    type: "message",
    id,
    parentId,
    timestamp: "2026-10-05T00:00:00.000Z",
    message: { role: "user", content: text, timestamp: 1 },
  });
  store.pairEndedMessages(
    [record(userEntry, null, "Explain"), record(secondEntry, userEntry, "Summarise")],
    secondEntry,
  );
  return store;
}

/** Types a replacement into the editor and presses Enter, the way the person sends it. */
function sendReplacement(composer: HTMLElement, text: string): void {
  fireEvent.change(composer, { target: { value: text } });
  fireEvent.keyDown(composer, { key: "Enter" });
}

describe("P3 edit surface", () => {
  test("loads the message's exact text into the composer, and Cancel closes it and returns focus to its row", async () => {
    const trigger = rowTrigger();
    const onClose = vi.fn();
    render(
      <Harness
        onClose={onClose}
        onEdit={() => undefined}
        runs={createP3Runs()}
        store={storeWithUserMessage("Explain")}
        target={{ entryId: userEntry, trigger }}
      />,
    );

    expect(screen.getByText("Editing an earlier message")).toBeTruthy();
    const composer = screen.getByRole("textbox", { name: "Edit message" });
    await waitFor(() => expect(composer).toHaveProperty("value", "Explain"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel edit" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);
  });

  test("submitting hands the edit to the runtime as an edit of that message, and keeps the editor open until the run settles", async () => {
    const onClose = vi.fn();
    const onEdit = vi.fn();
    render(
      <Harness
        onClose={onClose}
        onEdit={onEdit}
        runs={createP3Runs()}
        store={storeWithUserMessage("Explain")}
        target={{ entryId: userEntry, trigger: rowTrigger() }}
      />,
    );
    const composer = screen.getByRole("textbox", { name: "Edit message" });
    await waitFor(() => expect(composer).toHaveProperty("value", "Explain"));

    sendReplacement(composer, "Explain again");

    await waitFor(() => expect(onEdit).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
    expect(onEdit.mock.calls[0]?.[0]).toMatchObject({
      sourceId: String(userEntry),
      content: [{ type: "text", text: "Explain again" }],
    });
  });

  test("an edit closes when the new chat is sent, before it settles", async () => {
    const onClose = vi.fn();
    const runs = createP3Runs();
    render(
      <Harness
        onClose={onClose}
        onEdit={() => undefined}
        runs={runs}
        store={storeWithUserMessage("Explain")}
        target={{ entryId: userEntry, trigger: rowTrigger() }}
      />,
    );
    const composer = screen.getByRole("textbox", { name: "Edit message" });
    await waitFor(() => expect(composer).toHaveProperty("value", "Explain"));
    sendReplacement(composer, "Explain again");

    act(() => runs.status.set({ phase: "sending", ...EDIT }));
    act(() =>
      runs.status.set({
        phase: "sent",
        ...EDIT,
        threadId: NEW_CHAT,
        settled: false,
        workspaceGuarantee: "not-managed",
        externalChanges: [],
        partialFailure: null,
      }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  test("a cancelled branch keeps the editor open with the person's text, and the run ends with no notice", async () => {
    const onClose = vi.fn();
    const runs = createP3Runs();
    render(
      <Harness
        onClose={onClose}
        onEdit={() => undefined}
        runs={runs}
        store={storeWithUserMessage("Explain")}
        target={{ entryId: userEntry, trigger: rowTrigger() }}
      />,
    );
    const composer = screen.getByRole("textbox", { name: "Edit message" });
    await waitFor(() => expect(composer).toHaveProperty("value", "Explain"));
    sendReplacement(composer, "Explain again");

    act(() => runs.status.set({ phase: "sending", ...EDIT }));
    act(() => runs.status.set({ phase: "idle" }));

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Edit message" })).toHaveProperty(
        "value",
        "Explain again",
      ),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "Editing an earlier message" })).toBeTruthy();
    expect(runs.status.getSnapshot()).toEqual({ phase: "idle" });
  });

  test("a cancelled edit's text is not loaded when the same message is opened again", async () => {
    const runs = createP3Runs();
    const store = storeWithUserMessage("Explain");
    const view = (target: P3EditTarget | null) => (
      <Harness
        onClose={() => undefined}
        onEdit={() => undefined}
        runs={runs}
        store={store}
        target={target}
      />
    );
    const { rerender } = render(view({ entryId: userEntry, trigger: rowTrigger() }));
    const composer = screen.getByRole("textbox", { name: "Edit message" });
    await waitFor(() => expect(composer).toHaveProperty("value", "Explain"));
    sendReplacement(composer, "Explain again");
    act(() => runs.status.set({ phase: "sending", ...EDIT }));
    act(() => runs.status.set({ phase: "idle" }));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Edit message" })).toHaveProperty(
        "value",
        "Explain again",
      ),
    );

    rerender(view(null));
    rerender(view({ entryId: userEntry, trigger: rowTrigger() }));

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Edit message" })).toHaveProperty(
        "value",
        "Explain",
      ),
    );
  });

  test("another run taking the status releases the editor with the person's text, and the edit is not sent", async () => {
    const onClose = vi.fn();
    const runs = createP3Runs();
    render(
      <Harness
        onClose={onClose}
        onEdit={() => undefined}
        runs={runs}
        store={storeWithUserMessage("Explain")}
        target={{ entryId: userEntry, trigger: rowTrigger() }}
      />,
    );
    const composer = screen.getByRole("textbox", { name: "Edit message" });
    await waitFor(() => expect(composer).toHaveProperty("value", "Explain"));
    sendReplacement(composer, "Explain again");

    act(() => runs.status.set({ phase: "sending", ...EDIT }));
    act(() =>
      runs.status.set({
        phase: "sending",
        kind: "regenerate",
        sourceEntryId: EntryIdSchema.parse("other-entry"),
        sourceThreadId: sourceThread,
        replacement: { text: "Explain", images: [] },
      }),
    );

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Edit message" })).toHaveProperty(
        "value",
        "Explain again",
      ),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  test("a failed edit closes the editor, because its notice keeps the text", async () => {
    const onClose = vi.fn();
    const runs = createP3Runs();
    render(
      <Harness
        onClose={onClose}
        onEdit={() => undefined}
        runs={runs}
        store={storeWithUserMessage("Explain")}
        target={{ entryId: userEntry, trigger: rowTrigger() }}
      />,
    );
    const composer = screen.getByRole("textbox", { name: "Edit message" });
    await waitFor(() => expect(composer).toHaveProperty("value", "Explain"));
    sendReplacement(composer, "Explain again");

    act(() => runs.status.set({ phase: "sending", ...EDIT }));
    act(() =>
      runs.status.set({
        phase: "failed",
        ...EDIT,
        branched: false,
        chatThreadId: sourceThread,
        message: "test stand-in: omp refused the branch",
        retryable: true,
      }),
    );

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  test("a second editor's submit while the first edit is sent is refused in one sentence, and its text stays", async () => {
    const runs = createP3Runs();
    const onEdit = vi.fn();
    const store = storeWithTwoMessages();
    const view = (target: P3EditTarget) => (
      <Harness
        onClose={() => undefined}
        onEdit={onEdit}
        runs={runs}
        store={store}
        target={target}
      />
    );
    const { rerender } = render(view({ entryId: userEntry, trigger: rowTrigger() }));
    const first = screen.getByRole("textbox", { name: "Edit message" });
    await waitFor(() => expect(first).toHaveProperty("value", "Explain"));
    sendReplacement(first, "Explain again");
    act(() => runs.status.set({ phase: "sending", ...EDIT }));

    rerender(view({ entryId: secondEntry, trigger: rowTrigger() }));
    const second = screen.getByRole("textbox", { name: "Edit message" });
    await waitFor(() => expect(second).toHaveProperty("value", "Summarise"));
    sendReplacement(second, "Summarise briefly");

    expect(
      await screen.findByText("Another edit is still being sent. Try again once it has finished."),
    ).toBeTruthy();
    expect(second).toHaveProperty("value", "Summarise briefly");
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  test("a cancelled edit whose editor is no longer on screen leaves another message's editor as it is, and its text moves to a notice", async () => {
    const runs = createP3Runs();
    const store = storeWithTwoMessages();
    const view = (target: P3EditTarget) => (
      <Harness
        onClose={() => undefined}
        onEdit={() => undefined}
        runs={runs}
        store={store}
        target={target}
      />
    );
    const { rerender } = render(view({ entryId: userEntry, trigger: rowTrigger() }));
    const first = screen.getByRole("textbox", { name: "Edit message" });
    await waitFor(() => expect(first).toHaveProperty("value", "Explain"));
    sendReplacement(first, "Explain again");
    act(() => runs.status.set({ phase: "sending", ...EDIT }));

    rerender(view({ entryId: secondEntry, trigger: rowTrigger() }));
    const second = screen.getByRole("textbox", { name: "Edit message" });
    await waitFor(() => expect(second).toHaveProperty("value", "Summarise"));
    fireEvent.change(second, { target: { value: "Summarise briefly" } });

    act(() => runs.status.set({ phase: "idle" }));

    expect(screen.getByRole("textbox", { name: "Edit message" })).toBe(second);
    expect(second).toHaveProperty("value", "Summarise briefly");
    expect(runs.status.getSnapshot()).toMatchObject({
      phase: "failed",
      kind: "edit",
      sourceEntryId: userEntry,
      replacement: { text: "Explain again" },
      message: "omp cancelled the branch",
      retryable: false,
      branched: false,
    });
  });

  test("while the edit is sent, the editor is inert: its Cancel and its text cannot be reached, and it is active again once the run ends", async () => {
    const runs = createP3Runs();
    render(
      <Harness
        onClose={() => undefined}
        onEdit={() => undefined}
        runs={runs}
        store={storeWithUserMessage("Explain")}
        target={{ entryId: userEntry, trigger: rowTrigger() }}
      />,
    );
    const composer = screen.getByRole("textbox", { name: "Edit message" });
    await waitFor(() => expect(composer).toHaveProperty("value", "Explain"));
    sendReplacement(composer, "Explain again");
    act(() => runs.status.set({ phase: "sending", ...EDIT }));

    expect(document.querySelector('[data-slot="p3-edit-surface"] [inert]')).not.toBeNull();

    act(() => runs.status.set({ phase: "idle" }));
    await waitFor(() =>
      expect(document.querySelector('[data-slot="p3-edit-surface"] [inert]')).toBeNull(),
    );
    expect(screen.getByRole("textbox", { name: "Edit message" })).toHaveProperty(
      "value",
      "Explain again",
    );
  });

  test("another run taking the status releases a sent edit whose editor is not on screen: its text shows when that message is opened again", async () => {
    const runs = createP3Runs();
    const store = storeWithTwoMessages();
    const view = (target: P3EditTarget) => (
      <Harness
        onClose={() => undefined}
        onEdit={() => undefined}
        runs={runs}
        store={store}
        target={target}
      />
    );
    const { rerender } = render(view({ entryId: userEntry, trigger: rowTrigger() }));
    const first = screen.getByRole("textbox", { name: "Edit message" });
    await waitFor(() => expect(first).toHaveProperty("value", "Explain"));
    sendReplacement(first, "Explain again");
    act(() => runs.status.set({ phase: "sending", ...EDIT }));

    rerender(view({ entryId: secondEntry, trigger: rowTrigger() }));
    act(() =>
      runs.status.set({
        phase: "sending",
        kind: "regenerate",
        sourceEntryId: secondEntry,
        sourceThreadId: sourceThread,
        replacement: { text: "Summarise", images: [] },
      }),
    );
    rerender(view({ entryId: userEntry, trigger: rowTrigger() }));

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Edit message" })).toHaveProperty(
        "value",
        "Explain again",
      ),
    );
  });

  test("a message whose edit is still being sent shows the text it sent, and stays inert when it is opened again", async () => {
    const runs = createP3Runs();
    const store = storeWithTwoMessages();
    const view = (target: P3EditTarget) => (
      <Harness
        onClose={() => undefined}
        onEdit={() => undefined}
        runs={runs}
        store={store}
        target={target}
      />
    );
    const { rerender } = render(view({ entryId: userEntry, trigger: rowTrigger() }));
    const first = screen.getByRole("textbox", { name: "Edit message" });
    await waitFor(() => expect(first).toHaveProperty("value", "Explain"));
    sendReplacement(first, "Explain again");
    act(() => runs.status.set({ phase: "sending", ...EDIT }));

    rerender(view({ entryId: secondEntry, trigger: rowTrigger() }));
    rerender(view({ entryId: userEntry, trigger: rowTrigger() }));

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Edit message" })).toHaveProperty(
        "value",
        "Explain again",
      ),
    );
    expect(document.querySelector('[data-slot="p3-edit-surface"] [inert]')).not.toBeNull();
  });

  test("a message the chat no longer holds says so, and Close returns focus to its row", () => {
    const trigger = rowTrigger();
    const onClose = vi.fn();
    render(
      <Harness
        onClose={onClose}
        onEdit={() => undefined}
        runs={createP3Runs()}
        store={storeWithUserMessage("Explain")}
        target={{ entryId: EntryIdSchema.parse("gone-entry"), trigger }}
      />,
    );

    expect(screen.getByRole("alert").textContent).toBe("That message is no longer in this chat.");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);
  });

  test("with no target, the surface shows nothing", () => {
    const { container } = render(
      <Harness
        onClose={() => undefined}
        onEdit={() => undefined}
        runs={createP3Runs()}
        store={storeWithUserMessage("Explain")}
        target={null}
      />,
    );

    expect(container.querySelector('[data-slot="p3-edit-surface"]')).toBeNull();
  });
});
