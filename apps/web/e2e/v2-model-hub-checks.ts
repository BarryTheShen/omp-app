import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * omp's model hub (Alt+M) in the new UI (`apps/ui/src/models`) on real omp with the fake models: a role takes a model and
 * a thinking level, they are saved, Clear role hands it back to omp's auto-selection, Default switches the chat, and a
 * search narrows the models (Esc clears it, then closes). In Chromium and in WebKit, the desktop window's engine.
 */

export const box = (page: Page) => page.getByRole("textbox", { name: "Message" });
const chip = (page: Page) => page.getByRole("button", { name: /^Model: / });
export const hub = (page: Page) => page.getByRole("dialog", { name: "Models" });
const roles = (page: Page) => hub(page).getByRole("listbox", { name: "Roles" });
const models = (page: Page) => hub(page).getByRole("listbox", { name: "Models" });
const status = (page: Page) => hub(page).getByRole("status");

async function newChat(page: Page): Promise<void> {
  await startNewChat(page);
  await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
}

export function defineModelHubChecks(engine: "chromium" | "webkit"): void {
  realTest.describe(`new UI model hub in ${engine === "webkit" ? "WebKit" : "Chromium"}`, () => {
    realTest.setTimeout(240_000);

    realTest(
      "a role takes a model and a level, keeps them, and is cleared; Default switches the chat",
      async ({ realApp }) => {
        // omp reads its settings when a chat's omp starts, so the role goes in before the first chat.
        await appendFile(
          join(realApp.agentDir, "config.yml"),
          ["", "modelRoles:", "  smol: fake/claude-3-haiku-20240307", ""].join("\n"),
        );
        const page = await realApp.open({ path: "/" });
        await newChat(page);
        await expect(chip(page)).toHaveAccessibleName("Model: Fake Model");

        await box(page).press("Alt+m");
        await expect(hub(page)).toBeVisible();
        const smol = roles(page).getByRole("option", { name: /^SMOL Fast: / });
        await expect(smol).toHaveAccessibleName("SMOL Fast: fake/claude-3-haiku-20240307");
        await smol.click();
        await expect(smol).toHaveAttribute("aria-selected", "true");
        await expect(hub(page).getByRole("heading", { name: "Assigning SMOL" })).toBeVisible();
        // The role's model is marked in the list.
        await expect(
          models(page).getByRole("option", { name: /^Claude Haiku 3, fake\/claude-3-haiku/ }),
        ).toHaveAttribute("aria-selected", "true");

        await models(page)
          .getByRole("option", { name: /^Claude Fable 5, fake\/claude-fable-5/ })
          .click();
        await expect(status(page)).toHaveText("SMOL model: fake/claude-fable-5");
        await expect(smol).toHaveAccessibleName("SMOL Fast: fake/claude-fable-5");
        // A model that reasons offers its levels; a level is the role's own, saved with it.
        await hub(page)
          .getByRole("group", { name: "Thinking level" })
          // Exact: "high" is also part of "xhigh".
          .getByRole("button", { name: "high", exact: true })
          .click();
        await expect(smol).toHaveAccessibleName("SMOL Fast: fake/claude-fable-5 · high");

        // omp saved the role: a reload reads it back. While the dialog is open the rest of the page is hidden from
        // assistive tech (it is modal), so the chip is read after it closes: only Default switches the chat's model.
        await page.keyboard.press("Escape");
        await expect(hub(page)).toBeHidden();
        await expect(chip(page)).toHaveAccessibleName("Model: Fake Model");
        await page.reload();
        await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
        await box(page).press("Alt+m");
        await expect(smol).toHaveAccessibleName("SMOL Fast: fake/claude-fable-5 · high", {
          timeout: 30_000,
        });

        // Clear role hands it back to omp's auto-selection.
        await smol.click();
        await hub(page).getByRole("button", { name: "Clear role" }).click();
        await expect(status(page)).toHaveText("SMOL role cleared — auto-selection applies");
        await expect(smol).toHaveAccessibleName(/^SMOL Fast: auto → /);
        await expect(hub(page).getByRole("button", { name: "Clear role" })).toHaveCount(0);

        // Default switches this chat.
        await roles(page)
          .getByRole("option", { name: /^DEFAULT Default: / })
          .click();
        await models(page)
          .getByRole("option", { name: /^Claude Fable 5, fake\/claude-fable-5/ })
          .click();
        await expect(status(page)).toHaveText("Default model: fake/claude-fable-5");
        await expect(
          models(page).getByRole("option", { name: "Claude Fable 5, fake/claude-fable-5, in use" }),
        ).toBeVisible();

        // A search narrows the models; Esc clears it first, then closes.
        const search = hub(page).getByRole("searchbox", { name: "Search models" });
        await search.fill("haiku");
        await expect(models(page).getByRole("option")).not.toHaveCount(0);
        for (const name of await models(page).getByRole("option").allTextContents())
          expect(name.toLowerCase()).toContain("haiku");
        await search.press("Escape");
        await expect(search).toHaveValue("");
        await expect(hub(page)).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(hub(page)).toBeHidden();
        // The chip names the chat's new model (and a role besides Default when omp's cycle finds the model in one).
        await expect(chip(page)).toHaveAccessibleName(/^Model: Claude Fable 5\b/);

        expect(realApp.problems).toEqual([]);
      },
    );
  });
}
