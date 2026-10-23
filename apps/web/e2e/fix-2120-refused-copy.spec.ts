import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, type RealApp, realTest, screenshots, startChat } from "./real-omp";

realTest.setTimeout(300_000);

const TYPED = "a draft this browser cannot keep";
const LATER = "a draft typed after the browser has room";
const NOTICE = "This browser could not keep a copy of your draft. It is still saved to the app.";

interface RefusingWindow {
  __refuseDraftCopies?: boolean;
}

function notice(page: Page): Locator {
  return page.getByRole("status").filter({ hasText: NOTICE });
}

/** Makes this page's storage refuse the draft copies while `window.__refuseDraftCopies` is true, as a full browser does. */
async function refuseDraftCopies(openedPage: Page): Promise<void> {
  await openedPage.addInitScript(() => {
    const refusing = window as unknown as RefusingWindow;
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (refusing.__refuseDraftCopies === true && key.includes(":draft:")) {
        throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      }
      return setItem.call(this, key, value);
    };
  });
}

async function setRefusing(page: Page, refusing: boolean): Promise<void> {
  await page.evaluate((value) => {
    (window as unknown as RefusingWindow).__refuseDraftCopies = value;
  }, refusing);
}

/** The draft texts the app has saved in its data folder, for both kinds of draft. */
async function savedDraftTexts(realApp: RealApp): Promise<string[]> {
  const texts: string[] = [];
  for (const directory of ["threads", "folders"]) {
    const path = join(realApp.appDataDir, "drafts", directory);
    const names = await readdir(path).catch(() => []);
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const saved = JSON.parse(await readFile(join(path, name), "utf8")) as {
        kind?: unknown;
        text?: unknown;
      };
      if (saved.kind === "draft" && typeof saved.text === "string") texts.push(saved.text);
    }
  }
  return texts;
}

realTest(
  "when this browser keeps no copy of a draft, the composer says so in plain words, and the text is still saved to the app",
  async ({ realApp }) => {
    const page = await realApp.open({ beforeLoad: refuseDraftCopies });
    const input = await startChat(page);
    await setRefusing(page, true);
    await input.fill(TYPED);
    await expect(input).toHaveValue(TYPED, { timeout: 30_000 });
    await expect(notice(page)).toBeVisible({ timeout: 30_000 });

    await mkdir(screenshots, { recursive: true });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await notice(page).screenshot({ path: join(screenshots, "fix-2120-refused-copy-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await notice(page).screenshot({ path: join(screenshots, "fix-2120-refused-copy-light.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await notice(page).screenshot({ path: join(screenshots, "fix-2120-refused-copy-390.png") });
    await page.setViewportSize({ width: 1280, height: 800 });

    // The text is still saved to the app: the server's copy holds it once the autosave runs.
    await expect.poll(() => savedDraftTexts(realApp), { timeout: 60_000 }).toContain(TYPED);

    // Once this browser keeps a copy again, the line goes.
    await setRefusing(page, false);
    await input.fill(LATER);
    await expect(notice(page)).toHaveCount(0, { timeout: 30_000 });
    expect(realApp.problems).toEqual([]);
  },
);
