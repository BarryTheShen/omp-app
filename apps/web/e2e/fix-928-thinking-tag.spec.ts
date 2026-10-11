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
 * Issue #928. The "Thinking level" card in the model dialog showed the raw word "session" as a grey tag
 * beside its heading. The heading and the description already say the change is for this session, so
 * the card now has no tag at all.
 */
realTest(
  "the thinking level card in the model dialog has no raw 'session' tag",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(150_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    const composer = await startChat(page);
    await sendPrompt(composer, "ping");
    await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });

    // A CSS locator: while the dialog is open the header is hidden from role queries.
    await page.locator('header button[aria-label^="Model:"]').click();
    const dialog = page.getByRole("dialog", { name: "Model and thinking" });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("heading", { name: "Thinking level", exact: true }),
    ).toBeVisible();
    await expect(dialog.getByText("Session reasoning depth", { exact: true })).toBeVisible();
    await expect(dialog.getByText("session", { exact: true })).toHaveCount(0);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-928-thinking-light.png") });

    await page.emulateMedia({ colorScheme: "dark" });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-928-thinking-dark.png") });
    await page.emulateMedia({ colorScheme: "light" });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      dialog.getByRole("heading", { name: "Thinking level", exact: true }),
    ).toBeVisible();
    await expect(dialog.getByText("session", { exact: true })).toHaveCount(0);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-928-thinking-narrow.png") });
    expect(realApp.problems).toEqual([]);
  },
);
