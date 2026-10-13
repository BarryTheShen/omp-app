import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

/*
 * Issue 1443: Enter after the `/` list had offered a skill replaced the typed arguments with the skill's name, so the
 * command was never sent. The steps are the issue's: type `/skill:`, wait for the skill's row, clear the box, type the
 * whole command and press Enter at once. The command goes to omp with its arguments, and the chat shows the skill card
 * with them. Captures: light, dark and 390 px wide.
 */

const SKILL = "review-notes";
const ARGUMENTS = "fix the typo in the intro";
const COMMAND = `/skill:${SKILL} ${ARGUMENTS}`;
const PROMPT_LINE = "Check every note for typos before you answer.";

/*
 * The fake provider's config.yml (packages/omp-rpc/scripts/fake-openai-server.ts) turns off omp's `native` provider, the
 * one that loads skills, so a seeded skill would not load (follow-up #1377). This config keeps `native` on and the other
 * providers off, as fix-1264-skill-card.spec.ts does.
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

/** A SKILL.md with the frontmatter omp's loader reads, and the config that lets omp load it. */
async function seedSkill(agentDir: string): Promise<void> {
  const folder = join(agentDir, "skills", SKILL);
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, "SKILL.md"),
    `---\nname: ${SKILL}\ndescription: Checks notes for typos.\n---\n${PROMPT_LINE}\n`,
  );
  await writeFile(join(agentDir, "config.yml"), CONFIG_WITH_NATIVE_SKILLS);
}

/** The `/` list above the composer: the listbox the slash-command catalog fills (`trigger-slot.tsx`). */
function commandList(page: Page): Locator {
  return page.getByRole("listbox", { name: "Slash commands" });
}

/** Sets the colour scheme the way the browser does (the app follows System by default), then waits for the theme. */
async function setColorScheme(page: Page, dark: boolean): Promise<void> {
  await page.emulateMedia({ colorScheme: dark ? "dark" : "light" });
  await expect(page.locator("html")).toHaveCSS("color-scheme", dark ? "dark" : "light");
  await waitForFiniteAnimations(page);
}

async function capture(page: Page, name: string): Promise<void> {
  await page
    .getByRole("region", { name: "Conversation transcript" })
    .screenshot({ path: join(screenshots, "fix-1443", `${name}.png`) });
}

realTest(
  "a skill command typed in full and sent with Enter keeps its arguments",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    await seedSkill(realApp.agentDir);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1100, height: 900 });
    const composer = await startChat(page);

    // The person types the skill's name and sees its row in the / list; then the box is cleared.
    await composer.fill("/skill:");
    await expect(
      commandList(page).getByRole("option", { name: new RegExp(`^/skill:${SKILL}\\b`) }),
      "the / list offers the skill",
    ).toBeVisible({ timeout: 60_000 });
    await composer.fill("");
    await expect(commandList(page)).toBeHidden();

    // The whole command, then Enter at once: the list still holds the row it showed for the name alone.
    await composer.fill(COMMAND);
    await composer.press("Enter");

    // Sent with its arguments: one skill card shows them, and the box is empty.
    const cards = page.locator('[data-slot="u1-skill-card"]');
    await expect(cards, "one skill card for the one command").toHaveCount(1, { timeout: 60_000 });
    const card = cards.first();
    await expect(card).toContainText(SKILL);
    await expect(card).toContainText(ARGUMENTS);
    await expect(composer).toHaveValue("");

    // omp's command note floats over the top of the chat for 8 s: wait for it to go, so the captures show the card.
    const note = page.getByText(`Ran /skill:${SKILL} ${ARGUMENTS}.`, { exact: true });
    await expect(note, "the command note shows").toBeVisible({ timeout: 60_000 });
    await expect(note, "the command note goes away").toHaveCount(0, { timeout: 20_000 });
    await capture(page, "light");

    await setColorScheme(page, true);
    await expect(card).toContainText(ARGUMENTS);
    await capture(page, "dark");

    await setColorScheme(page, false);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(card).toContainText(ARGUMENTS);
    await capture(page, "390");
    expect(realApp.problems).toEqual([]);
  },
);
