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
/** The fake model answers this keyword with HTTP 400, the way a provider rejects a request. */
const FAILING_PROMPT = "fail_probe_child please";
/** omp's words for the failure: the fake provider's own message. */
const PROVIDER_WORDS = "fake provider failure for the failing subagent";

realTest(
  "a provider 400 is said under the answer that failed; the banner keeps its heading, not omp's words",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, FAILING_PROMPT);

    const banner = page.locator('[data-slot="u1-thread-error"]');
    await expect(banner).toBeVisible({ timeout: 120_000 });
    await expect(banner.getByText("The conversation could not continue.")).toBeVisible();
    // The banner does not repeat omp's words: the answer that stopped already says them.
    await expect(banner.getByText(PROVIDER_WORDS)).toHaveCount(0);

    // The error is under the failing answer, once, in plain words; omp's local request-log path never reaches the browser.
    const ending = page.locator('[data-ending="error"]');
    await expect(ending).toHaveCount(1);
    await expect(ending).toContainText(PROVIDER_WORDS, { timeout: 120_000 });
    await expect(ending).toContainText("The model stopped with an error");
    const sentence = (await ending.textContent()) ?? "";
    expect(sentence.split(PROVIDER_WORDS).length).toBe(2);
    expect(sentence).not.toContain("raw-http-request=");
    expect(sentence).not.toContain("http-400-requests");

    // The composer still sends after the error.
    await sendPrompt(composer, "hello after the error");
    await expect(page.getByText("hello after the error")).toBeVisible();
    // The conversation went on; the banner still does not repeat the failed answer's words.
    await expect(banner.getByText(PROVIDER_WORDS)).toHaveCount(0);

    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-826-provider-error-light.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);

realTest("the provider error reads in dark and at 390 px", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(180_000);
  const page = await realApp.open({
    beforeLoad: (target) =>
      target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
  });
  await expect(page.locator("html")).toHaveClass(/dark/);
  const composer = await startChat(page);
  await sendPrompt(composer, FAILING_PROMPT);
  await expect(page.locator('[data-ending="error"]')).toContainText(PROVIDER_WORDS, {
    timeout: 120_000,
  });
  await waitForFiniteAnimations(page);
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({
    path: join(screenshots, "fix-826-provider-error-dark.png"),
    fullPage: true,
  });

  await page.setViewportSize(NARROW);
  await expect(page.locator('[data-ending="error"]')).toBeVisible();
  const fits = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
  expect(fits).toBe(true);
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(screenshots, "fix-826-provider-error-narrow.png"),
    fullPage: true,
  });
  expect(realApp.problems).toEqual([]);
});
