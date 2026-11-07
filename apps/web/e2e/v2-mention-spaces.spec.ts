import type { Page } from "@playwright/test";
import { expect, type RealApp, realTest, startNewChat } from "./real-omp";

/**
 * The `@` menu with names that have spaces (#2846): `@"…` keeps it open up to the closing quote, as omp's terminal does;
 * words with one space between them keep it open while something matches; the row taken replaces all that was typed. A
 * seeded notes extension, like a notes app's, understands `@word` and `@"…` and answers after 800 ms, so the time an
 * answer is coming can be checked.
 */
const NOTES = `export default function notes(pi) {
  const NOTES = [{ id: "n1", title: "Lab report" }, { id: "n2", title: "Summer 2027 Internship" }];
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.addAutocompleteProvider((current) => ({
      ...current,
      async getSuggestions(lines, line, col, signal) {
        const before = lines[line].slice(0, col);
        const at = /(?:^|\\s)(@"[^"\\n]{2,60})$/.exec(before) ?? /(?:^|\\s)(@[^\\s@"]{2,})$/.exec(before);
        if (!at) return current.getSuggestions(lines, line, col, signal);
        const query = at[1].replace(/^@"?/, "").trim().toLowerCase();
        await new Promise((resolve) => setTimeout(resolve, 800));
        const hits = NOTES.filter((note) => note.title.toLowerCase().includes(query));
        if (hits.length === 0) return current.getSuggestions(lines, line, col, signal);
        return { prefix: at[1], items: hits.map((note) => ({ value: note.id, label: note.title, description: "note from Notes" })) };
      },
      applyCompletion(lines, line, col, item, prefix) {
        const next = [...lines];
        const insert = "@[" + item.label + "](note:" + item.value + ") ";
        next[line] = lines[line].slice(0, col - prefix.length) + insert + lines[line].slice(col);
        return { lines: next, cursorLine: line, cursorCol: col - prefix.length + insert.length };
      },
    }));
  });
}
`;
const SUMMER = "read @[Summer 2027 Internship](note:n2) ";

const box = (page: Page) => page.getByRole("textbox", { name: "Message" });
const menu = (page: Page) => page.getByRole("listbox", { name: /^Files (and more )?to mention$/ });
const transcript = (page: Page) => page.getByRole("region", { name: "Transcript" });

async function newChat(realApp: RealApp): Promise<Page> {
  const page = await realApp.open({ path: "/" });
  await startNewChat(page);
  await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
  return page;
}

realTest.describe("new UI @ menu: names with spaces", () => {
  realTest.setTimeout(240_000);
  realTest.use({
    // Without it the fake provider's setup turns off omp's own discovery, which loads the agent folder's extensions.
    serverEnv: { FAKE_OPENAI_ENABLE_RULES: "1" },
    seedWorkspace: {
      files: {
        "lecture 3 notes.txt": "Week 3\n",
        "src/foo.ts": "export const foo = 1;\n",
        "src/parser.ts": "export const parse = 1;\n",
      },
      gitRepo: true,
    },
    seedExtensions: { "notes.ts": NOTES },
  });

  realTest(
    "a name in quotes, and the same words without them, offer the note; Enter puts it in place of all that was typed",
    async ({ realApp }) => {
      const page = await newChat(realApp);
      for (const typed of ['read @"summer 2027 int', "read @summer 2027 int"]) {
        await box(page).fill("");
        await box(page).pressSequentially(typed);
        const note = menu(page).getByRole("option", { name: /Summer 2027 Internship/ });
        await expect(note).toBeVisible({ timeout: 30_000 });
        await box(page).press("Enter");
        await expect(box(page)).toHaveValue(SUMMER);
        await expect(menu(page)).toHaveCount(0);
      }
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "the rows stay while the next word's answer is coming, and Enter then takes the row once the answer still has it",
    async ({ realApp }) => {
      const page = await newChat(realApp);
      await box(page).pressSequentially("read @summer");
      const note = menu(page).getByRole("option", { name: /Summer 2027 Internship/ });
      await expect(note).toBeVisible({ timeout: 30_000 });
      await box(page).pressSequentially(" 2");
      // The answer for "summer 2" takes at least 920 ms (the pause, then the extension's 800 ms).
      await page.waitForTimeout(300);
      expect(await note.isVisible()).toBe(true);
      await box(page).press("Enter");
      await expect(box(page)).toHaveValue(SUMMER, { timeout: 10_000 });
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "a file whose name has spaces is found past its first word and put in quoted",
    async ({ realApp }) => {
      const page = await newChat(realApp);
      await box(page).pressSequentially("see @lecture 3");
      const file = menu(page).getByRole("option", { name: /lecture 3 notes\.txt/ });
      await expect(file).toBeVisible({ timeout: 30_000 });
      await box(page).press("Enter");
      await expect(box(page)).toHaveValue('see @"lecture 3 notes.txt" ');
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "words after a mention that match nothing close the menu and stay as typed, also with a quick Enter",
    async ({ realApp }) => {
      const page = await newChat(realApp);
      await box(page).pressSequentially("look at @foo");
      await expect(menu(page).getByRole("option", { name: /src\/foo\.ts/ })).toBeVisible({
        timeout: 30_000,
      });
      await box(page).pressSequentially(" and then");
      await expect(menu(page)).toHaveCount(0, { timeout: 10_000 });
      await expect(box(page)).toHaveValue("look at @foo and then");

      // Enter right after the words, while their answer is coming: the row from before is not put in their place.
      await box(page).fill("");
      await box(page).pressSequentially("look at @foo");
      await expect(menu(page).getByRole("option", { name: /src\/foo\.ts/ })).toBeVisible({
        timeout: 30_000,
      });
      await box(page).pressSequentially(" and tell me why");
      await box(page).press("Enter");
      await expect(menu(page)).toHaveCount(0, { timeout: 10_000 });
      await expect(box(page)).toHaveValue("look at @foo and tell me why");
      // The next Enter sends it as typed.
      await box(page).press("Enter");
      await expect(transcript(page).getByText("look at @foo and tell me why")).toBeVisible({
        timeout: 60_000,
      });
      expect(realApp.problems).toEqual([]);
    },
  );
});
