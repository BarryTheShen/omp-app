import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { RealApp } from "./real-omp";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

const LARGE = Array.from({ length: 150 }, (_, index) => `pasted line ${index + 1}`).join("\n");
const CHOICE = "Pasted 150 lines. Where should they go?";
const REFERENCE = "local://paste-1.md";
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

/** The omp session files of this run whose text contains `text`: the chats that cite it. */
async function sessionFilesContaining(agentDir: string, text: string): Promise<string[]> {
  const sessions = join(agentDir, "sessions");
  let names: string[];
  try {
    names = await readdir(sessions, { recursive: true });
  } catch {
    return []; // omp has not written a session yet; the poll asks again
  }
  const found: string[] = [];
  for (const name of names.filter((file) => file.endsWith(".jsonl"))) {
    const path = join(sessions, name);
    if ((await readFile(path, "utf8")).includes(text)) found.push(path);
  }
  return found;
}

/**
 * The large-paste choice background is the redesign's `bg-muted/30`, resolved on this page.
 */
async function expectPasteChoiceSurface(page: Page): Promise<void> {
  const colors = await page.locator('[data-composer-paste-choice="true"]').evaluate((card) => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = "color-mix(in oklab, var(--muted) 30%, transparent)";
    card.append(probe);
    const token = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { background: getComputedStyle(card).backgroundColor, token };
  });
  expect(colors.token).not.toBe("");
  expect(colors.background).toBe(colors.token);
}

realTest(
  "Attach as local file saves the whole paste in the chat's folder, and the message cites it",
  async ({ realApp }: { readonly realApp: RealApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);

    await paste(composer, LARGE);
    await expect(page.getByText(CHOICE)).toBeVisible();
    await expect(page.locator('[data-composer-paste-choice="true"] button')).toHaveText([
      "Attach as a wrapped block",
      "Attach as local file",
      "Paste inline",
    ]);

    await page.getByRole("button", { name: "Attach as local file" }).click();
    await expect(page.getByText(CHOICE)).toHaveCount(0);
    await expect(composer).toHaveValue(`${REFERENCE} `);

    // The fake model reads the reference with omp's own read tool when the message asks it to. The whole message is
    // set at once: typing at the caret right after the reference appears races the composer's own update.
    await composer.fill(`read_pasted_reference ${REFERENCE} `);
    await expect(composer).toHaveValue(`read_pasted_reference ${REFERENCE} `);
    await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
    await composer.press("Enter");
    await expect(page.getByText("reference read", { exact: true }).first()).toBeVisible({
      timeout: 45_000,
    });
    await expect(page.getByText(REFERENCE).first()).toBeVisible();

    // omp stored the message with the reference in its session file. The agent's read of `local://paste-1.md`, the
    // paste's full text, is in the same session file: omp resolved the reference to the file saved beside it.
    await expect
      .poll(() => sessionFilesContaining(realApp.agentDir, "pasted line 150"), SAVED)
      .not.toEqual([]);
    const [sessionFile] = await sessionFilesContaining(realApp.agentDir, REFERENCE);
    const folder = (sessionFile ?? "").slice(0, -".jsonl".length);
    expect(await readFile(join(folder, "local", "paste-1.md"), "utf8")).toBe(LARGE);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "the three choices read in light, dark and at 390 px",
  async ({ realApp }: { readonly realApp: RealApp }) => {
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (openedPage) => openedPage.emulateMedia({ colorScheme: "light" }),
    });
    const composer = await startChat(page);
    await paste(composer, LARGE);
    await expect(page.getByText(CHOICE)).toBeVisible();
    await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
    await expectPasteChoiceSurface(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1291-choice-light.png") });

    // The app follows the browser's colour scheme live, so the same chat turns dark without a second page or chat.
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    await expectPasteChoiceSurface(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1291-choice-dark.png") });

    // The sessions sidebar is folded away at this width, so the chat is started at full width first.
    await page.setViewportSize({ width: 390, height: 844 });
    const capture = async (name: string): Promise<void> => {
      await expect(page.getByText(CHOICE)).toBeVisible();
      // The sidebars fold with a transition, so the buttons are checked once they have settled inside the width.
      await expect
        .poll(async () => {
          const boxes = await Promise.all(
            ["Attach as a wrapped block", "Attach as local file", "Paste inline"].map((label) =>
              page.getByRole("button", { name: label }).boundingBox(),
            ),
          );
          return boxes.every((box) => box !== null && box.x + box.width <= 390);
        })
        .toBe(true);
      await expectPasteChoiceSurface(page);
      await waitForFiniteAnimations(page);
      await page.screenshot({ path: join(screenshots, name) });
    };
    await capture("fix-1291-choice-390-dark.png");

    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
    await capture("fix-1291-choice-390-light.png");
    expect(realApp.problems).toEqual([]);
  },
);
