import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  expect,
  type RealApp,
  realTest,
  screenshots,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/**
 * #871: two tabs share one new-chat draft. When the first tab saves a different text while the second tab holds
 * unsaved text of its own, the second tab shows the conflict with its two choices, and its text is still in the
 * composer. "Keep this tab's text" saves that text. "Use the other tab's text" puts the other tab's draft in the
 * composer, so the next keystroke saves on top of it. Real omp; the stored draft is read from the app's data
 * folder, where a clear leaves a `cleared` record and a save a `draft` one.
 */

const CONFLICT = /The other tab changed this draft\./;
const KEEP = "Keep this tab's text";
const USE_OTHER = "Use the other tab's text";
const FIRST_TEXT = "first tab text";
const FIRST_EDIT = "first tab text and a first tab edit";
const SECOND_TEXT = "first tab text and second tab text";
const NARROW = { width: 390, height: 844 } as const;
// The composer saves ten seconds after its last change (AUTOSAVE_MS); the poll allows that plus the save.
const SAVED = { timeout: 45_000 } as const;

realTest.setTimeout(300_000);

/** The text of the new-chat draft stored in the app's data folder, or null when none is stored. */
async function storedNewChatDraft(appDataDir: string): Promise<string | null> {
  const folder = join(appDataDir, "drafts", "folders");
  let files: string[];
  try {
    files = await readdir(folder);
  } catch {
    return null;
  }
  for (const file of files) {
    // The app writes each draft through `.omp-atomic-*` temporary and lock files and renames them into place: skip those.
    if (file.startsWith(".omp-atomic-")) continue;
    let text: string;
    try {
      text = await readFile(join(folder, file), "utf8");
    } catch (error) {
      // Renamed away between the listing and the read: the poll asks again.
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    const value: unknown = JSON.parse(text);
    if (
      typeof value === "object" &&
      value !== null &&
      "kind" in value &&
      value.kind === "draft" &&
      "text" in value &&
      typeof value.text === "string"
    ) {
      return value.text;
    }
  }
  return null;
}

/**
 * Two tabs in one new chat. The second tab loads the first tab's draft, then the first tab edits it and the second
 * tab types its own text after that edit. The first tab's save is ten seconds after its edit, so it lands before the
 * second tab's save (ten seconds after its later keystroke), and the second tab's save then finds a newer draft.
 */
async function conflictInSecondTab(realApp: RealApp) {
  const first = await realApp.open();
  const firstComposer = await startChat(first);
  await firstComposer.fill(FIRST_TEXT);
  await expect.poll(() => storedNewChatDraft(realApp.appDataDir), SAVED).toBe(FIRST_TEXT);

  // The second tab opens a new chat in the same folder: it loads the stored draft, the first tab's text.
  const second = await realApp.open();
  const secondComposer = await startChat(second);
  await expect(secondComposer).toHaveValue(FIRST_TEXT);

  await firstComposer.fill(FIRST_EDIT);
  await secondComposer.pressSequentially(" and second tab text");
  await expect(secondComposer).toHaveValue(SECOND_TEXT);
  await expect.poll(() => storedNewChatDraft(realApp.appDataDir), SAVED).toBe(FIRST_EDIT);

  const conflict = second.getByRole("alert").filter({ hasText: CONFLICT });
  await expect(conflict).toBeVisible(SAVED);
  return { second, secondComposer, conflict };
}

realTest(
  "a second tab keeps its text when the first tab saves a different draft, and says so with two choices",
  async ({ realApp }) => {
    const { second, secondComposer, conflict } = await conflictInSecondTab(realApp);
    await expect(conflict.getByRole("button", { name: KEEP })).toBeVisible();
    await expect(conflict.getByRole("button", { name: USE_OTHER })).toBeVisible();
    // The conflict does not take the second tab's text away: it is still in the composer.
    await expect(secondComposer).toHaveValue(SECOND_TEXT);

    await waitForFiniteAnimations(second);
    await second.screenshot({ path: join(screenshots, "fix-871-tabs-light.png") });
    await second.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(second);
    await second.screenshot({ path: join(screenshots, "fix-871-tabs-dark.png") });
    await second.evaluate(() => document.documentElement.classList.remove("dark"));
    await second.setViewportSize(NARROW);
    await expect(conflict).toBeVisible();
    await waitForFiniteAnimations(second);
    await second.screenshot({ path: join(screenshots, "fix-871-tabs-narrow.png") });

    await conflict.getByRole("button", { name: KEEP }).click();
    await expect(conflict).toHaveCount(0);
    await expect(secondComposer).toHaveValue(SECOND_TEXT);
    await expect.poll(() => storedNewChatDraft(realApp.appDataDir), SAVED).toBe(SECOND_TEXT);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "Use the other tab's text puts that draft in the composer, and the next keystroke saves on top of it",
  async ({ realApp }) => {
    const { second, secondComposer, conflict } = await conflictInSecondTab(realApp);
    await conflict.getByRole("button", { name: USE_OTHER }).click();
    await expect(conflict).toHaveCount(0);
    // The composer shows the other tab's draft, not this tab's text.
    await expect(secondComposer).toHaveValue(FIRST_EDIT);

    await secondComposer.focus();
    await second.keyboard.press("End");
    await second.keyboard.type("!");
    await expect(secondComposer).toHaveValue(`${FIRST_EDIT}!`);
    // The stored draft is the other tab's text with the one more character, not this tab's text.
    await expect.poll(() => storedNewChatDraft(realApp.appDataDir), SAVED).toBe(`${FIRST_EDIT}!`);
    expect(realApp.problems).toEqual([]);
  },
);
