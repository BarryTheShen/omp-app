import type { Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * The new UI's plan mode and goal mode (`apps/ui`, under `/v2/`) on real omp: plan mode by its chip and Alt+Shift+P,
 * omp's proposal reviewed and approved; a goal set from the palette, paused, resumed and dropped.
 */
realTest.describe("new UI plan mode and goal mode", () => {
  realTest.setTimeout(240_000);
  const box = (page: Page) => page.getByRole("textbox", { name: "Message" });

  async function newChat(page: Page): Promise<void> {
    await startNewChat(page);
    await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
  }

  // Exact: after approval, the plan file's write card ("write local://fix-the-login-plan.md") also says "plan".
  const off = (page: Page) =>
    page.getByRole("button", { name: "Plan", exact: true, pressed: false });
  const on = (page: Page) => page.getByRole("button", { name: "Plan", exact: true, pressed: true });

  realTest(
    "plan mode by Alt+Shift+P and its chip; omp's plan is reviewed, approved and run, and names the chat",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await newChat(page);
      await expect(off(page)).toBeVisible({ timeout: 30_000 });
      // The chip shows a switch at once: omp's first answer after a chat opens takes seconds here.
      await box(page).press("Alt+Shift+KeyP");
      await expect(on(page)).toBeVisible({ timeout: 1_000 });
      await box(page).press("Alt+Shift+KeyP");
      await expect(off(page)).toBeVisible({ timeout: 1_000 });
      await off(page).click();
      await expect(on(page)).toBeVisible({ timeout: 1_000 });

      await box(page).fill("plan_propose");
      await box(page).press("Enter");
      const review = page.getByRole("dialog", { name: "Plan ready for review" });
      await expect(review).toBeVisible({ timeout: 60_000 });
      await expect(review).toContainText("Fix the login");
      await expect(review.getByRole("region", { name: "The plan" })).toContainText(
        "Fix the password check.",
      );

      await review.getByRole("button", { name: "Approve" }).click();
      await expect(review).toHaveCount(0);
      await expect(off(page)).toBeVisible({ timeout: 30_000 });
      // omp names the chat after the plan it runs.
      await expect(
        page
          .getByRole("navigation", { name: "Chats" })
          .getByRole("button", { name: /^Fix the login/ }),
      ).toBeVisible({ timeout: 60_000 });
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "omp's plan also waits in the Questions panel; approved there, the chat's plan card closes",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await newChat(page);
      await expect(off(page)).toBeVisible({ timeout: 30_000 });
      await off(page).click();
      await expect(on(page)).toBeVisible({ timeout: 1_000 });
      await box(page).fill("plan_propose");
      await box(page).press("Enter");
      const review = page.getByRole("dialog", { name: "Plan ready for review" });
      await expect(review).toBeVisible({ timeout: 60_000 });

      // The rail counts it; the Questions panel lists it, the plan and its two decisions as in the chat.
      await page
        .getByRole("navigation", { name: "Side panel" })
        .getByRole("button", { name: "Questions, 1 waiting for you" })
        .click();
      const listed = page
        .getByRole("complementary", { name: "Side panel" })
        .getByRole("article", { name: "Plan: Fix the login" });
      await expect(listed.getByRole("region", { name: "The plan" })).toContainText(
        "Fix the password check.",
      );
      await expect(listed.getByRole("button", { name: "Keep planning" })).toBeVisible();
      await listed.getByRole("button", { name: "Approve" }).click();
      await expect(review).toHaveCount(0);
      await expect(listed).toHaveCount(0);
      await expect(off(page)).toBeVisible({ timeout: 30_000 });
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "the late answer to an earlier switch does not turn plan mode back, even briefly",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await newChat(page);
      await expect(off(page)).toBeVisible({ timeout: 30_000 });
      await box(page).press("Alt+Shift+KeyP");
      await box(page).press("Alt+Shift+KeyP");
      await expect(off(page)).toBeVisible({ timeout: 1_000 });
      // Every state the chip shows from now on.
      await page.evaluate(() => {
        const seen: string[] = [];
        (window as unknown as { planChip: string[] }).planChip = seen;
        new MutationObserver(() => {
          const chip = [...document.querySelectorAll("button")].find(
            (button) => button.textContent?.trim() === "Plan",
          );
          seen.push(chip?.getAttribute("aria-pressed") ?? "gone");
        }).observe(document.body, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ["aria-pressed"],
        });
      });
      // omp answers a chat's requests in order, so this message's reply comes after both switches' answers.
      await box(page).fill("hello");
      await box(page).press("Enter");
      await expect(page.getByRole("region", { name: "Transcript" })).toContainText("pong", {
        timeout: 60_000,
      });
      await expect(off(page)).toBeVisible();
      expect(
        await page.evaluate(() => (window as unknown as { planChip: string[] }).planChip),
      ).not.toContain("true");
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "plan mode switched on one page shows on another page with the same chat, both ways (#2812)",
    async ({ realApp }) => {
      const first = await realApp.open({ path: "/" });
      await newChat(first);
      await box(first).fill("count_reply shared");
      await box(first).press("Enter");
      await expect(first.getByText(/count-\d+ shared/)).toBeVisible({ timeout: 60_000 });
      const second = await realApp.open({ path: "/" });
      await second
        .getByRole("navigation", { name: "Chats" })
        .getByRole("button", { name: /count_reply shared/ })
        .first()
        .click();
      await expect(box(second)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await expect(off(second)).toBeVisible({ timeout: 30_000 });

      await off(first).click();
      await expect(on(first)).toBeVisible({ timeout: 1_000 });
      await expect(on(second)).toBeVisible({ timeout: 5_000 });
      await on(second).click();
      await expect(off(second)).toBeVisible({ timeout: 1_000 });
      await expect(off(first)).toBeVisible({ timeout: 5_000 });

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest("a goal is set from the palette, paused, resumed and dropped", async ({ realApp }) => {
    const page = await realApp.open({ path: "/" });
    await newChat(page);
    await box(page).press("Control+k");
    const palette = page.getByRole("dialog", { name: "Palette" });
    await palette.getByRole("combobox").fill("goal");
    await palette.getByRole("option", { name: "Set a goal for this chat…" }).click();

    const dialog = page.getByRole("dialog", { name: "Set a goal" });
    await dialog.getByRole("textbox", { name: "Objective" }).fill("Ship the release");
    await dialog.getByRole("button", { name: "Set goal" }).click();
    // omp answers a chat's requests in order: the palette's model list, asked for when it opened, takes seconds here
    // (omp's model catalog lookups get no answer on the test machine), and the goal waits behind it.
    await expect(dialog).toHaveCount(0, { timeout: 30_000 });

    const chip = (state: string) =>
      page.getByRole("button", { name: `Goal: Ship the release (${state})` });
    await expect(chip("Working on it")).toBeVisible({ timeout: 30_000 });
    await chip("Working on it").click();
    const goal = page.getByRole("region", { name: "Goal", exact: true });
    await goal.getByRole("button", { name: "Pause" }).click();
    await expect(chip("Paused")).toBeVisible();
    await goal.getByRole("button", { name: "Resume" }).click();
    await expect(chip("Working on it")).toBeVisible();
    await goal.getByRole("button", { name: "Drop" }).click();
    await expect(page.getByRole("button", { name: /^Goal: / })).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  });
});
