import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { hostRequest, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

/**
 * Issue 2538 on the real app (real server, real omp, the fake model). A chat another omp holds, picked from the command
 * palette's "Open session" dialog, is refused once: the dialog stays open and shows the line on its list, and the sidebar
 * behind the dialog does not repeat it. Once the dialog closes, the sidebar shows the line as it does for a pick made
 * there (issue 2515). No omp starts for the held chat.
 */
realTest.use({ seedSessions: 6 });

/** The seeded chat "Seeded chat 5" (its id is the seeded index, 4, padded). */
const HELD = "Seeded chat 5";
const SEEDED_FIVE = "01a00000-0000-7000-8000-000000000004";
const LINE =
  "This chat is open in another omp, for example in a terminal. Close it there, then open it here.";
const NARROW = { width: 390, height: 844 };

/** The "Open session" dialog, opened from the command palette the way a person opens it. */
async function openSessionDialog(page: Page): Promise<Locator> {
  await page.keyboard.press("Control+k");
  await page.getByRole("option", { name: /^Open session/ }).click();
  const dialog = page.getByRole("dialog", { name: "Open session" });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** The held chat's row in the dialog's list. */
function heldRow(dialog: Locator): Locator {
  return dialog
    .getByRole("listbox", { name: "Session list" })
    .getByRole("option", { name: new RegExp(HELD) });
}

/** The dialog is still open, shows the line once on its list, the page has no second copy, and the row has focus. */
async function expectRefusedOnceInDialog(page: Page, dialog: Locator): Promise<void> {
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("alert").filter({ hasText: LINE })).toBeVisible({
    timeout: 5_000,
  });
  await expect(page.getByText(LINE)).toHaveCount(1);
  await expect(heldRow(dialog)).toBeFocused();
}

realTest(
  "issue 2538: a held chat picked from Open session is refused once in the open dialog, and the sidebar repeats it only after the dialog closes",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(420_000);
    await mkdir(screenshots, { recursive: true });

    // Another omp, as a terminal runs one, takes the chat's lease by writing to it.
    const terminal = realApp.startOmp(["--resume", SEEDED_FIVE]);
    await hostRequest(terminal, "set_session_name", { name: HELD });

    // Desktop, light: a chat on screen, so the palette offers Open session.
    const page = await realApp.open();
    await startChat(page);
    const omps = realApp.ompProcesses();
    const dialog = await openSessionDialog(page);
    await heldRow(dialog).click();
    await expectRefusedOnceInDialog(page, dialog);
    expect(realApp.ompProcesses()).toEqual(omps);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-2538-palette-held-light.png") });

    // Escape closes the dialog. The sidebar then shows the line on the held chat's row, once (issue 2515).
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText(LINE)).toHaveCount(1);
    await expect(page.getByRole("alert").filter({ hasText: LINE })).toBeVisible();

    // Desktop, dark.
    const dark = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await expect(dark.locator("html")).toHaveClass(/dark/);
    await startChat(dark);
    const darkDialog = await openSessionDialog(dark);
    await heldRow(darkDialog).click();
    await expectRefusedOnceInDialog(dark, darkDialog);
    await expect(darkDialog).toHaveCSS("background-color", /^(?!rgba\(0, 0, 0, 0\)).+/);
    await waitForFiniteAnimations(dark);
    await dark.screenshot({ path: join(screenshots, "fix-2538-palette-held-dark.png") });

    // 390 px, light: the narrow sidebar stays closed behind the dialog, and the line is still shown once.
    const narrow = await realApp.open();
    await startChat(narrow);
    await narrow.setViewportSize(NARROW);
    const narrowDialog = await openSessionDialog(narrow);
    await heldRow(narrowDialog).click();
    await expectRefusedOnceInDialog(narrow, narrowDialog);
    await expect(narrow.locator('[data-shell-sidebar="left"]')).toHaveAttribute(
      "data-open",
      "false",
    );
    await waitForFiniteAnimations(narrow);
    await narrow.screenshot({ path: join(screenshots, "fix-2538-palette-held-390-light.png") });

    expect(realApp.problems).toEqual([]);
  },
);
