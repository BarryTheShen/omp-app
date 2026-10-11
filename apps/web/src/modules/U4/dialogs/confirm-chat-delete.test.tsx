import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { OverlayOpenOptions } from "@/overlay/overlay-host";
import { openChatDeleteConfirm } from "./confirm-chat-delete";

afterEach(() => cleanup());

/** Opens the confirmation and renders the modal it asks the overlay host for. */
function openedDialog(chatTitle: string) {
  const opened: OverlayOpenOptions[] = [];
  const answer = openChatDeleteConfirm(
    {
      open: (options) => {
        opened.push(options);
        return undefined;
      },
    },
    chatTitle,
  );
  const modal = opened[0];
  if (modal === undefined) throw new Error("The confirmation did not open a modal.");
  const content = modal.content;
  if (typeof content !== "function") throw new Error("The modal has no render function.");
  render(
    content({
      id: "delete-chat",
      close: () => undefined,
      requestClose: () => undefined,
      update: () => undefined,
    }),
  );
  return { answer, modal };
}

describe("the delete-chat confirmation", () => {
  test("names the chat and says that deleting cannot be undone", () => {
    const { modal } = openedDialog("Seeded chat 2");
    expect(modal.label).toBe("Delete chat");
    expect(screen.getByText('Delete "Seeded chat 2"?')).toBeTruthy();
    expect(screen.getByText("Deleting this chat cannot be undone.")).toBeTruthy();
  });

  test("Cancel keeps the chat", async () => {
    const { answer } = openedDialog("Seeded chat 2");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(answer).resolves.toBe(false);
  });

  test("Delete removes the chat", async () => {
    const { answer } = openedDialog("Seeded chat 2");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await expect(answer).resolves.toBe(true);
  });

  test("closing the dialog without a choice keeps the chat", async () => {
    const { answer } = openedDialog("Seeded chat 2");
    cleanup();
    await expect(answer).resolves.toBe(false);
  });
});
