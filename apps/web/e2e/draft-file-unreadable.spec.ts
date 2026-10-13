import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

/**
 * Issue #1373. One draft file that cannot be read (an empty file in the threads folder) stopped the server from
 * starting, and every picture upload failed with a message that named no file. Now the server starts, names the file in
 * its log, and a picture still attaches and sends. The unreadable file is left as it is.
 */

realTest.setTimeout(300_000);

const UNREADABLE = "unreadable-1373.json";
const IMAGE = "photo-1373.png";
/** A one-pixel PNG, so the dropped file is a real image. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const SENT = "sent with a picture while a draft file is unreadable";
const LOADING = "The image is still loading, so the message is not sent yet.";
const ATTACHMENTS = '[data-slot="u2-composer-attachments"]';
/** A drop shows its chip after the file is read; the bound covers a slow read on a loaded machine. */
const CHIP = { timeout: 30_000 } as const;

function transcript(page: Page): Locator {
  return page.getByRole("region", { name: "Conversation transcript" });
}

/** Drops one PNG onto the composer, as a person does. */
async function dropImage(box: Locator): Promise<void> {
  await box.evaluate(
    (input, { name, base64 }) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File([bytes], name, { type: "image/png" }));
      input.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
    },
    { name: IMAGE, base64: PNG_BASE64 },
  );
}

async function setTheme(page: Page, dark: boolean): Promise<void> {
  await page.evaluate((isDark) => document.documentElement.classList.toggle("dark", isDark), dark);
  await waitForFiniteAnimations(page);
}

/**
 * Waits until the page stops moving. The phone layout slides its side panels in over several frames, and a capture taken
 * during that slide shows them half way. Two polls in a row with the same element geometry count as settled.
 */
async function untilLayoutSettles(page: Page): Promise<void> {
  let previous = "";
  await expect
    .poll(
      async () => {
        const current = await page.evaluate(() =>
          Array.from(document.body.querySelectorAll("*"), (element) => {
            const box = element.getBoundingClientRect();
            return `${box.x},${box.y},${box.width},${box.height},${getComputedStyle(element).opacity}`;
          }).join(";"),
        );
        const settled = current === previous;
        previous = current;
        return settled;
      },
      { timeout: 10_000 },
    )
    .toBe(true);
}

realTest(
  "a draft file that cannot be read does not stop the server or block a picture",
  async ({ realApp }) => {
    await mkdir(screenshots, { recursive: true });
    const threads = join(realApp.appDataDir, "drafts", "threads");
    const unreadable = join(threads, UNREADABLE);
    await mkdir(threads, { recursive: true });
    await writeFile(unreadable, "");
    // Start-up with the unreadable file in the data folder.
    await realApp.restartServer();

    const page = await realApp.open();
    const box = await startChat(page);
    await dropImage(box);
    await expect(page.locator(ATTACHMENTS)).toContainText(IMAGE, CHIP);
    // A message sent while the picture still uploads is held, and nothing sends it later: wait for the picture.
    await expect(page.getByRole("button", { name: `Remove ${IMAGE}` })).toBeVisible(CHIP);
    await expect(page.getByText(LOADING)).toHaveCount(0);
    await box.fill(SENT);
    await box.press("Enter");
    await expect(transcript(page).getByText(SENT, { exact: true })).toBeVisible({
      timeout: 90_000,
    });
    await expect(transcript(page).getByRole("img", { name: "Image attachment" })).toBeVisible();
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "draft-file-unreadable-light.png") });
    await setTheme(page, true);
    await expect(page.locator("body")).toHaveCSS("background-color", /^(rgb|oklch)/);
    await page.screenshot({ path: join(screenshots, "draft-file-unreadable-dark.png") });
    await setTheme(page, false);
    await page.setViewportSize({ width: 390, height: 844 });
    await untilLayoutSettles(page);
    await waitForFiniteAnimations(page);
    const fits = await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    );
    expect(fits).toBe(true);
    await expect(transcript(page).getByText(SENT, { exact: true })).toBeVisible();
    await page.screenshot({ path: join(screenshots, "draft-file-unreadable-narrow.png") });

    // The log names the unreadable file, and the file is left as it is.
    expect(realApp.log()).toContain(`Cannot read draft file ${unreadable}`);
    expect(readFileSync(unreadable, "utf8")).toBe("");
  },
);
