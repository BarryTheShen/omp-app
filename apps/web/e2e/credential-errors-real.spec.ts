import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

const NARROW = { width: 390, height: 844 } as const;
/** The fake model answers this keyword with HTTP 401, the way a provider answers a key it refuses. */
const REFUSED_PROMPT = "auth_probe: answer with a refused key";
/** omp's own words for the refusal (the fake provider's message), shown only under "Show details". */
const RAW_WORDS = "Invalid API key";

/** Sends a prompt the fake provider refuses, and waits until the plain-words notice is on screen. */
async function refusedChat(page: Page): Promise<void> {
  const composer = await startChat(page);
  await sendPrompt(composer, REFUSED_PROMPT);
  await expect(page.getByText("The model could not sign in")).toBeVisible({ timeout: 60_000 });
}

realTest(
  "a refused key says what happened in plain words, with a way out; omp's own words sit under Show details",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    await refusedChat(page);

    // The notice is shown once, under the answer that stopped; the banner does not repeat it.
    await expect(page.getByText("The model could not sign in")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Choose another model" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Sign in…" })).toHaveCount(1);
    await expect(page.getByText(/so fake-model could not answer/)).toBeVisible();
    // omp's raw words stay hidden until the person asks for them.
    await expect(page.getByText(RAW_WORDS)).toBeHidden();
    await page.getByText("Show details").click();
    await expect(page.getByText(RAW_WORDS).first()).toBeVisible();

    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-958-refused-light.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "Choose another model lists signed-in providers first with their sign-in shown; Sign in opens provider sign-in",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    await refusedChat(page);

    await page.getByRole("button", { name: "Choose another model" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("textbox", { name: "Search this session" })).toBeVisible();
    // The provider with a key in omp's settings is listed before the one with no sign-in the app can tell.
    const groups = dialog.getByRole("group");
    await expect(groups.first()).toHaveAccessibleName("anthropic");
    await expect(groups.first().getByText("Uses an API key").first()).toBeVisible();
    await expect(dialog.getByRole("group", { name: "fake" })).toBeVisible();
    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-958-models-light.png"), fullPage: true });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    await page.getByRole("button", { name: "Sign in…" }).click();
    const login = page.getByRole("dialog");
    await expect(login.getByRole("heading", { name: "Provider login" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(login).toBeHidden();
    expect(realApp.problems).toEqual([]);
  },
);

realTest("the refused-key notice reads in dark and at 390 px", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(180_000);
  const page = await realApp.open({
    beforeLoad: (target) =>
      target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
  });
  await expect(page.locator("html")).toHaveClass(/dark/);
  await refusedChat(page);
  await waitForFiniteAnimations(page);
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, "fix-958-refused-dark.png"), fullPage: true });

  await page.setViewportSize(NARROW);
  await expect(page.getByRole("button", { name: "Choose another model" })).toBeVisible();
  const fits = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
  expect(fits).toBe(true);
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "fix-958-refused-narrow.png"), fullPage: true });
  expect(realApp.problems).toEqual([]);
});
