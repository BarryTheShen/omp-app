import { join } from "node:path";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/*
 * Issue 2583. A dialog's full-screen backdrop used to blur the page behind it (backdrop-filter), and the blur was painted
 * again on every frame while the dialog's own content scrolled: on the test machine, a third of the Settings frames ran over 33 ms.
 * The backdrop still dims the page and fades in and out; it no longer blurs. Fails before the fix: the computed filter is a
 * blur.
 */
for (const theme of ["light", "dark"] as const) {
  realTest(
    `the Settings dialog's backdrop dims the page without a blur, in ${theme}`,
    async ({ realApp }) => {
      const page = await realApp.open({
        beforeLoad: (target) =>
          target.addInitScript(
            (value) => window.localStorage.setItem("omp-app.theme", value),
            theme,
          ),
      });
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const overlay = page.locator('[data-slot="dialog-overlay"]');
      await expect(overlay).toBeVisible();
      const filter = await overlay.evaluate((element) => getComputedStyle(element).backdropFilter);
      expect(filter).toBe("none");
      await waitForFiniteAnimations(page);
      await page.screenshot({ path: join(screenshots, `fix-2583-dialog-backdrop-${theme}.png`) });
    },
  );
}
