/// <reference types="node" />
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

/**
 * Ctrl+G opens the message in an editor dialog (omp's app.editor.external; issue 1215). "Use this text" puts the
 * edited text in the message box. Cancel, or Escape, leaves the box as it was.
 */

const DIALOG = "Edit message";

realTest.setTimeout(420_000);

function editDialog(page: Page): Locator {
  return page.getByRole("dialog", { name: DIALOG });
}

/** Lets finite transitions settle before a screenshot. Bounded: a transition a headless page never finishes must not hang the case. */
async function settle(page: Page): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, 5_000);
  await Promise.race([waitForFiniteAnimations(page), promise]);
  clearTimeout(timer);
}

realTest(
  "Ctrl+G opens the message in an editor, and Use this text puts the edited text in the box",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await composer.fill("first line of the draft");
    await composer.press("Control+g");

    const dialog = editDialog(page);
    await expect(dialog).toBeVisible();
    const text = dialog.getByRole("textbox", { name: "Message text" });
    await expect(text).toHaveValue("first line of the draft");
    await text.fill("edited in the editor");
    // Captured with the edited text in the editor: light, then a 390 px phone width.
    await settle(page);
    await page.screenshot({ path: join(screenshots, "editor-light.png"), fullPage: true });
    const desktop = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    await settle(page);
    await page.screenshot({ path: join(screenshots, "editor-narrow.png"), fullPage: true });
    if (desktop) await page.setViewportSize(desktop);

    await dialog.getByRole("button", { name: "Use this text" }).click();
    await expect(dialog).toBeHidden();
    await expect(composer).toHaveValue("edited in the editor");
  },
);

realTest("Cancel leaves the message box as it was", async ({ realApp }) => {
  const page = await realApp.open();
  const composer = await startChat(page);
  await composer.fill("keep the draft");
  await composer.press("Control+g");

  const dialog = editDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "Message text" }).fill("changed in the editor");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(composer).toHaveValue("keep the draft");
});

realTest("the editor is readable in dark mode", async ({ realApp }) => {
  // The saved theme is set before the page loads, the way a person who chose Dark gets it.
  const page = await realApp.open({
    beforeLoad: (openPage) =>
      openPage.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
  });
  const composer = await startChat(page);
  await composer.fill("dark draft");
  await composer.press("Control+g");
  const dialog = editDialog(page);
  await expect(dialog).toBeVisible();
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  await expect(dialog.getByRole("textbox", { name: "Message text" })).toHaveValue("dark draft");
  await settle(page);
  await page.screenshot({ path: join(screenshots, "editor-dark.png"), fullPage: true });
});
