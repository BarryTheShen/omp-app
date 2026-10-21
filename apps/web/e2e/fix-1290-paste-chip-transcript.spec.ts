import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { RealApp } from "./real-omp";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

const LARGE = Array.from({ length: 150 }, (_, index) => `pasted line ${index + 1}`).join("\n");
const CHIP = "Pasted text 1 (150 lines).txt";
const SENT_MESSAGE = '[data-message-surface="user-bubble"]';
const TRANSCRIPT_CHIP = '[data-part-type="pasted-text"]';
const SAVED = { timeout: 45_000 } as const;

/** Pastes plain text into the composer, the way a clipboard paste arrives in the browser. */
async function paste(composer: Locator, text: string): Promise<void> {
  await composer.evaluate((input, pasted) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/plain", pasted);
    input.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dataTransfer }),
    );
  }, text);
}

/** The text of every omp session file in this run: what omp stored for each message it was sent. */
async function storedSessionText(agentDir: string): Promise<string> {
  const sessions = join(agentDir, "sessions");
  let names: string[];
  try {
    names = await readdir(sessions, { recursive: true });
  } catch {
    return ""; // omp has not written a session yet; the poll asks again
  }
  const files = names.filter((name) => name.endsWith(".jsonl"));
  const texts = await Promise.all(files.map((name) => readFile(join(sessions, name), "utf8")));
  return texts.join("\n");
}

/**
 * The transcript chip's background is the muted surface the redesign uses (`bg-muted/30`), resolved on this page. Styles
 * that did not load make both colours transparent, so the two would match: the token must be a real colour too.
 */
async function expectChipToken(page: Page): Promise<void> {
  // The chip fades to the new theme's colour, so the comparison waits until the fade has finished.
  let colors = { background: "", token: "" };
  await expect
    .poll(async () => {
      colors = await page
        .locator(TRANSCRIPT_CHIP)
        .first()
        .evaluate((chip) => {
          const probe = document.createElement("div");
          probe.style.backgroundColor = "color-mix(in oklab, var(--muted) 30%, transparent)";
          chip.append(probe);
          const token = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return { background: getComputedStyle(chip).backgroundColor, token };
        });
      return colors.token !== "" && colors.background === colors.token;
    })
    .toBe(true);
  // With no stylesheet both colours are rgba(0, 0, 0, 0) and match, so the token itself must be a real colour.
  expect(colors.token).not.toBe("rgba(0, 0, 0, 0)");
}

/** Sends a wrapped paste with a typed line, and waits for omp's reply. */
async function sendWrappedPaste(page: Page, composer: Locator): Promise<void> {
  await paste(composer, LARGE);
  await page.getByRole("button", { name: "Attach as a wrapped block" }).click();
  await expect(page.locator('[data-slot="u2-composer-attachments"]').getByText(CHIP)).toBeVisible();
  await composer.fill("Summarize this");
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByText("pong", { exact: true }).first()).toBeVisible({ timeout: 45_000 });
}

realTest(
  "a sent wrapped paste shows the typed text and one chip in the transcript, live and after a reload",
  async ({ realApp }: { readonly realApp: RealApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendWrappedPaste(page, composer);

    // The composer's chip is gone; the sent message shows one chip, named as the composer's was, and not the lines.
    await expect(page.locator('[data-slot="u2-composer-attachments"]').getByText(CHIP)).toHaveCount(
      0,
    );
    const transcript = page.getByRole("region", { name: "Conversation transcript" });
    const message = transcript.locator(SENT_MESSAGE);
    await expect(message.getByText("Summarize this")).toBeVisible();
    await expect(message.getByText(CHIP)).toBeVisible();
    await expect(transcript.getByText(/pasted line \d+/)).toHaveCount(0);
    // omp stored the whole pasted text inside its wrapper, unchanged, in its session file.
    await expect
      .poll(() => storedSessionText(realApp.agentDir), SAVED)
      .toContain("pasted line 150");

    // After a reload the transcript comes from omp's history, and shows the same chip.
    await page.reload();
    await expect(page.getByText("pong", { exact: true }).first()).toBeVisible({ timeout: 60_000 });
    const reloaded = page.getByRole("region", { name: "Conversation transcript" });
    await expect(reloaded.locator(SENT_MESSAGE).getByText(CHIP)).toBeVisible({ timeout: 60_000 });
    await expect(reloaded.getByText("Summarize this", { exact: true }).first()).toBeVisible();
    await expect(reloaded.getByText(/pasted line \d+/)).toHaveCount(0);

    // Edit gives back the whole stored message: the chip is for display only.
    const row = reloaded.locator('[data-role="user"]');
    await row.hover();
    await row.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Edit message" })).toHaveValue(
      /pasted line 150/,
    );
    await page.getByRole("button", { name: "Cancel edit" }).click();
    await expect(page.getByRole("textbox", { name: "Edit message" })).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "the transcript chip reads in light, dark and at 390 px",
  async ({ realApp }: { readonly realApp: RealApp }) => {
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (openedPage) => openedPage.emulateMedia({ colorScheme: "light" }),
    });
    const composer = await startChat(page);
    await sendWrappedPaste(page, composer);
    const chip = page.locator(TRANSCRIPT_CHIP);
    await expect(chip).toHaveText(CHIP);
    await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
    await expectChipToken(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1290-transcript-light.png") });

    // The app follows the browser's colour scheme live, so the same chat turns dark without a second page or chat.
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    await expectChipToken(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1290-transcript-dark.png") });

    // The sessions sidebar is folded away at this width, so the chat is checked once it has settled inside it.
    await page.setViewportSize({ width: 390, height: 844 });
    const capture = async (name: string): Promise<void> => {
      await expect(chip).toBeVisible();
      await expect
        .poll(async () => {
          const box = await chip.boundingBox();
          return box !== null && box.x + box.width <= 390;
        })
        .toBe(true);
      await expectChipToken(page);
      await waitForFiniteAnimations(page);
      await page.screenshot({ path: join(screenshots, name) });
    };
    await capture("fix-1290-transcript-390-dark.png");

    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
    await capture("fix-1290-transcript-390-light.png");
    expect(realApp.problems).toEqual([]);
  },
);
