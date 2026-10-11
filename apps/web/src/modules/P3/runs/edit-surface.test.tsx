import {
  type AppendMessage,
  AssistantRuntimeProvider,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { EntryId as EntryIdSchema } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { OmpRuntimeStore } from "@/modules/R0/store";
import { P3EditSurface, type P3EditTarget } from "./edit-surface";
import { storeWithUserMessage, userEntry } from "./test-support";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

interface HarnessProps {
  readonly store: OmpRuntimeStore;
  readonly target: P3EditTarget | null;
  readonly onClose: () => void;
  readonly onEdit: (message: AppendMessage) => void;
}

function Harness({ store, target, onClose, onEdit }: HarnessProps) {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: [],
    onNew: async () => undefined,
    onEdit: async (message) => onEdit(message),
    convertMessage: (value) => value,
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <P3EditSurface onClose={onClose} store={store} target={target} />
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

describe("P3 edit surface", () => {
  test("loads the message's exact text into the composer, and Cancel closes it and returns focus to its row", async () => {
    const trigger = rowTrigger();
    const onClose = vi.fn();
    render(
      <Harness
        onClose={onClose}
        onEdit={() => undefined}
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

  test("submitting hands the edit to the runtime as an edit of that message, and closes the editor", async () => {
    const onClose = vi.fn();
    const onEdit = vi.fn();
    render(
      <Harness
        onClose={onClose}
        onEdit={onEdit}
        store={storeWithUserMessage("Explain")}
        target={{ entryId: userEntry, trigger: rowTrigger() }}
      />,
    );
    const composer = screen.getByRole("textbox", { name: "Edit message" });
    await waitFor(() => expect(composer).toHaveProperty("value", "Explain"));

    fireEvent.change(composer, { target: { value: "Explain again" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    await waitFor(() => expect(onEdit).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onEdit.mock.calls[0]?.[0]).toMatchObject({
      sourceId: String(userEntry),
      content: [{ type: "text", text: "Explain again" }],
    });
  });

  test("a message the chat no longer holds says so, and Close returns focus to its row", () => {
    const trigger = rowTrigger();
    const onClose = vi.fn();
    render(
      <Harness
        onClose={onClose}
        onEdit={() => undefined}
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
        store={storeWithUserMessage("Explain")}
        target={null}
      />,
    );

    expect(container.querySelector('[data-slot="p3-edit-surface"]')).toBeNull();
  });
});
