import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

const NARROW = { width: 390, height: 844 } as const;
/** The fake model answers this keyword with a reply that holds the three kinds of link the spec reads. */
const PROMPT = "link_probe please";

realTest(
  "a link shows once: its address is a tooltip, a bare URL shows once, and a link to another host keeps its address",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, PROMPT);

    const plain = page.getByRole("link", { name: "link to example" });
    await expect(plain).toBeVisible({ timeout: 60_000 });
    await expect(plain).toHaveAttribute("href", "https://example.com/page");
    await expect(plain).toHaveAttribute("title", "https://example.com/page");
    await expect(page.getByRole("link", { name: "https://example.org" })).toHaveCount(1);
    // Only the link whose text names another host shows its address next to the text.
    await expect(page.locator("[data-link-destination]")).toHaveCount(1);
    await expect(page.locator("[data-link-destination]")).toHaveText("(https://evil.test/login)");
    await expect(page.getByText("(https://example.com/page)")).toHaveCount(0);
    await expect(page.getByText("(https://example.org)")).toHaveCount(0);

    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-825-link-address-light.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);

realTest("the link reply reads in dark and at 390 px", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(180_000);
  const page = await realApp.open({
    beforeLoad: (target) =>
      target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
  });
  await expect(page.locator("html")).toHaveClass(/dark/);
  const composer = await startChat(page);
  await sendPrompt(composer, PROMPT);
  await expect(page.getByRole("link", { name: "link to example" })).toBeVisible({
    timeout: 60_000,
  });
  await waitForFiniteAnimations(page);
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({
    path: join(screenshots, "fix-825-link-address-dark.png"),
    fullPage: true,
  });

  await page.setViewportSize(NARROW);
  await expect(page.getByRole("link", { name: "link to example" })).toBeVisible();
  const fits = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
  expect(fits).toBe(true);
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(screenshots, "fix-825-link-address-narrow.png"),
    fullPage: true,
  });
  expect(realApp.problems).toEqual([]);
});
