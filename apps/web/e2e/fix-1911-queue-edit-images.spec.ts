import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

const RUN = "stream_long_code please";
const IMAGE_NAME = "queue-image.png";
const RESTORED_IMAGE = /queued-image-1\.(?:png|webp)/;
const WITH_IMAGE = "queued picture";
const TEXT_ONLY = "queued words only";
const IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const ATTACHMENTS = '[data-slot="u2-composer-attachments"]';
const CHIP = { timeout: 30_000 } as const;

realTest.setTimeout(420_000);

function afterThisTurn(page: Page): Locator {
  return page
    .getByRole("complementary", { name: "Queued messages" })
    .getByRole("region", { name: "After this turn" });
}
async function expectStyledShell(page: Page): Promise<void> {
  const background = await page
    .locator("[data-shell-layout]")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
}

async function startLongRun(page: Page): Promise<Locator> {
  const box = await startChat(page);
  await sendPrompt(box, RUN);
  const stop = page.getByRole("button", { name: "Stop generating" });
  await expect(stop).toBeVisible({ timeout: 120_000 });
  return box;
}

async function dropImage(box: Locator): Promise<void> {
  await box.evaluate(
    (input, { name, base64 }) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File([bytes], name, { type: "image/png" }));
      input.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
    },
    { name: IMAGE_NAME, base64: IMAGE_BASE64 },
  );
}

async function queueImageAndRestore(page: Page, box: Locator): Promise<void> {
  await dropImage(box);
  await expect(page.getByRole("button", { name: `Remove ${IMAGE_NAME}` })).toBeVisible(CHIP);
  await box.fill(WITH_IMAGE);
  await box.press("Control+Enter");
  await expect(afterThisTurn(page).getByText(WITH_IMAGE, { exact: true })).toBeVisible();
  await expect(box).toHaveValue("");
  await box.press("Alt+ArrowUp");
  await expect(box).toHaveValue(WITH_IMAGE);
  await expect(page.locator(ATTACHMENTS)).toContainText(RESTORED_IMAGE, CHIP);
  await expect(afterThisTurn(page).getByText(WITH_IMAGE, { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("Brought the last queued message back into the message box.", { exact: true }),
  ).toBeVisible();
}

realTest(
  "Alt+Up restores a queued image with its text in light, and at 390 px",
  async ({ realApp }) => {
    const page = await realApp.open();
    const box = await startLongRun(page);
    await queueImageAndRestore(page, box);
    await waitForFiniteAnimations(page);
    await expectStyledShell(page);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({
      path: join(screenshots, "fix-1911-queue-image-light.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    await expectStyledShell(page);
    await page.screenshot({
      path: join(screenshots, "fix-1911-queue-image-narrow.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);

realTest("Alt+Up restores a queued image with its text in dark theme", async ({ realApp }) => {
  const page = await realApp.open({
    beforeLoad: (openPage) =>
      openPage.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
  });
  const box = await startLongRun(page);
  await queueImageAndRestore(page, box);
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  await waitForFiniteAnimations(page);
  await expectStyledShell(page);
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({
    path: join(screenshots, "fix-1911-queue-image-dark.png"),
    fullPage: true,
  });
  expect(realApp.problems).toEqual([]);
});

realTest("Alt+Up still restores a text-only queued message", async ({ realApp }) => {
  const page = await realApp.open();
  const box = await startLongRun(page);
  await box.fill(TEXT_ONLY);
  await box.press("Control+Enter");
  await expect(afterThisTurn(page).getByText(TEXT_ONLY, { exact: true })).toBeVisible();
  await box.press("Alt+ArrowUp");
  await expect(box).toHaveValue(TEXT_ONLY);
  await expect(afterThisTurn(page).getByText(TEXT_ONLY, { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("Brought the last queued message back into the message box.", { exact: true }),
  ).toBeVisible();
  expect(realApp.problems).toEqual([]);
});
