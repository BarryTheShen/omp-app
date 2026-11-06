import type { Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * The dashboard (#2836) on real omp: it opens from the list's foot and with Ctrl+Shift+D; a rule made on it pauses the
 * chat it lists while the clock is in the rule's hours (omp's `/pause`), the chat says why, the queue lists it and
 * Continue now lets it go; a removed rule leaves no rules.
 */
const dashboard = (page: Page) => page.locator('[data-tour="dashboard"]');
const paused = (page: Page) => page.locator('[data-tour="paused"]');

/** The clock `minutes` from now in `zone`, as `HH:MM`. */
function clockIn(page: Page, zone: string, minutes: number): Promise<string> {
  return page.evaluate(
    ([where, ahead]) =>
      new Intl.DateTimeFormat("en-GB", {
        timeZone: where,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(Date.now() + ahead * 60_000),
    [zone, minutes] as const,
  );
}

realTest.describe("new UI: the dashboard", () => {
  realTest.setTimeout(240_000);

  realTest(
    "a rule made on the dashboard pauses its chat in its hours, the queue lets it go, and Ctrl+Shift+D opens it",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await startNewChat(page);
      const box = page.getByRole("textbox", { name: "Message" });
      await expect(box).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await box.fill("hello");
      await box.press("Enter");
      await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 90_000 });

      await page.getByRole("button", { name: "Dashboard" }).click();
      await expect(dashboard(page).getByRole("heading", { name: "Dashboard" })).toBeVisible();
      for (const name of ["Usage windows", "Pace", "Rules", "Queue"])
        await expect(dashboard(page).getByRole("region", { name })).toBeVisible();
      const rules = dashboard(page).getByRole("region", { name: "Rules" });
      const queue = dashboard(page).getByRole("region", { name: "Queue" });
      await expect(rules).toContainText("No rules yet", { timeout: 30_000 });
      await expect(queue).toContainText("No chat is held");

      // Hours that hold now, from two minutes ago to an hour from now, on the server's clock.
      const zoneLine = await rules.getByText(/Hours are the server's time/).textContent();
      const zone = /\((.+)\)/.exec(zoneLine ?? "")?.[1] ?? "UTC";
      await rules.getByRole("button", { name: "New rule" }).click();
      const editor = rules.getByRole("form", { name: "Edit rule" });
      await editor.getByLabel("Name").fill("Day hours");
      await editor.getByLabel("From").fill(await clockIn(page, zone, -2));
      await editor.getByLabel("To").fill(await clockIn(page, zone, 60));
      await editor.getByRole("checkbox").first().check();
      await editor.getByRole("button", { name: "Save rule" }).click();

      await expect(rules.getByText("Day hours")).toBeVisible();
      await expect(rules).toContainText("holding 1 now", { timeout: 60_000 });
      await expect(paused(page)).toContainText("By a usage rule's hours · resumes at", {
        timeout: 30_000,
      });
      await expect(queue).toContainText("Day hours: inside its hours until", { timeout: 30_000 });

      // Continue now: the chat goes on out of its turn, and the queue is empty.
      await queue.getByRole("button", { name: "Continue now" }).click();
      await expect(paused(page)).toHaveCount(0, { timeout: 30_000 });
      await expect(queue).toContainText("No chat is held", { timeout: 30_000 });

      await rules.getByRole("button", { name: "Remove Day hours" }).click();
      await expect(rules).toContainText("No rules yet", { timeout: 30_000 });

      await page.keyboard.press("Escape");
      await expect(dashboard(page)).toHaveCount(0);
      await page.keyboard.press("Control+Shift+KeyD");
      await expect(dashboard(page)).toBeVisible();
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest.describe("omp's statistics", () => {
    // Shares open at the machine's Tailscale address; the test machine has none, so they listen on 127.0.0.1 here, as in
    // the ports specs.
    realTest.use({ serverEnv: { OMP_APP_SHARE_ADDRESS: "127.0.0.1" } });

    realTest(
      "omp's statistics open from the dashboard, through a share of their own (#2836 D6)",
      async ({ realApp }) => {
        const page = await realApp.open({ path: "/" });
        await startNewChat(page);
        await expect(page.getByRole("textbox", { name: "Message" })).toHaveAttribute(
          "placeholder",
          "Message omp",
          { timeout: 120_000 },
        );
        await page.getByRole("button", { name: "Dashboard" }).click();
        const stats = dashboard(page).getByRole("region", { name: "Statistics" });
        await stats.getByRole("button", { name: "Show omp's statistics" }).click();
        // omp's page starts on the server and builds itself the first time.
        const open = stats.getByRole("link", { name: "Open omp's statistics" });
        await expect(open).toBeVisible({ timeout: 120_000 });
        const [shown] = await Promise.all([
          page.context().waitForEvent("page", { timeout: 30_000 }),
          open.click(),
        ]);
        await expect(shown).toHaveTitle("omp stats", { timeout: 60_000 });
        await shown.close();
        expect(realApp.problems).toEqual([]);
      },
    );
  });
});
