import type { Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * A page that takes its view of a chat back (a kept chat shown again) must ask for the chat's subagent reports again.
 * Letting the view go took what the page had asked for; the view taken back asked for nothing, so once the other page
 * watching the chat left, the server told the chat to stop sending subagent reports: the Agent Hub's numbers froze, and
 * a subagent that ended showed as running, with Kill (an iPhone, 2026-11-24).
 */
realTest.describe("new UI subagents of a chat shown again", () => {
  realTest.setTimeout(300_000);
  const box = (page: Page) => page.getByRole("textbox", { name: "Message" });

  realTest(
    "a kept chat shown again, then left alone by the other page, still follows its subagent to its end",
    async ({ realApp, browser }) => {
      const page = await realApp.open({ path: "/" });
      await startNewChat(page);
      await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      // Forty steps of two seconds: well over a minute of progress.
      await box(page).fill("spawn_steps_subagent 40");
      await box(page).press("Enter");
      const running = page.getByRole("button", { name: "1 agent running" });
      await expect(running).toBeVisible({ timeout: 60_000 });
      const row = (on: Page) =>
        on
          .locator('[data-tour="chat-list"]')
          .getByRole("button", { name: /spawn_steps_subagent/ })
          .first();

      // A second page watches the same chat, in a browser of its own (a shared one would share the first page's layout).
      const elsewhere = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const other = await realApp.open({ path: "/", context: elsewhere });
      await row(other).click();
      await expect(other.getByRole("button", { name: "1 agent running" })).toBeVisible({
        timeout: 60_000,
      });

      // The first page moves to another chat (its chat is kept) and comes back to it; then the other page leaves.
      await startNewChat(page);
      await expect(running).toHaveCount(0);
      await row(page).click();
      await expect(running).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(2_000);
      await elsewhere.close();

      // The Hub's tool count goes on rising: the subagent's reports still come.
      await running.click();
      const hub = page.getByRole("complementary", { name: "Agent Hub" });
      await hub.getByText("StepsProbe").first().click();
      const tools = hub.locator(".ag-stat", { hasText: "tools" }).locator(".ag-stat-value");
      await expect(tools).toBeVisible({ timeout: 30_000 });
      const first = Number(await tools.textContent());
      await expect
        .poll(async () => Number(await tools.textContent()), { timeout: 30_000 })
        .toBeGreaterThan(first + 2);

      // And its end shows: no Kill, and the pill no longer says running.
      await expect(page.getByRole("button", { name: "1 agent", exact: true })).toBeVisible({
        timeout: 180_000,
      });
      await expect(hub.getByRole("button", { name: "Kill" })).toHaveCount(0);
    },
  );
});
