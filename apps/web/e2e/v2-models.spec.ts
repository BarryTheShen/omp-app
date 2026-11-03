import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * omp's Ctrl+P and Shift+Ctrl+P in the new UI (`apps/ui`) on real omp: the chat switches to the next or previous role's
 * model in omp's order, a role without a model is skipped, the roles show for a moment above the box, and the model
 * chip names the role.
 */
realTest.describe("new UI role models", () => {
  realTest.setTimeout(240_000);

  const box = (page: Page) => page.getByRole("textbox", { name: "Message" });
  const chip = (page: Page) => page.getByRole("button", { name: /^Model: / });
  const track = (page: Page) => page.getByRole("status", { name: "Roles" });

  async function newChat(page: Page): Promise<void> {
    await startNewChat(page);
    await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
  }

  realTest(
    "Ctrl+P walks the roles in omp's order and back, skipping a role without a model",
    async ({ realApp }) => {
      // omp reads its settings when a chat's omp starts, so the roles go in before the first chat.
      await appendFile(
        join(realApp.agentDir, "config.yml"),
        [
          "",
          "modelRoles:",
          "  smol: fake/claude-3-haiku-20240307",
          "  slow: fake/claude-fable-5",
          "  plan: fake/no-such-model",
          "cycleOrder: [smol, default, plan, slow]",
          "",
        ].join("\n"),
      );
      const page = await realApp.open({ path: "/" });
      await newChat(page);
      await expect(chip(page)).toHaveAccessibleName("Model: Fake Model");
      await box(page).fill("half a thought");

      // Every name the chip takes from the key on: it goes from the old role's model to the new one's in one step,
      // never the new role with the old model (#2763).
      await chip(page).evaluate((element) => {
        const names: string[] = [];
        const record = () => {
          const name = element.getAttribute("aria-label") ?? "";
          if (names.at(-1) !== name) names.push(name);
        };
        record();
        new MutationObserver(record).observe(element, { attributes: true, subtree: true });
        (window as unknown as { chipNames: string[] }).chipNames = names;
      });
      await box(page).press("Control+p");
      await expect(chip(page)).toHaveAccessibleName("Model: Claude Fable 5 (slow)");
      await expect(chip(page)).toHaveText(/slow · Claude Fable 5/);
      await page.waitForTimeout(1_500);
      expect(
        await page.evaluate(() => (window as unknown as { chipNames: string[] }).chipNames),
      ).toEqual(["Model: Fake Model", "Model: Claude Fable 5 (slow)"]);
      // The roles in omp's order, the one switched to marked; the one without a model is shown, as omp shows it.
      await expect(track(page).getByRole("listitem")).toHaveText([
        "smol",
        "default",
        "plan",
        "slow",
      ]);
      await expect(track(page).locator("[aria-current='true']")).toHaveText("slow");
      await expect(track(page)).toBeHidden({ timeout: 5_000 });

      // After the last role comes the first, and Shift+Ctrl+P goes back.
      await box(page).press("Control+p");
      await expect(chip(page)).toHaveAccessibleName("Model: Claude Haiku 3 (smol)");
      await box(page).press("Control+Shift+p");
      await expect(chip(page)).toHaveAccessibleName("Model: Claude Fable 5 (slow)");
      await box(page).press("Control+Shift+p");
      await expect(chip(page)).toHaveAccessibleName("Model: Fake Model");
      // The keys belong to the pane: the text typed stays.
      await expect(box(page)).toHaveValue("half a thought");

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "with one role, Ctrl+P says so in a toast above the box that passes, and keeps the model",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await newChat(page);
      await box(page).press("Control+p");
      // omp's status line, as Tern draws it: a toast for a moment, not a row in the chat.
      const toast = page.getByRole("status").filter({ hasText: "Only one role model available" });
      await expect(toast).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByRole("region", { name: "Transcript" }).getByText("Only one role model available"),
      ).toHaveCount(0);
      await expect(chip(page)).toHaveAccessibleName("Model: Fake Model");
      await expect(track(page)).toHaveCount(0);
      // Tern's 5.2 s for a note that is not a success, then a 260 ms fade.
      await expect(toast).toHaveCount(0, { timeout: 10_000 });

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "in a split, the pane chosen by a click on its transcript or its title bar takes Ctrl+P and Shift+Tab (#2761)",
    async ({ realApp }) => {
      await appendFile(
        join(realApp.agentDir, "config.yml"),
        [
          "",
          "modelRoles:",
          "  smol: fake/claude-3-haiku-20240307",
          "  slow: fake/claude-fable-5",
          "",
        ].join("\n"),
      );
      const page = await realApp.open({ path: "/" });
      await newChat(page);
      await box(page).press("Control+Shift+o");
      // The split is a blank window: its New chat starts the second chat.
      await startNewChat(page);
      const panes = page.locator("[data-chat-pane]");
      await expect(panes).toHaveCount(2);
      const [left, right] = [panes.nth(0), panes.nth(1)];
      const chipIn = (pane: typeof left) => pane.getByRole("button", { name: /^Model: / });
      const thinkingIn = (pane: typeof left) => pane.getByRole("button", { name: /^Thinking: / });
      await expect(right.getByRole("textbox", { name: "Message" })).toHaveAttribute(
        "placeholder",
        "Message omp",
        { timeout: 120_000 },
      );

      // The left pane, chosen by a click on its transcript: Ctrl+P switches its model, not the other pane's.
      await left.getByRole("region", { name: "Transcript" }).click();
      await page.keyboard.press("Control+p");
      await expect(chipIn(left)).toHaveAccessibleName("Model: Claude Fable 5 (slow)");
      await expect(chipIn(right)).toHaveAccessibleName("Model: Fake Model");

      // The right pane, chosen by a click on its title bar: Shift+Tab steps its thinking level.
      const before = (await thinkingIn(right).getAttribute("aria-label")) ?? "";
      await page.locator(".dv-default-tab").nth(1).click();
      await page.keyboard.press("Shift+Tab");
      await expect(thinkingIn(right)).not.toHaveAccessibleName(before);
      await expect(chipIn(left)).toHaveAccessibleName("Model: Claude Fable 5 (slow)");

      expect(realApp.problems).toEqual([]);
    },
  );
});
