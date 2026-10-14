import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { z } from "zod";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

/**
 * #1382: removing an attached image while the server refuses to delete it did nothing and said nothing. The chip now
 * says the image could not be removed and stays, so the person can try again. The refusal is made here by answering the
 * blob store's delete call with an error; the next try goes through.
 */

const ATTACHMENTS = '[data-slot="u2-composer-attachments"]';
const IMAGE = "photo-1382.png";
const REMOVE_FAILED = `${IMAGE} could not be removed. Try again.`;
const BLOB_PORT = "A1.attachmentStore";
const DESKTOP = { width: 1280, height: 900 } as const;
const PHONE = { width: 390, height: 844 } as const;
/** A one-pixel PNG, so the dropped file is a real image. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/** A websocket frame the test reads: the call or result it needs, with the rest passed through. */
const WireFrame = z
  .object({
    type: z.string(),
    id: z.union([z.string(), z.number()]).optional(),
    port: z.string().optional(),
    method: z.string().optional(),
  })
  .passthrough();

function parseWireFrame(message: string | Buffer): z.infer<typeof WireFrame> | null {
  try {
    const parsed = WireFrame.safeParse(JSON.parse(String(message)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Answers the blob store's delete calls with the server's refusal while `refusing.on` is set. Every other frame passes
 * through unchanged, so the chat itself works as usual.
 */
function refuseDeletes(openedPage: Page, refusing: { on: boolean }): Promise<void> {
  return openedPage.routeWebSocket(
    () => true,
    (webSocket) => {
      const server = webSocket.connectToServer();
      webSocket.onMessage((message) => {
        const frame = parseWireFrame(message);
        if (
          refusing.on &&
          frame !== null &&
          frame.type === "call" &&
          frame.port === BLOB_PORT &&
          frame.method === "delete"
        ) {
          webSocket.send(
            JSON.stringify({
              type: "result",
              id: frame.id,
              ok: false,
              error: {
                code: "unavailable",
                message: "The server could not remove the image.",
                retryable: true,
              },
            }),
          );
          return;
        }
        server.send(message);
      });
      server.onMessage((message) => webSocket.send(message));
    },
  );
}

/** Sets the app's theme before its first paint, as the other specs do. */
async function setTheme(openedPage: Page, theme: "light" | "dark"): Promise<void> {
  await openedPage.addInitScript(
    (value: string) => window.localStorage.setItem("omp-app.theme", value),
    theme,
  );
}

/** Drops one picture onto the composer, as a person drops a file. No text is typed. */
async function dispatchImageDrop(target: Locator): Promise<void> {
  await target.evaluate(
    (input, { name, base64 }) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File([bytes], name, { type: "image/png" }));
      input.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
    },
    { name: IMAGE, base64: PNG_BASE64 },
  );
}

function removeButton(page: Page): Locator {
  return page.getByRole("button", { name: `Remove ${IMAGE}`, exact: true });
}

/** Drops the picture, then asks to remove it while the server refuses. The chip and the message must stay. */
async function removeWhileRefused(page: Page, refusing: { on: boolean }): Promise<void> {
  const composer = await startChat(page);
  await dispatchImageDrop(composer);
  await expect(page.locator(ATTACHMENTS)).toContainText(IMAGE, { timeout: 30_000 });

  refusing.on = true;
  await removeButton(page).click();
  await expect(page.getByText(REMOVE_FAILED, { exact: true })).toBeVisible({ timeout: 30_000 });
  // The chip stays, so the person can try again.
  await expect(page.locator(ATTACHMENTS)).toContainText(IMAGE);
}

/** The next try goes through: the chip and the message are gone. */
async function retryRemoval(page: Page, refusing: { on: boolean }): Promise<void> {
  refusing.on = false;
  await removeButton(page).click();
  await expect(removeButton(page)).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByText(REMOVE_FAILED, { exact: true })).toHaveCount(0);
}

realTest(
  "#1382: a refused image removal says so, keeps the chip, and the next try removes it (light, 390 px)",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const refusing = { on: false };
    const page = await realApp.open({
      beforeLoad: async (openedPage) => {
        await setTheme(openedPage, "light");
        await refuseDeletes(openedPage, refusing);
      },
    });
    await page.setViewportSize(DESKTOP);
    await removeWhileRefused(page, refusing);
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await waitForFiniteAnimations(page);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "fix-1382-remove-failed-light.png") });

    await page.setViewportSize(PHONE);
    await expect(page.getByText(REMOVE_FAILED, { exact: true })).toBeVisible();
    const sideways = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(sideways, "no sideways scroll at 390 px").toBe(false);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1382-remove-failed-phone.png") });

    await retryRemoval(page, refusing);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#1382: a refused image removal says so, keeps the chip, and the next try removes it (dark)",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const refusing = { on: false };
    const page = await realApp.open({
      beforeLoad: async (openedPage) => {
        await setTheme(openedPage, "dark");
        await refuseDeletes(openedPage, refusing);
      },
    });
    await page.setViewportSize(DESKTOP);
    await expect(page.locator("html")).toHaveClass(/dark/);
    await removeWhileRefused(page, refusing);
    await waitForFiniteAnimations(page);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "fix-1382-remove-failed-dark.png") });

    await retryRemoval(page, refusing);
    expect(realApp.problems).toEqual([]);
  },
);
