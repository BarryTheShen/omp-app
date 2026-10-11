import { join } from "node:path";
import { expect, realTest, screenshots } from "./real-omp";

/**
 * A first-run person: omp has no model and no key. "New chat" must say why, in plain words, and what to do
 * next, and "RPC transport" must not appear on screen. Captured in light, in dark, and at 390 px wide.
 */
realTest.use({ noModel: true });

const PLAIN_WORDS = /omp stopped because no model is set up\. Open a terminal, run `omp`/;

for (const variant of ["light", "dark", "narrow"] as const) {
  realTest(
    `New chat with no model says why and what to do, in plain words (${variant})`,
    async ({ realApp }) => {
      const theme = variant === "dark" ? "dark" : "light";
      const page = await realApp.open({
        beforeLoad: (page) =>
          page.addInitScript((value) => window.localStorage.setItem("omp-app.theme", value), theme),
      });
      await page.getByRole("button", { name: "New chat" }).first().click();
      await expect(page.getByText(PLAIN_WORDS)).toBeVisible({ timeout: 60_000 });
      if (variant === "narrow") await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByText("RPC transport")).toHaveCount(0);
      await expect(page.getByText("Open a session to start composing.")).toBeVisible();
      await page.screenshot({
        path: join(screenshots, `chat-no-model-${variant}.png`),
        fullPage: true,
      });
    },
  );
}
