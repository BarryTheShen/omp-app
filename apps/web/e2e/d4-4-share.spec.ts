import { dirname, join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";
import {
  expectShareQuestion,
  makeTestCertificate,
  pointOmpAtStub,
  SHARE_LINK_ID,
  sendTyped,
  startShareStub,
  TLS_CERT_FILE,
} from "./share-stub";

// omp and the app server it runs under read NODE_EXTRA_CA_CERTS when they start. The fixture starts them before a
// test body runs, so the test certificate is made and trusted here, when this file loads.
makeTestCertificate();
process.env.NODE_EXTRA_CA_CERTS = TLS_CERT_FILE;

const RESULT = "Share link ready";
const COPIED = "Share link copied. Anyone with the link can read this chat.";

/** The shell draws with the app's own background: a transparent one means no styles loaded. */
async function expectStylesLoaded(page: Page): Promise<void> {
  const background = await page
    .locator("[data-shell-layout]")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth);
}

realTest(
  "#386: the palette command asks first, names where the chat goes, and uploads nothing when denied",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const stub = await startShareStub({ tls: true });
    try {
      await pointOmpAtStub(dirname(realApp.mcpConfigPath), stub.url);
      const page = await realApp.open({
        beforeLoad: (target) =>
          target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
      });
      await startChat(page);
      await page.keyboard.press("Control+k");
      await page.getByRole("combobox", { name: "Search commands" }).fill("share");
      const command = page.getByRole("option", { name: "Share this chat" });
      await expect(command).toBeVisible();
      await expectStylesLoaded(page);
      await waitForFiniteAnimations(page);
      await page.screenshot({ path: join(screenshots, "d4-4-share-palette-light.png") });
      await command.click();

      await expectShareQuestion(page, stub.url);
      expect(stub.requests).toEqual([]);
      await expectStylesLoaded(page);
      await waitForFiniteAnimations(page);
      await page.screenshot({ path: join(screenshots, "d4-4-share-question-light.png") });
      await page.setViewportSize({ width: 390, height: 844 });
      await expectShareQuestion(page, stub.url);
      await expectNoHorizontalOverflow(page);
      await waitForFiniteAnimations(page);
      await page.screenshot({ path: join(screenshots, "d4-4-share-question-narrow.png") });
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(page.getByText("Nothing was shared.", { exact: true })).toBeVisible();
      expect(stub.requests).toEqual([]);
      expect(realApp.problems).toEqual([]);
    } finally {
      await stub.close();
    }
  },
);

realTest(
  "#386: typed /share asks, uploads once after Confirm, and copies the link",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const stub = await startShareStub({ tls: true });
    try {
      await pointOmpAtStub(dirname(realApp.mcpConfigPath), stub.url);
      const page = await realApp.open({
        beforeLoad: (target) =>
          target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
      });
      const composer = await startChat(page);
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: new URL(page.url()).origin,
      });
      await sendTyped(page, composer, "/share");
      await expectShareQuestion(page, stub.url);
      expect(stub.requests).toEqual([]);
      await page.getByRole("button", { name: "Confirm", exact: true }).click();

      const result = page.getByRole("listbox", { name: RESULT });
      await expect(result).toBeVisible({ timeout: 120_000 });
      expect(stub.requests).toEqual(["POST /s"]);
      await expect(result).toContainText(`${stub.url}/${SHARE_LINK_ID}`);
      await expect(page.getByText("Share URL:")).toHaveCount(0);
      await waitForFiniteAnimations(page);
      await page.screenshot({ path: join(screenshots, "d4-4-share-result-light.png") });

      await result.getByRole("option", { name: "Copy the link" }).click();
      await page.getByRole("button", { name: "Choose", exact: true }).click();
      await expect(page.getByText(COPIED, { exact: true })).toBeVisible();
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      expect(copied.startsWith(`${stub.url}/${SHARE_LINK_ID}#`)).toBe(true);
      expect(stub.requests).toEqual(["POST /s"]);
      expect(realApp.problems).toEqual([]);
    } finally {
      await stub.close();
    }
  },
);

realTest(
  "#386: the question reads the same in dark theme, and still uploads nothing",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const stub = await startShareStub({ tls: true });
    try {
      await pointOmpAtStub(dirname(realApp.mcpConfigPath), stub.url);
      const page = await realApp.open({
        beforeLoad: (target) =>
          target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
      });
      await expect(page.locator("html")).toHaveClass(/dark/);
      const composer = await startChat(page);
      await sendTyped(page, composer, "/share");
      await expectShareQuestion(page, stub.url);
      await expectStylesLoaded(page);
      await waitForFiniteAnimations(page);
      await page.screenshot({ path: join(screenshots, "d4-4-share-question-dark.png") });
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(page.getByText("Nothing was shared.", { exact: true })).toBeVisible();
      expect(stub.requests).toEqual([]);
      expect(realApp.problems).toEqual([]);
    } finally {
      await stub.close();
    }
  },
);
