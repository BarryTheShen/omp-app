import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  expect,
  narrowTo,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

const CHAT = "DELETE-OPEN-UNIQUE";

realTest.setTimeout(180_000);

realTest(
  "deleting the open chat clears its transcript and editing controls",
  async ({ realApp }) => {
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await startChat(page);
    await sendPrompt(composer, `Reply with exactly: ${CHAT}`);
    await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });

    const row = page.getByRole("option", { name: new RegExp(CHAT) });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.hover();
    await page.getByRole("button", { name: /More actions for/ }).click();
    await page
      .getByRole("menu")
      .getByRole("menuitem", { name: /^Delete (?!and stop)/ })
      .click();
    await page
      .getByRole("dialog", { name: "Delete chat" })
      .getByRole("button", { name: "Delete", exact: true })
      .click();

    await expect(row).toHaveCount(0, { timeout: 30_000 });
    const closedHeading = page.getByRole("heading", { name: "New conversation" });
    await expect(closedHeading).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("Ready when you are")).toBeVisible();
    await expect(
      page.getByText("Choose a workspace folder and start a new session."),
    ).toBeVisible();
    await expect(page.getByText("Open a session to start composing.")).toBeVisible();
    await expect(page.getByText(CHAT, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Message input" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Edit message/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Regenerate/i })).toHaveCount(0);
    const lightBackground = await page
      .locator("[data-shell-layout]")
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(lightBackground).not.toBe("rgba(0, 0, 0, 0)");
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-2105-delete-open-light.png"),
      fullPage: true,
    });
    await page.evaluate(() => document.documentElement.classList.add("dark"));

    expect(page.locator("html")).toHaveClass(/dark/);
    const darkBackground = await page
      .locator("[data-shell-layout]")
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(darkBackground).not.toBe("rgba(0, 0, 0, 0)");
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-2105-delete-open-dark.png"),
      fullPage: true,
    });

    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await narrowTo(page);
    await expect(closedHeading).toBeVisible();
    const narrowBackground = await page
      .locator("[data-shell-layout]")
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(narrowBackground).not.toBe("rgba(0, 0, 0, 0)");
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-2105-delete-open-390.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);
