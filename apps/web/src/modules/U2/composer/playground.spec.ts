import path from "node:path";
import { expect, test } from "@playwright/test";

const screenshots = path.resolve(process.cwd(), "../../.data/screenshots");
const playground = "/src/modules/U2/composer/playground.html";

test.describe("U2.2 ComposerSurface playground", () => {
  test("captures idle, streaming steer hint, and error states", async ({ page }) => {
    await page.goto(playground);
    await expect(page.getByTestId("u2-composer-playground")).toBeVisible();
    await page.screenshot({ path: path.join(screenshots, "u2.2-idle.png"), fullPage: true });

    await page.getByTestId("playground-streaming").click();
    await expect(page.getByText("Enter steers · Ctrl+Enter queues")).toBeVisible();
    await page.screenshot({ path: path.join(screenshots, "u2.2-streaming.png"), fullPage: true });

    await page.getByTestId("playground-error").click();
    const input = page.getByRole("textbox", { name: "Message input" });
    await input.fill("keep this draft");
    await input.press("Enter");
    await expect(page.getByRole("alert")).toHaveText("The playground rejected this prompt");
    await expect(input).toHaveValue("keep this draft");
    await page.screenshot({ path: path.join(screenshots, "u2.2-error.png"), fullPage: true });
  });
});
