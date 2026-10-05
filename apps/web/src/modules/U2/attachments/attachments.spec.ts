import path from "node:path";
import { expect, test } from "@playwright/test";

const screenshots = path.resolve(process.cwd(), "../../.data/screenshots");
const playground = "/src/modules/U2/attachments/playground.html";

test.describe("U2.3 attachments playground", () => {
  test("captures chips, large-paste choice, error, and computed styles", async ({ page }) => {
    await page.goto(playground);
    await expect(page.getByTestId("u2-attachments-playground")).toBeVisible();

    const largeText = `${"line\n".repeat(99)}last`;
    await page.getByTestId("large-paste-input").fill(largeText);
    await expect(page.getByTestId("large-paste-choice")).toBeVisible();
    await page.screenshot({
      path: path.join(screenshots, "u2.3-large-paste-choice.png"),
      fullPage: true,
    });
    await page.getByTestId("large-paste-attach").click();
    await expect(page.getByTestId("large-paste-result")).toHaveText("attachment");
    const chip = page
      .locator('[data-slot="u2-composer-attachments"] [data-slot="attachment-root"]')
      .first();
    await expect(chip).toBeVisible();
    const styles = await chip.evaluate((element) => {
      const computed = getComputedStyle(element);
      return { borderRadius: computed.borderRadius, boxShadow: computed.boxShadow };
    });
    expect(styles.borderRadius).not.toBe("0px");
    expect(styles.boxShadow).not.toBe("none");
    await page.screenshot({ path: path.join(screenshots, "u2.3-chips.png"), fullPage: true });

    await page.getByTestId("large-paste-input").fill("");
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles({
      name: "too-large.txt",
      mimeType: "text/plain",
      buffer: Buffer.alloc(2048, "x"),
    });
    await expect(page.getByRole("alert")).toContainText("limit");
    await page.screenshot({ path: path.join(screenshots, "u2.3-error.png"), fullPage: true });
  });
});
