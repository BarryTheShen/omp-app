import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { RealApp } from "./real-omp";
import {
  expect,
  narrowTo,
  realTest,
  screenshots,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/**
 * Issue #2582. A picture pasted into the message box is attached, sent, and kept in the user message in omp's session
 * file. This is the browser's path: Chromium gives the page the picture's file in the paste event. The desktop window
 * reads the picture through its own clipboard command instead; that path is checked in the desktop window, on the test machine.
 */

realTest.setTimeout(240_000);

/** A one-pixel PNG, so the picture is a real image. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const CHIP_NAME = "photo-2582.png";
const CHIP = '[data-slot="u2-composer-attachments"] [data-slot="attachment-root"]';
const SENT = '[data-message-surface="user-bubble"]';
const TEXT = "Describe the picture";
const SAVED = { timeout: 45_000 } as const;

/** One content part of a message in omp's session file: text, or a picture with its bytes. */
interface StoredPart {
  readonly type: string;
  readonly data?: string;
  readonly mimeType?: string;
}

/** One line of a session file: a message, when it is one. */
interface StoredEntry {
  readonly message?: { readonly role?: string; readonly content?: string | readonly StoredPart[] };
}

/** A paste whose event carries the picture's file, as Chromium gives it. */
async function pasteFile(composer: Locator): Promise<void> {
  await composer.evaluate((input, base64) => {
    input.focus();
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([bytes], "photo-2582.png", { type: "image/png" }));
    input.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer,
      }),
    );
  }, PNG_BASE64);
}

/** The picture parts omp stored in the user message that says `text`. Each session file line is one JSON entry. */
async function storedPictures(agentDir: string, text: string): Promise<readonly StoredPart[]> {
  const sessions = join(agentDir, "sessions");
  let names: string[];
  try {
    names = await readdir(sessions, { recursive: true });
  } catch {
    return []; // omp has not written a session yet; the poll asks again
  }
  const pictures: StoredPart[] = [];
  for (const name of names.filter((file) => file.endsWith(".jsonl"))) {
    for (const line of (await readFile(join(sessions, name), "utf8")).split("\n")) {
      if (!line.includes(text)) continue;
      const entry = JSON.parse(line) as StoredEntry;
      const content = entry.message?.content;
      if (entry.message?.role !== "user" || typeof content === "string" || content === undefined)
        continue;
      pictures.push(...content.filter((part) => part.type === "image"));
    }
  }
  return pictures;
}

/** Sends the typed text with the attached picture, waits for omp's reply, and checks the transcript and omp's file. */
async function sendWithPicture(page: Page, composer: Locator, agentDir: string): Promise<void> {
  await composer.fill(TEXT);
  // The picture uploads after its chip shows; a send before the upload ends is held, so wait until Send is enabled.
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByText("pong", { exact: true }).first()).toBeVisible({ timeout: 45_000 });
  const message = page.getByRole("region", { name: "Conversation transcript" }).locator(SENT);
  await expect(message.getByText(TEXT)).toBeVisible();
  await expect(message.locator("img")).toHaveCount(1);
  await expect.poll(() => storedPictures(agentDir, TEXT), SAVED).toHaveLength(1);
  const [picture] = await storedPictures(agentDir, TEXT);
  expect(picture?.data).toEqual(expect.any(String));
  expect(picture?.mimeType).toMatch(/^image\//);
}

/**
 * The chip's background is the muted surface the composer uses (`bg-muted/30`), resolved on this page. Styles that did
 * not load make both colours transparent, so the token itself must be a real colour too.
 */
async function expectChipToken(page: Page): Promise<void> {
  let colors = { background: "", token: "" };
  await expect
    .poll(async () => {
      colors = await page
        .locator(CHIP)
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

realTest(
  "a picture pasted with its file, as Chromium gives it, is attached, sent, and kept in omp's session",
  async ({ realApp }: { readonly realApp: RealApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await pasteFile(composer);
    await expect(page.locator(CHIP).filter({ hasText: CHIP_NAME })).toBeVisible({
      timeout: 30_000,
    });
    await sendWithPicture(page, composer, realApp.agentDir);
  },
);

realTest(
  "in a browser, a paste with no file and no text leaves the message box as it was",
  async ({ realApp }: { readonly realApp: RealApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await composer.evaluate((input) => {
      input.focus();
      input.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: new DataTransfer(),
        }),
      );
    });
    await expect(composer).toHaveValue("");
    await expect(page.locator(CHIP)).toHaveCount(0);
    await expect(page.locator('[data-composer-error="true"]')).toHaveCount(0);
  },
);

realTest(
  "the picture chip reads in light, with its colours loaded",
  async ({ realApp }: { readonly realApp: RealApp }) => {
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) => target.emulateMedia({ colorScheme: "light" }),
    });
    const composer = await startChat(page);
    await pasteFile(composer);
    await expect(page.locator(CHIP).filter({ hasText: CHIP_NAME })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
    await expectChipToken(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-2582-chip-light.png") });
  },
);

realTest(
  "the picture chip reads in dark, with its colours loaded",
  async ({ realApp }: { readonly realApp: RealApp }) => {
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) => target.emulateMedia({ colorScheme: "dark" }),
    });
    const composer = await startChat(page);
    await pasteFile(composer);
    await expect(page.locator(CHIP).filter({ hasText: CHIP_NAME })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    await expectChipToken(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-2582-chip-dark.png") });
  },
);

realTest("the picture chip reads at 390 px", async ({ realApp }: { readonly realApp: RealApp }) => {
  await mkdir(screenshots, { recursive: true });
  const page = await realApp.open();
  const composer = await startChat(page);
  await narrowTo(page, { width: 390 });
  await pasteFile(composer);
  await expect(page.locator(CHIP).filter({ hasText: CHIP_NAME })).toBeVisible({
    timeout: 30_000,
  });
  await expectChipToken(page);
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "fix-2582-chip-390.png") });
});
