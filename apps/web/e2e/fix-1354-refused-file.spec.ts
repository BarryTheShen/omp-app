import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

const KINDS = "Only images, plain text and Markdown files can be attached.";
/** The upload limit, which the composer applies when a picture is added: the same words the upload uses. */
const LIMIT = "Files over 700 KB can't be attached.";
const ONE_MB = 1024 * 1024;
const TWELVE_MB = 12 * ONE_MB;

/** The composer's notice for a file it did not take: the one alert that says it was not attached. */
function refusal(page: Page): Locator {
  return page.getByRole("alert").filter({ hasText: "was not attached" });
}

/** The shell draws with the app's own background: a transparent one means no styles loaded. */
async function expectStylesLoaded(page: Page): Promise<void> {
  const background = await page
    .locator("[data-shell-layout]")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
}

/** A drag carrying one file, built in the page, so the browser's own drop handler runs. */
async function transferWith(page: Page, name: string, type: string, size: number) {
  return page.evaluateHandle(
    ({ name, type, size }) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(size)], name, { type }));
      return transfer;
    },
    { name, type, size },
  );
}

/** A paste of one file into the message box: a paste event built in the page, as a real paste carries the file. */
async function pasteFile(
  composer: Locator,
  name: string,
  type: string,
  size: number,
): Promise<void> {
  await composer.evaluate(
    (element, { name, type, size }) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(size)], name, { type }));
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
      );
    },
    { name, type, size },
  );
}

/** A websocket frame as an object, or undefined for a frame that is not JSON. */
function frameOf(message: string | Buffer): Record<string, unknown> | undefined {
  try {
    return JSON.parse(String(message)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Records every picture upload the app sends, in order, and lets every frame through. */
async function recordUploads(target: Page, uploads: string[]): Promise<void> {
  await target.routeWebSocket(/\/ws/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const frame = frameOf(message);
      if (frame?.type === "call" && frame.port === "A1.attachmentStore" && frame.method === "put") {
        uploads.push(String(frame.id));
      }
      server.send(message);
    });
    server.onMessage((message) => ws.send(message));
  });
}

realTest(
  "#1354: a dropped PDF is named in the composer, with the reason, and is not attached",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await startChat(page);
    const transfer = await transferWith(page, "report.pdf", "application/pdf", 1024);
    await page
      .locator('[data-composer-card="true"]')
      .dispatchEvent("drop", { dataTransfer: transfer });

    await expect(refusal(page)).toHaveText(`report.pdf was not attached. ${KINDS}`);
    await expect(page.getByText("report.pdf", { exact: true })).toHaveCount(0);
    await expectStylesLoaded(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1354-dropped-pdf-light.png") });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(refusal(page)).toHaveText(`report.pdf was not attached. ${KINDS}`);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1354-dropped-pdf-narrow.png") });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#1354: a pasted screenshot of 12 MB is named in the composer, with the limit, and is not attached",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await pasteFile(composer, "screenshot.png", "image/png", TWELVE_MB);

    await expect(refusal(page)).toHaveText(`screenshot.png was not attached. ${LIMIT}`);
    await expect(page.getByText("screenshot.png", { exact: true })).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#1354: a 12 MB image picked with + is named in the composer, with the limit, in dark theme",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await expect(page.locator("html")).toHaveClass(/dark/);
    await startChat(page);
    const big = join(realApp.folder, "big-photo.png");
    await writeFile(big, Buffer.alloc(TWELVE_MB));
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Add attachment" }).click();
    (await chooser).setFiles(big);

    await expect(refusal(page)).toHaveText(`big-photo.png was not attached. ${LIMIT}`);
    await expect(page.getByText("big-photo.png", { exact: true })).toHaveCount(0);
    await expectStylesLoaded(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1354-picked-big-dark.png") });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#1354: a PDF picked with + is named, and the notice goes away once a picture is attached",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    await startChat(page);
    const pdf = join(realApp.folder, "report.pdf");
    await writeFile(pdf, "%PDF-1.4\n");
    const firstChooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Add attachment" }).click();
    (await firstChooser).setFiles(pdf);

    await expect(refusal(page)).toHaveText(`report.pdf was not attached. ${KINDS}`);

    const picture = join(realApp.folder, "ok.png");
    await writeFile(picture, Buffer.from("iVBORw0KGgo=", "base64"));
    const secondChooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Add attachment" }).click();
    (await secondChooser).setFiles(picture);

    await expect(page.getByText("ok.png", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(refusal(page)).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#1354: a picture of about 1 MB is refused at once with the limit: no chip appears and nothing is uploaded",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    await mkdir(screenshots, { recursive: true });
    const uploads: string[] = [];
    const page = await realApp.open({
      beforeLoad: async (target) => {
        await target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light"));
        await recordUploads(target, uploads);
      },
    });
    await startChat(page);
    const picture = join(realApp.folder, "photo-1mb.png");
    await writeFile(picture, Buffer.alloc(ONE_MB));
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Add attachment" }).click();
    (await chooser).setFiles(picture);

    await expect(refusal(page)).toHaveText(`photo-1mb.png was not attached. ${LIMIT}`);
    await expect(page.getByText("photo-1mb.png", { exact: true })).toHaveCount(0);
    expect(uploads).toEqual([]);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1354-picture-1mb-light.png") });
    expect(realApp.problems).toEqual([]);
  },
);
