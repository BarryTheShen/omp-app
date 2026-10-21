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

const START_OFFER = "Start a chat to sign in";

/** Opens Settings from the header and selects its Providers tab. */
async function openProvidersTab(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("settings-screen");
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Providers", exact: true }).click();
}

/** Ctrl+K opens the command palette; typing a command's name and Enter run its first match. */
async function runFromPalette(page: Page, query: string): Promise<void> {
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  await page.keyboard.type(query);
  await page.keyboard.press("Enter");
}

/** Sign-in is open and lists omp's providers; the test environment's Anthropic key is signed in. */
async function expectSignInOpen(page: Page): Promise<void> {
  await expect(page.getByText("Provider login").first()).toBeVisible({ timeout: 60_000 });
  const providerList = page.getByTestId("d3-provider-list");
  // The list follows the chat's start, which waits for omp's first answers. A loaded machine can take longer than the
  // default 5 s (issue 2275). The wait still ends on the row, so a real hang fails, at 30 s.
  await expect(providerList.getByRole("listitem").filter({ hasText: "Anthropic" })).toBeVisible({
    timeout: 30_000,
  });
}

realTest(
  "#962: with no chat open, Settings > Providers offers to start one, and sign-in opens in the new chat",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    await openProvidersTab(page);
    await expect(page.getByRole("button", { name: START_OFFER, exact: true })).toBeVisible();
    await expect(page.getByText("Open a chat to sign in to a provider.")).toHaveCount(0);
    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-962-providers-light.png"),
      fullPage: true,
    });

    await page.getByRole("button", { name: START_OFFER, exact: true }).click();
    await expectSignInOpen(page);
    // The sign-in dialog is over the new chat, so the composer is reachable once the dialog closes.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("textbox", { name: "Message input" })).toBeVisible();
  },
);

realTest(
  "#962: the Providers start offer reads in dark and at 390 px",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await openProvidersTab(page);
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.getByRole("button", { name: START_OFFER, exact: true })).toBeVisible();
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-962-providers-dark.png"),
      fullPage: true,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("button", { name: START_OFFER, exact: true })).toBeVisible();
    const settingsBox = await page.getByTestId("settings-screen").boundingBox();
    expect((settingsBox?.x ?? 0) + (settingsBox?.width ?? 0)).toBeLessThanOrEqual(390);
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-962-providers-narrow.png"),
      fullPage: true,
    });
  },
);

realTest(
  "#962: the palette's Provider login opens sign-in in the open chat",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "pong");
    await expect(page.getByText("pong").first()).toBeVisible({ timeout: 60_000 });

    await runFromPalette(page, "provider login");
    await expectSignInOpen(page);
    await expect(page.getByRole("button", { name: START_OFFER, exact: true })).toHaveCount(0);
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-962-palette-light.png"),
      fullPage: true,
    });
  },
);
