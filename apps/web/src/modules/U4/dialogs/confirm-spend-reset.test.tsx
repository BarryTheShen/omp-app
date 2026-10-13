import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { OverlayOpenOptions } from "@/overlay/overlay-host";
import { openSpendResetConfirm } from "./confirm-spend-reset";

afterEach(() => cleanup());

/** Opens the confirmation and renders the modal it asks the overlay host for. */
function openedDialog(accountName: string) {
  const opened: OverlayOpenOptions[] = [];
  const answer = openSpendResetConfirm(
    {
      open: (options) => {
        opened.push(options);
        return undefined;
      },
    },
    accountName,
  );
  const modal = opened[0];
  if (modal === undefined) throw new Error("The confirmation did not open a modal.");
  const content = modal.content;
  if (typeof content !== "function") throw new Error("The modal has no render function.");
  render(
    content({
      id: "spend-reset",
      close: () => undefined,
      requestClose: () => undefined,
      update: () => undefined,
    }),
  );
  return { answer, modal };
}

describe("the spend-reset confirmation", () => {
  test("names the account and says that a spent reset cannot be undone", () => {
    const { modal } = openedDialog("Codex, the active account");
    expect(modal.label).toBe("Reset usage");
    expect(screen.getByText("Spend a saved reset on Codex, the active account?")).toBeTruthy();
    expect(
      screen.getByText("This spends one saved reset. A spent reset cannot be undone."),
    ).toBeTruthy();
  });

  test("Cancel spends nothing", async () => {
    const { answer } = openedDialog("Codex, the active account");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(answer).resolves.toBe(false);
  });

  test("Spend reset spends one saved reset", async () => {
    const { answer } = openedDialog("Claude account 2");
    fireEvent.click(screen.getByRole("button", { name: "Spend reset" }));
    await expect(answer).resolves.toBe(true);
  });

  test("closing the dialog without a choice spends nothing", async () => {
    const { answer } = openedDialog("Codex, the active account");
    cleanup();
    await expect(answer).resolves.toBe(false);
  });
});
