import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

/*
 * Issue 1363. One rule file with a space in its name (`my notes.md`) made the rule list fail, and the internal-link
 * catalog, which the composer's `rule://` list reads, rejected with it: typing `rule://` offered nothing and showed the
 * error. Here the agent's rules folder holds `my notes.md` beside `good.md`. Typing `rule://` in a chat must offer
 * `good`, must not offer the broken name, and must show no error. Captures: light, dark and 390 px wide.
 */

const LINK_LIST = "Link suggestions";
const GOOD_RULE = /good/;
const BROKEN_RULE = /my notes/;
const RULE_ERROR = "Rule name must be a simple .md or .mdc filename.";

realTest.setTimeout(180_000);

realTest(
  "real omp: typing rule:// offers a good rule file, not the broken name beside it, and shows no error",
  async ({ realApp }) => {
    const rules = join(realApp.agentDir, "rules");
    await mkdir(rules, { recursive: true });
    await writeFile(join(rules, "my notes.md"), "a rule whose name has a space", "utf8");
    await writeFile(join(rules, "good.md"), "a rule the app can manage", "utf8");

    const page = await realApp.open();
    const composer = await startChat(page);
    await composer.pressSequentially("see rule://");

    const list = page.getByRole("listbox", { name: LINK_LIST });
    await expect(list.getByRole("option", { name: GOOD_RULE })).toBeVisible({ timeout: 60_000 });
    await expect(list.getByRole("option", { name: BROKEN_RULE })).toHaveCount(0);
    await expect(page.getByText(RULE_ERROR)).toHaveCount(0);

    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "rule-file-catalog-light.png") });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.screenshot({ path: join(screenshots, "rule-file-catalog-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('[data-shell-sidebar="left"]')).toHaveAttribute("data-open", "false");
    await expect(page.locator('[data-shell-sidebar="right"]')).toHaveAttribute(
      "data-open",
      "false",
    );
    await expect(list.getByRole("option", { name: GOOD_RULE })).toBeVisible();
    // The drawers slide out: the capture waits until their animations have finished.
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "rule-file-catalog-390.png") });

    expect(realApp.problems).toEqual([]);
  },
);
