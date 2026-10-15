import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/** A `count_reply <tag>` answer reads `count-<n> <tag>`, so each test waits for its own answer by its tag. */
function answerTo(page: Page, tag: string) {
  return page.getByText(new RegExp(`^count-\\d+ ${tag}$`));
}

/** Opens the rewind picker from the command palette, then its "Choose where to rewind" dialog. */
async function openPicker(page: Page) {
  await page.keyboard.press("Control+K");
  await page.getByRole("combobox", { name: "Search commands" }).fill("Conversation tree");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Choose a message" }).click();
  return page.getByRole("dialog", { name: "Choose where to rewind" });
}

realTest(
  "a search that hides the marked message disables Rewind here, and clearing it enables it",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    const composer = await startChat(page);
    await sendPrompt(composer, "count_reply first");
    await expect(answerTo(page, "first")).toBeVisible({ timeout: 60_000 });
    await sendPrompt(composer, "count_reply second");
    await expect(answerTo(page, "second")).toBeVisible({ timeout: 60_000 });

    let picker = await openPicker(page);
    await picker.getByRole("treeitem", { name: /count_reply first/ }).click();
    await picker.getByRole("searchbox", { name: "Search conversation messages" }).fill("zzzz");
    await expect(picker.getByText("No messages match your search.")).toBeVisible();
    await expect(picker.getByRole("button", { name: "Rewind here" })).toBeDisabled();
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1372-hidden-mark-light.png"),
      fullPage: true,
    });

    // The dialog closes for the theme switch, then the same mark and search are made again in dark.
    await page.keyboard.press("Escape");
    await page.getByRole("radio", { name: "Dark" }).click();
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    picker = await openPicker(page);
    await picker.getByRole("treeitem", { name: /count_reply first/ }).click();
    await picker.getByRole("searchbox", { name: "Search conversation messages" }).fill("zzzz");
    await expect(picker.getByRole("button", { name: "Rewind here" })).toBeDisabled();
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1372-hidden-mark-dark.png"),
      fullPage: true,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1372-hidden-mark-390.png"),
      fullPage: true,
    });

    // Clearing the search lists the marked message again, and Rewind here is enabled.
    await picker.getByRole("searchbox", { name: "Search conversation messages" }).fill("");
    await expect(picker.getByRole("button", { name: "Rewind here" })).toBeEnabled();
  },
);
