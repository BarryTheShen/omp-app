import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

const WIDE = { width: 1771, height: 900 };
const LAPTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

/** Each side's open state as the shell reports it: the attribute the sidebar carries, and what a person sees. */
async function expectSidebars(
  page: Page,
  open: { readonly left: boolean; readonly right: boolean },
) {
  const left = page.locator('[data-shell-sidebar="left"]');
  const right = page.locator('[data-shell-sidebar="right"]');
  await expect(left).toHaveAttribute("data-open", open.left ? "true" : "false");
  await expect(right).toHaveAttribute("data-open", open.right ? "true" : "false");
  if (open.left) await expect(left).toBeVisible();
  else await expect(left).toBeHidden();
  if (open.right) await expect(right).toBeVisible();
  else await expect(right).toBeHidden();
}

/**
 * A fresh load at a wide width shows the Sessions list; the Panels start closed (#2570) until the person opens them.
 * Narrowing closes both, as drawers do. Widening again must bring both back as the person left them, without a reload.
 */
for (const scheme of ["light", "dark"] as const) {
  realTest(
    `the Sessions list and the Panels come back when the window goes narrow and then wide, in ${scheme} theme`,
    async ({ realApp }) => {
      const page = await realApp.open({
        beforeLoad: (target) =>
          target.addInitScript(
            (theme: string) => window.localStorage.setItem("omp-app.theme", theme),
            scheme,
          ),
      });
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });

      await page.setViewportSize(WIDE);
      await expect(page.locator('[data-shell-layout="wide"]')).toHaveCount(1);
      await expectSidebars(page, { left: true, right: false });
      await page.getByRole("button", { name: "Show panels sidebar" }).click();
      await waitForFiniteAnimations(page);
      await expectSidebars(page, { left: true, right: true });

      await page.setViewportSize(PHONE);
      await expect(page.locator('[data-shell-layout="narrow"]')).toHaveCount(1);
      await expectSidebars(page, { left: false, right: false });

      await page.setViewportSize(WIDE);
      await expect(page.locator('[data-shell-layout="wide"]')).toHaveCount(1);
      await waitForFiniteAnimations(page);
      await expectSidebars(page, { left: true, right: true });

      await page.setViewportSize(LAPTOP);
      await waitForFiniteAnimations(page);
      await expectSidebars(page, { left: true, right: true });

      await mkdir(screenshots, { recursive: true });
      await page.screenshot({ path: join(screenshots, `shell-sidebars-wide-${scheme}.png`) });
      await page.setViewportSize(PHONE);
      await waitForFiniteAnimations(page);
      await page.screenshot({ path: join(screenshots, `shell-sidebars-phone-${scheme}.png`) });
    },
  );
}
