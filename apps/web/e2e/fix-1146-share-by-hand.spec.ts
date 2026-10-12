import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";
import {
  expectShareQuestion,
  makeTestCertificate,
  pointOmpAtStub,
  SHARE_LINK_ID,
  startShareStub,
  TLS_CERT_FILE,
} from "./share-stub";

// omp and the app server it runs under read NODE_EXTRA_CA_CERTS when they start. The fixture starts them before a
// test body runs, so the test certificate is made and trusted here, when this file loads.
makeTestCertificate();
process.env.NODE_EXTRA_CA_CERTS = TLS_CERT_FILE;

const RESULT = "Share link ready";
const BY_HAND = "Copy this link by hand";
const SHOWN = "Share link shown so you can copy it by hand.";

/** The shell draws with the app's own background: a transparent one means no styles loaded. */
async function expectStylesLoaded(page: Page): Promise<void> {
  const background = await page
    .locator("[data-shell-layout]")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
}

/** A long link must not push the link or Done outside the dialog: a person cannot press a button that is off it. */
async function expectInsideDialog(dialog: Locator, link: Locator, done: Locator): Promise<void> {
  const frame = await dialog.boundingBox();
  const linkBox = await link.boundingBox();
  const doneBox = await done.boundingBox();
  const right = (box: { x: number; width: number } | null) =>
    Math.round((box?.x ?? 0) + (box?.width ?? 0));
  expect(right(linkBox), "the link ends inside the dialog").toBeLessThanOrEqual(right(frame));
  expect(right(doneBox), "Done ends inside the dialog").toBeLessThanOrEqual(right(frame));
  expect(Math.round(doneBox?.x ?? 0), "Done starts inside the dialog").toBeGreaterThanOrEqual(
    Math.round(frame?.x ?? 0),
  );
}

/**
 * #1146. When the browser refuses the clipboard, the share link is shown to copy by hand. That view is read-only and
 * offers only Done: nothing it shows is saved, so it must not offer Save or say that Ctrl/Cmd+Enter saves. Real omp,
 * with the share upload going to a local stub, so the link is a real https link.
 */
realTest(
  "#1146: a refused clipboard shows the share link read-only, with only Done and no save hint",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const stub = await startShareStub({ tls: true });
    try {
      await pointOmpAtStub(dirname(realApp.mcpConfigPath), stub.url);
      const page = await realApp.open({
        beforeLoad: (target) =>
          target.addInitScript(() => {
            window.localStorage.setItem("omp-app.theme", "light");
            // The browser refuses every write, the way it does when the person has not allowed clipboard access.
            Object.defineProperty(navigator.clipboard, "writeText", {
              configurable: true,
              value: () =>
                Promise.reject(
                  new DOMException("The clipboard refused the write.", "NotAllowedError"),
                ),
            });
          }),
      });
      await startChat(page);
      await page.keyboard.press("Control+k");
      await page.getByRole("combobox", { name: "Search commands" }).fill("share");
      await page.getByRole("option", { name: "Share this chat" }).click();
      await expectShareQuestion(page, stub.url);
      expect(stub.requests).toEqual([]);
      await page.getByRole("button", { name: "Confirm", exact: true }).click();

      const result = page.getByRole("listbox", { name: RESULT });
      await expect(result).toBeVisible({ timeout: 120_000 });
      expect(stub.requests).toEqual(["POST /s"]);
      await result.getByRole("option", { name: "Copy the link" }).click();
      await page.getByRole("button", { name: "Choose", exact: true }).click();

      // The clipboard refused, so the link is shown to copy by hand: read-only, with Done as its only button.
      const byHand = page.getByRole("textbox", { name: BY_HAND });
      // omp's link carries a key after `#`, so the check takes the id and that fragment's start.
      expect((await byHand.inputValue()).startsWith(`${stub.url}/${SHARE_LINK_ID}#`)).toBe(true);
      await expect(byHand).toBeEditable({ editable: false });
      const dialog = page.getByRole("dialog").filter({ has: byHand });
      await expect(dialog.getByRole("button", { name: "Done", exact: true })).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
      await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
      await expect(dialog.getByText("saves")).toHaveCount(0);

      await expectInsideDialog(
        dialog,
        byHand,
        dialog.getByRole("button", { name: "Done", exact: true }),
      );

      await mkdir(screenshots, { recursive: true });
      await expectStylesLoaded(page);
      await waitForFiniteAnimations(page);
      await page.screenshot({
        path: join(screenshots, "fix-1146-by-hand-light.png"),
        fullPage: true,
      });
      await page.evaluate(() => document.documentElement.classList.add("dark"));
      await expect(page.locator("html")).toHaveClass(/dark/);
      await waitForFiniteAnimations(page);
      await page.screenshot({
        path: join(screenshots, "fix-1146-by-hand-dark.png"),
        fullPage: true,
      });
      await page.evaluate(() => document.documentElement.classList.remove("dark"));
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(byHand).toBeVisible();
      await expectInsideDialog(
        dialog,
        byHand,
        dialog.getByRole("button", { name: "Done", exact: true }),
      );
      await waitForFiniteAnimations(page);
      await page.screenshot({
        path: join(screenshots, "fix-1146-by-hand-narrow.png"),
        fullPage: true,
      });

      // Done closes the view, and the chat says what happened: the link was shown, not copied.
      await dialog.getByRole("button", { name: "Done", exact: true }).click();
      await expect(byHand).toHaveCount(0);
      await expect(page.getByText(SHOWN, { exact: true })).toBeVisible();
      expect(stub.requests).toEqual(["POST /s"]);
      expect(realApp.problems).toEqual([]);
    } finally {
      await stub.close();
    }
  },
);
