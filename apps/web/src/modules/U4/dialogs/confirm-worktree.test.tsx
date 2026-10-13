import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { OverlayOpenOptions } from "@/overlay/overlay-host";
import { openWorktreeConfirm } from "./confirm-worktree";

afterEach(() => cleanup());

/** Opens the confirmation and renders the modal it asks the overlay host for. */
function openedDialog(branch: string) {
  const opened: OverlayOpenOptions[] = [];
  const answer = openWorktreeConfirm(
    {
      open: (options) => {
        opened.push(options);
        return undefined;
      },
    },
    branch,
  );
  const modal = opened[0];
  if (modal === undefined) throw new Error("The confirmation did not open a modal.");
  const content = modal.content;
  if (typeof content !== "function") throw new Error("The modal has no render function.");
  render(
    content({
      id: "move-to-worktree",
      close: () => undefined,
      requestClose: () => undefined,
      update: () => undefined,
    }),
  );
  return { answer, modal };
}

describe("the /wt confirmation", () => {
  test("names the branch, and says the folder's own checkout can be reset and cleaned", () => {
    const { modal } = openedDialog("feature");
    expect(modal.label).toBe("Move to worktree");
    expect(screen.getByText("Move this chat into a worktree on branch feature?")).toBeTruthy();
    expect(screen.getByText(/Clean Source Checkout on \/wt/)).toBeTruthy();
  });

  test("with no branch named, the question says the worktree is new", () => {
    openedDialog("");
    expect(screen.getByText("Move this chat into a new worktree?")).toBeTruthy();
  });

  test("Cancel moves nothing", async () => {
    const { answer } = openedDialog("feature");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(answer).resolves.toBe(false);
  });

  test("Move chat moves the chat", async () => {
    const { answer } = openedDialog("feature");
    fireEvent.click(screen.getByRole("button", { name: "Move chat" }));
    await expect(answer).resolves.toBe(true);
  });

  test("closing the dialog without a choice moves nothing", async () => {
    const { answer } = openedDialog("feature");
    cleanup();
    await expect(answer).resolves.toBe(false);
  });
});
