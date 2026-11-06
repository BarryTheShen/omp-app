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

    realTest(
      "a role's fallbacks are added, moved and removed, and omp keeps them (#2838)",
      async ({ realApp }) => {
        const page = await realApp.open({ path: "/" });
        await newChat(page);
        await box(page).press("Alt+m");
        await expect(hub(page)).toBeVisible();
        const defaultRole = roles(page).getByRole("option", { name: /^DEFAULT Default: / });
        await defaultRole.click();
        const fallbacks = hub(page).getByRole("group", { name: "Fallbacks" });
        const rows = fallbacks.getByRole("listitem");
        await expect(fallbacks).toContainText("No fallbacks: when DEFAULT's model fails");

        const add = fallbacks.getByRole("combobox", { name: "Add a fallback" });
        await add.selectOption("fake/claude-3-haiku-20240307");
        await expect(status(page)).toHaveText("DEFAULT fallbacks: fake/claude-3-haiku-20240307");
        await add.selectOption("fake/claude-fable-5");
        await expect(status(page)).toHaveText(
          "DEFAULT fallbacks: fake/claude-3-haiku-20240307 → fake/claude-fable-5",
        );
        await expect(rows).toHaveText([/Claude Haiku 3/, /Claude Fable 5/]);
        await fallbacks.getByRole("button", { name: "Claude Fable 5 earlier" }).click();
        await expect(status(page)).toHaveText(
          "DEFAULT fallbacks: fake/claude-fable-5 → fake/claude-3-haiku-20240307",
        );
        await expect(rows).toHaveText([/Claude Fable 5/, /Claude Haiku 3/]);

        // omp kept the chain: after a reload the hub reads it back.
        await page.keyboard.press("Escape");
        await expect(hub(page)).toBeHidden();
        await page.reload();
        await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
        await box(page).press("Alt+m");
        await defaultRole.click();
        await expect(rows).toHaveText([/Claude Fable 5/, /Claude Haiku 3/], { timeout: 30_000 });

        await fallbacks.getByRole("button", { name: "Remove Claude Fable 5" }).click();
        await expect(status(page)).toHaveText("DEFAULT fallbacks: fake/claude-3-haiku-20240307");
        await fallbacks.getByRole("button", { name: "Remove Claude Haiku 3" }).click();
        await expect(status(page)).toHaveText("DEFAULT fallbacks cleared");
        await expect(fallbacks).toContainText("No fallbacks");
        expect(realApp.problems).toEqual([]);
      },
    );

    realTest(
      "a preset keeps the roles and switches back to them, and a new role takes a model (#2838)",
      async ({ realApp }) => {
        await appendFile(
          join(realApp.agentDir, "config.yml"),
          ["", "modelRoles:", "  smol: fake/claude-3-haiku-20240307", ""].join("\n"),
        );
        const page = await realApp.open({ path: "/" });
        await newChat(page);
        await box(page).press("Alt+m");
        await expect(hub(page)).toBeVisible();
        const presets = hub(page).getByRole("group", { name: "Presets" });
        const preset = presets.getByRole("combobox", { name: "Preset" });
        await presets.getByRole("button", { name: "Save as…" }).click();
        await presets.getByRole("textbox", { name: "Preset name" }).fill("work");
        await presets.getByRole("button", { name: "Save", exact: true }).click();
        await expect(status(page)).toHaveText('Saved model preset "work"');
        await expect(preset).toHaveValue("work");

        // SMOL takes another model: the roles match no preset now.
        const smol = roles(page).getByRole("option", { name: /^SMOL Fast: / });
        await smol.click();
        await models(page)
          .getByRole("option", { name: /^Claude Fable 5, fake\/claude-fable-5/ })
          .click();
        await expect(status(page)).toHaveText("SMOL model: fake/claude-fable-5");
        await expect(preset).toHaveValue("");
        // Back to the preset: SMOL has its model again.
        await preset.selectOption("work");
        await expect(status(page)).toHaveText(/^Switched to preset "work" \(fake\//);
        await expect(smol).toHaveAccessibleName("SMOL Fast: fake/claude-3-haiku-20240307");
        await presets.getByRole("button", { name: "Delete work" }).click();
        await expect(status(page)).toHaveText('Deleted model preset "work"');
        await expect(preset).toBeDisabled();

        // A role of one's own: named, then its first model creates it.
        await hub(page).getByRole("button", { name: "New role…" }).click();
        const name = hub(page).getByRole("textbox", { name: "New role's name" });
        await name.fill("review");
        await name.press("Enter");
        await expect(hub(page).getByRole("heading", { name: "Assigning review" })).toBeVisible();
        await models(page)
          .getByRole("option", { name: /^Claude Fable 5, fake\/claude-fable-5/ })
          .click();
        await expect(
          roles(page).getByRole("option", { name: "review: fake/claude-fable-5" }),
        ).toBeVisible();
        expect(realApp.problems).toEqual([]);
      },
    );

    realTest(
      "a model's compaction limit shows omp's line for what is typed, is saved, refused past the window, and removed (#2838)",
      async ({ realApp }) => {
        await appendFile(
          join(realApp.agentDir, "config.yml"),
          ["", "modelRoles:", "  smol: fake/claude-3-haiku-20240307", ""].join("\n"),
        );
        const page = await realApp.open({ path: "/" });
        await newChat(page);
        await box(page).press("Alt+m");
        await expect(hub(page)).toBeVisible();
        // SMOL's model, Claude Haiku 3, has a 200K window.
        const smol = roles(page).getByRole("option", { name: /^SMOL Fast: / });
        await smol.click();
        const limit = hub(page).getByRole("group", { name: "Compaction limit" });
        await expect(limit).toContainText("(omp's default)");

        await limit.getByRole("button", { name: "Compaction limit…" }).click();
        const field = limit.getByRole("textbox", { name: "Compaction limit for Claude Haiku 3" });
        await expect(field).toBeFocused();
        await expect(limit).toContainText("400k base · f400k fixed · 80% · empty resets");
        await field.fill("f150k");
        // omp's line for what is typed, before anything is written.
        await expect(limit).toContainText("150K");
        await expect(limit).not.toContainText("400k base");
        await limit.getByRole("button", { name: "Save", exact: true }).click();
        await expect(status(page)).toHaveText(
          /^Compaction limit for fake\/claude-3-haiku-20240307: fixed at 150,000 tokens/,
        );
        await expect(field).toBeHidden();
        await expect(limit).toContainText("(its own limit)");

        // K on the role opens the field with the model's own entry; a fixed point past the window is refused beside it.
        await smol.click();
        await page.keyboard.press("k");
        await expect(field).toHaveValue("f150k");
        await field.fill("f300k");
        await field.press("Enter");
        await expect(limit).toContainText("200K window");
        await expect(field).toBeVisible();
        // Esc closes the field, not Models.
        await field.press("Escape");
        await expect(field).toBeHidden();
        await expect(hub(page)).toBeVisible();
        await expect(limit).toContainText("(its own limit)");

        // Empty removes the model's own limit: omp's default again.
        await limit.getByRole("button", { name: "Compaction limit…" }).click();
        await field.fill("");
        await field.press("Enter");
        await expect(status(page)).toHaveText(
          /^Compaction limit for fake\/claude-3-haiku-20240307: reset/,
        );
        await expect(limit).toContainText("(omp's default)");
        expect(realApp.problems).toEqual([]);
      },
    );

    realTest(
      "the Models view lists omp's models by provider and kind, and a model's role chips give it a role and clear it (#2838)",
      async ({ realApp }) => {
        const page = await realApp.open({ path: "/" });
        await newChat(page);
        await box(page).press("Alt+m");
        await expect(hub(page)).toBeVisible();
        await hub(page)
          .getByRole("group", { name: "View" })
          .getByRole("button", { name: "Models" })
          .click();
        const lists = hub(page).getByRole("listbox", { name: "Lists" });
        await expect(lists.getByRole("option", { name: /^All models, \d+$/ })).toHaveAttribute(
          "aria-selected",
          "true",
        );
        // The fake provider, signed in, with its count.
        await lists.getByRole("option", { name: /^fake, \d+$/ }).click();
        await hub(page)
          .getByRole("group", { name: "Kind" })
          .getByRole("button", { name: "Chat" })
          .click();
        const haiku = models(page).getByRole("option", {
          name: /^Claude Haiku 3, fake\/claude-3-haiku-20240307/,
        });
        await haiku.click();

        const chips = hub(page).getByRole("group", { name: "Roles for Claude Haiku 3" });
        const smol = chips.getByRole("button", { name: "SMOL" });
        await expect(smol).toHaveAttribute("aria-pressed", "false");
        await smol.click();
        await expect(status(page)).toHaveText("SMOL model: fake/claude-3-haiku-20240307");
        await expect(smol).toHaveAttribute("aria-pressed", "true");
        await expect(haiku).toContainText("SMOL");
        // Pressed again, it clears the role: omp's auto-selection again.
        await smol.click();
        await expect(status(page)).toHaveText("SMOL role cleared — auto-selection applies");
        await expect(smol).toHaveAttribute("aria-pressed", "false");

        // Back to the roles.
        await hub(page)
          .getByRole("group", { name: "View" })
          .getByRole("button", { name: "Roles" })
          .click();
        await expect(roles(page)).toBeVisible();
        expect(realApp.problems).toEqual([]);
      },
    );
  });
}
