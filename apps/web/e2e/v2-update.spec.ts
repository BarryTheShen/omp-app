import { expect, realTest } from "./real-omp";

/**
 * An open page learns that the app was updated (#2787): a release or a UI deploy serves another build, while the page
 * keeps running its own until it reloads, and the server's answers can stop fitting it. Once the page is shown again
 * and the served page names another build, a banner offers Reload; while the served build is its own, nothing shows.
 */
realTest(
  "a page offers Reload once the app serves another build than the one it runs",
  async ({ realApp }) => {
    const page = await realApp.open({ path: "/" });
    await expect(page.locator("[data-app-root='true']")).toBeVisible({ timeout: 30_000 });
    const banner = page.getByRole("status").filter({ hasText: "The app was updated" });

    // Shown again while the same build is served: no banner.
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForTimeout(1_000);
    await expect(banner).toHaveCount(0);

    // The app serves another build now; the page asks once it is shown again.
    await page.route("**/", async (route) => {
      if (route.request().resourceType() !== "fetch") return route.fallback();
      const served = await route.fetch();
      const html = (await served.text()).replace(
        /\/assets\/index-[A-Za-z0-9_-]+\.js/,
        "/assets/index-AnotherBuild.js",
      );
      return route.fulfill({ response: served, body: html });
    });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner.getByRole("button", { name: "Reload" })).toBeVisible();
    expect(realApp.problems).toEqual([]);
  },
);
