import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { OverlayOpenOptions } from "@/overlay/overlay-host";
import {
  type DestructiveConfirmText,
  openDestructiveCommandConfirm,
} from "./confirm-destructive-command";

afterEach(() => cleanup());

const REMOVE_HOST: DestructiveConfirmText = {
  label: "Remove SSH host",
  title: 'Remove the SSH host "dev" from the project config?',
  description: "Its entry is deleted from that config file. This cannot be undone.",
  confirmLabel: "Remove host",
};

/** Opens the question and renders the modal it asks the overlay host for. */
function openedDialog(text: DestructiveConfirmText) {
  const opened: OverlayOpenOptions[] = [];
  const answer = openDestructiveCommandConfirm(
    {
      open: (options) => {
        opened.push(options);
        return undefined;
      },
    },
    text,
  );
  const modal = opened[0];
  if (modal === undefined) throw new Error("The question did not open a modal.");
  const content = modal.content;
  if (typeof content !== "function") throw new Error("The modal has no render function.");
  render(
    content({
      id: "destructive-command",
      close: () => undefined,
      requestClose: () => undefined,
      update: () => undefined,
    }),
  );
  return { answer, modal };
}

describe("the question before a typed command that deletes data", () => {
  test("names the target as typed, and says what is deleted", () => {
    const { modal } = openedDialog(REMOVE_HOST);
    expect(modal.label).toBe("Remove SSH host");
    expect(screen.getByText('Remove the SSH host "dev" from the project config?')).toBeTruthy();
    expect(
      screen.getByText("Its entry is deleted from that config file. This cannot be undone."),
    ).toBeTruthy();
  });

  test("Cancel sends nothing", async () => {
    const { answer } = openedDialog(REMOVE_HOST);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(answer).resolves.toBe(false);
  });

  test("the destructive button sends the command", async () => {
    const { answer } = openedDialog(REMOVE_HOST);
    fireEvent.click(screen.getByRole("button", { name: "Remove host" }));
    await expect(answer).resolves.toBe(true);
  });

  test("closing the dialog without a choice sends nothing", async () => {
    const { answer } = openedDialog(REMOVE_HOST);
    cleanup();
    await expect(answer).resolves.toBe(false);
  });
});
