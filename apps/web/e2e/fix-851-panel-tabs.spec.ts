/// <reference types="node" />
import { join } from "node:path";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/**
 * Issue #851 against real omp: the right-hand panels are tabs. After the fake model makes a todo
 * list the sidebar shows Todo checklist, Context and Agents. The row is one Tab stop, and the arrow
 * keys (with Home and End) move focus and selection along it.
 */

realTest.setTimeout(420_000);

realTest(
  "the right-hand panel tabs move focus and selection with the arrow keys",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "Please make_todos for the release.");
    await expect(page.getByText("Write the thing").first()).toBeVisible({ timeout: 90_000 });

    const row = page.getByRole("tablist", { name: "Panels" });
    const todo = row.getByRole("tab", { name: "Todo checklist" });
    const context = row.getByRole("tab", { name: "Context" });
    const agents = row.getByRole("tab", { name: "Agents" });
    await expect(todo).toHaveAttribute("aria-selected", "true");
    await expect(todo).toHaveAttribute("tabindex", "0");
    await expect(context).toHaveAttribute("tabindex", "-1");
    await expect(agents).toHaveAttribute("tabindex", "-1");

    await todo.focus();
    await page.keyboard.press("ArrowRight");
    await expect(context).toBeFocused();
    await expect(context).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel", { name: "Context" })).toBeVisible();
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-851-panel-tabs-context-light.png"),
      fullPage: true,
    });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-851-panel-tabs-context-dark.png"),
      fullPage: true,
    });

    await page.keyboard.press("ArrowRight");
    await expect(agents).toBeFocused();
    await expect(page.getByRole("region", { name: "Agent Hub" })).toBeVisible();

    await page.keyboard.press("ArrowRight");
    await expect(todo).toBeFocused();
    await expect(page.getByText("Write the thing").first()).toBeVisible();

    await page.keyboard.press("End");
    await expect(agents).toBeFocused();
    await page.keyboard.press("Home");
    await expect(todo).toBeFocused();

    // One Tab stop for the row: Tab leaves the row for the panel's content, not for the other tabs.
    await page.keyboard.press("Tab");
    await expect(context).not.toBeFocused();
    await expect(agents).not.toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Show Panels sidebar" }).click();
    await expect(row).toBeVisible();
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-851-panel-tabs-390.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);
