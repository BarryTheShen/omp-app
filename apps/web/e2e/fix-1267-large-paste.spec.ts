import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { RealApp } from "./real-omp";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

const LARGE = Array.from({ length: 150 }, (_, index) => `pasted line ${index + 1}`).join("\n");
const CHOICE = "Pasted 150 lines. Where should they go?";
const CHIP = "Pasted text 1 (150 lines).txt";
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
 * The composer card's background is the `--card` token, resolved on this page. Styles that did not load show the
 * browser's default colors, and the two would differ.
 */
async function expectCardToken(page: Page): Promise<void> {
  const colors = await page.locator('[data-composer-card="true"]').evaluate((card) => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--card)";
    card.append(probe);
    const token = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { background: getComputedStyle(card).backgroundColor, token };
  });
  expect(colors.token).not.toBe("");
  expect(colors.background).toBe(colors.token);
}

realTest(
  "a paste of 150 lines waits for a choice, and attaching it sends the whole text as one wrapped block",
  async ({ realApp }: { readonly realApp: RealApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);

    await paste(composer, LARGE);
    await expect(page.getByText(CHOICE)).toBeVisible();
    await expect(composer).toHaveValue("");

    await page.getByRole("button", { name: "Attach as a wrapped block" }).click();
    await expect(page.getByText(CHIP)).toBeVisible();
    await expect(page.getByText(CHOICE)).toHaveCount(0);

    await composer.fill("Summarize this");
    // The chip is still uploading for a moment: the composer holds the send until it is attached, and Send enables then.
    await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
    await composer.press("Enter");
    await expect(page.getByText("pong", { exact: true }).first()).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText(CHIP)).toHaveCount(0);
    // omp stored the message with the whole pasted text inside its wrapper, in its session file.
    await expect.poll(() => storedSessionText(realApp.agentDir)).toContain("<attachment>");
    expect(await storedSessionText(realApp.agentDir)).toContain("pasted line 150");
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "Escape pastes a large paste inline, so no text is lost",
  async ({ realApp }: { readonly realApp: RealApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);

    await paste(composer, LARGE);
    await expect(page.getByText(CHOICE)).toBeVisible();
    await composer.press("Escape");

    await expect(composer).toHaveValue(LARGE);
    await expect(page.getByText(CHOICE)).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "the choice in light, dark and at 390 px",
  async ({ realApp }: { readonly realApp: RealApp }) => {
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (openedPage) => openedPage.emulateMedia({ colorScheme: "light" }),
    });
    const composer = await startChat(page);
    await paste(composer, LARGE);
    await expect(page.getByText(CHOICE)).toBeVisible();
    await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
    await expectCardToken(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1267-choice-light.png") });

    // The app follows the browser's colour scheme live, so the same chat turns dark without a second page or chat.
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    await expectCardToken(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1267-choice-dark.png") });

    // The sessions sidebar is folded away at this width, so the chat is started at full width first.
    await page.setViewportSize({ width: 390, height: 844 });
    const capture = async (name: string): Promise<void> => {
      await expect(page.getByText(CHOICE)).toBeVisible();
      // The sidebars fold with a transition, so the buttons are checked once they have settled inside the width.
      await expect
        .poll(async () => {
          const boxes = await Promise.all(
            ["Attach as a wrapped block", "Paste inline"].map((label) =>
              page.getByRole("button", { name: label }).boundingBox(),
            ),
          );
          return boxes.every((box) => box !== null && box.x + box.width <= 390);
        })
        .toBe(true);
      await expectCardToken(page);
      await waitForFiniteAnimations(page);
      await page.screenshot({ path: join(screenshots, name) });
    };
    await capture("fix-1267-choice-390-dark.png");

    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
    await capture("fix-1267-choice-390-light.png");
    expect(realApp.problems).toEqual([]);
  },
);

/** The attachment names of every chat draft the app saved in this run (its draft folders: threads and new chats). */
async function storedDraftAttachments(appDataDir: string): Promise<string[]> {
  const names: string[] = [];
  for (const folder of ["threads", "folders"]) {
    const dir = join(appDataDir, "drafts", folder);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue; // no draft has been saved in this folder yet
    }
    for (const file of files) {
      const value: unknown = JSON.parse(await readFile(join(dir, file), "utf8"));
      if (
        typeof value === "object" &&
        value !== null &&
        "kind" in value &&
        value.kind === "draft" &&
        "attachments" in value &&
        Array.isArray(value.attachments)
      ) {
        names.push(...value.attachments.map((ref: { name?: unknown }) => String(ref.name)));
      }
    }
  }
  return names;
}

realTest(
  "a pasted block restored from the saved draft after a reload is still sent with its text",
  async ({ realApp }: { readonly realApp: RealApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);

    await paste(composer, LARGE);
    await page.getByRole("button", { name: "Attach as a wrapped block" }).click();
    await expect(page.getByText(CHIP)).toBeVisible();
    // The chip is saved with the chat's draft before the reload, so the reload brings it back.
    await expect.poll(() => storedDraftAttachments(realApp.appDataDir), SAVED).toContain(CHIP);

    await page.reload();
    await expect(page.getByText(CHIP)).toBeVisible({ timeout: 60_000 });
    await expect(composer).toHaveValue("");

    await composer.fill("Summarize after the reload");
    await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
    await composer.press("Enter");
    await expect(page.getByText("pong", { exact: true }).first()).toBeVisible({ timeout: 45_000 });
    await expect.poll(() => storedSessionText(realApp.agentDir)).toContain("pasted line 150");
    expect(realApp.problems).toEqual([]);
  },
);
