import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

/*
 * Issue 1264: a `/skill:<name>` run put omp's whole generated prompt into the chat. Here real omp runs a skill
 * with the fake model. The chat shows one skill card with the skill's name, its arguments and the file it came
 * from; the prompt stays hidden until the card's control opens it. Captures: light, dark and 390 px wide.
 */

const SKILL = "review-notes";
const ARGUMENTS = "fix the typo in the intro";
const PROMPT_LINE = "Check every note for typos before you answer.";

/*
 * The fake provider's config.yml (packages/omp-rpc/scripts/fake-openai-server.ts) puts `native` in disabledProviders.
 * With it, omp 18.8.9 did not load the skill and sent `/skill:<name>` as plain text (run directly: no skill-prompt
 * message; the same config without `native` gives one). This config keeps `native` enabled and the other providers off.
 */
const CONFIG_WITH_NATIVE_SKILLS = [
  "disabledProviders:",
  "  - agents-md",
  "  - agents",
  "  - claude",
  "  - codex",
  "  - gemini",
  "  - github",
  "  - opencode",
  "",
].join("\n");

/** A SKILL.md with the frontmatter omp's loader reads (as in fix-799-extension-source.spec.ts), and the config that lets omp load it. */
async function seedSkill(agentDir: string): Promise<void> {
  const folder = join(agentDir, "skills", SKILL);
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, "SKILL.md"),
    `---\nname: ${SKILL}\ndescription: Checks notes for typos.\n---\n${PROMPT_LINE}\n`,
  );
  await writeFile(join(agentDir, "config.yml"), CONFIG_WITH_NATIVE_SKILLS);
}

/*
 * The app follows the browser's colour scheme (its default is System), so the page changes theme when the scheme does.
 * Waits for the transitions it starts, and checks the theme reached the page, so a capture shows it settled.
 */
async function setColorScheme(page: Page, dark: boolean): Promise<void> {
  await page.emulateMedia({ colorScheme: dark ? "dark" : "light" });
  await expect(page.locator("html")).toHaveCSS("color-scheme", dark ? "dark" : "light");
  await waitForFiniteAnimations(page);
}

/*
 * Lets the transitions that a click starts (a chevron turning, a prompt sliding in) begin, then waits for them to
 * finish, so a capture never shows one half way.
 */
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
  await waitForFiniteAnimations(page);
}

async function capture(page: Page, name: string): Promise<void> {
  await page
    .getByRole("region", { name: "Conversation transcript" })
    .screenshot({ path: join(screenshots, "skill-card", `${name}.png`) });
}

/** The `/` list above the composer: the listbox that the slash-command catalog fills (`trigger-slot.tsx`). */
function commandList(page: Page): Locator {
  return page.getByRole("listbox", { name: "Slash commands" });
}

/**
 * Waits until omp lists the skill in the `/` list. The app adds an entry to that list only once omp's catalog has the
 * skill (`apps/web/src/modules/D2/slash/catalog.ts`), so a command sent after this one runs as a skill. Typing `/skill:`
 * opens the list; the box is then emptied, so the command is typed afresh.
 */
async function waitForSkillInList(page: Page, composer: Locator): Promise<void> {
  await composer.fill("/skill:");
  await expect(
    commandList(page).getByRole("option", { name: new RegExp(`^/skill:${SKILL}\\b`) }),
    "omp lists the skill before the command is sent",
  ).toBeVisible({ timeout: 60_000 });
  await composer.fill("");
  await expect(composer).toHaveValue("");
  await expect(commandList(page)).toBeHidden();
}

realTest(
  "a skill run is one collapsed card in the chat, and its prompt opens from the card",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    await seedSkill(realApp.agentDir);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1100, height: 900 });
    const composer = await startChat(page);
    await waitForSkillInList(page, composer);
    await composer.fill(`/skill:${SKILL} ${ARGUMENTS}`);
    // The Send button, not Enter: while the `/` list is loading, Enter chooses its first entry (the skill)
    // and drops the arguments.
    await page.getByRole("button", { name: "Send message" }).click();

    const cards = page.locator('[data-slot="u1-skill-card"]');
    await expect(cards, "one card for the one skill run").toHaveCount(1, { timeout: 60_000 });
    const card = cards.first();
    await expect(card).toContainText(SKILL);
    await expect(card).toContainText(ARGUMENTS);
    await expect(card).toContainText("SKILL.md");
    const trigger = card.locator('[data-slot="u1-skill-card-trigger"]');
    // The stylesheet has loaded: the card's row is a flex row, not browser-default markup.
    await expect(trigger).toHaveCSS("display", "flex");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(
      page.getByText(PROMPT_LINE),
      "the prompt is hidden while the card is closed",
    ).toHaveCount(0);
    // The header's note about the command floats over the top of the chat for 8 seconds: wait for it to show and go,
    // so the captures show the card whole.
    const note = page.getByText(`Ran /skill:${SKILL} ${ARGUMENTS}.`, { exact: true });
    await expect(note, "the command note shows").toBeVisible({ timeout: 60_000 });
    await expect(note, "the command note goes away").toHaveCount(0, { timeout: 20_000 });
    await capture(page, "collapsed-light");

    await setColorScheme(page, true);
    await capture(page, "collapsed-dark");

    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText(PROMPT_LINE), "the prompt opens from the card").toBeVisible();
    await settle(page);
    await capture(page, "open-dark");

    await setColorScheme(page, false);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByText(PROMPT_LINE)).toBeVisible();
    await settle(page);
    await capture(page, "open-390");
    expect(realApp.problems).toEqual([]);
  },
);
