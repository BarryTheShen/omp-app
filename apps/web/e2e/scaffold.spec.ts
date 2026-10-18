import { expect, test } from "@playwright/test";

test("loads the production shell without console errors", async ({ page }) => {
  const consoleErrors: string[] = [];
  const failedResources: string[] = [];
  const pageErrors: string[] = [];

  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(`${message.text()} (${message.location().url || "unknown source"})`);
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      failedResources.push(`${response.status()} ${response.url()}`);
    }
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  await page.goto("/");

  await expect(page).toHaveTitle("omp");
  await expect(page.getByRole("heading", { name: "Start omp-app to connect" })).toBeVisible();
  await page.screenshot({
    path: "../../.data/screenshots/u0-1-light.png",
    fullPage: true,
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({
    path: "../../.data/screenshots/u0-1-dark.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "../../.data/screenshots/u0-1-narrow.png",
    fullPage: true,
  });
  expect(failedResources).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
