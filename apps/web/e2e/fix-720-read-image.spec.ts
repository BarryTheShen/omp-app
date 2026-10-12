import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import type { Page } from "@playwright/test";
import {
  expect,
  openAllToolCards,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/*
 * Issue 720: a read of a picture must show the picture. The fake vision model lets omp return the picture
 * in the read result. The picture is written to the workspace as a noisy PNG, too large for omp to keep
 * inline, so omp saves it beside the chat as a blob. The reload then shows that the history carries the
 * picture back, not only the live result.
 */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBytes = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, crc]);
}

/** A width by height PNG of pseudo-random pixels: too noisy to shrink, so omp saves it beside the chat. */
function noisePng(width: number, height: number): Buffer {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  let seed = 12345;
  for (let index = 0; index < raw.length; index++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    raw[index] = seed & 0xff;
  }
  for (let row = 0; row < height; row++) raw[row * stride] = 0;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Picks the fake vision model in the header's dialog, so that omp returns a picture in a read. */
async function useVisionModel(page: Page): Promise<void> {
  await page.locator('header button[aria-label^="Model:"]').click();
  const dialog = page.getByRole("dialog", { name: "Model and thinking" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /fake\/fake-vision ·/ }).click();
  await expect(dialog.getByText("Active: fake/fake-vision")).toBeVisible({ timeout: 20_000 });
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toHaveCount(0);
}

const pictureOf = (page: Page) => page.locator('[data-slot="tool-result-image"] img');

for (const variant of ["light", "dark", "narrow"] as const) {
  realTest(
    `a read of a picture is drawn live and again after a reload: ${variant}`,
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(240_000);
      await writeFile(join(realApp.folder, "pixel.png"), noisePng(600, 400));
      const page = await realApp.open();
      const composer = await startChat(page);
      await useVisionModel(page);
      if (variant === "narrow") await page.setViewportSize({ width: 390, height: 844 });
      if (variant === "dark") {
        await page.evaluate(() => document.documentElement.classList.add("dark"));
        await expect(page.locator("html")).toHaveClass(/dark/);
      }
      await sendPrompt(composer, "read_image");

      const picture = pictureOf(page);
      await expect(page.locator('[data-slot="u3-tool-card-trigger"]').first()).toBeVisible({
        timeout: 120_000,
      });
      await openAllToolCards(page);
      await expect(picture).toBeVisible({ timeout: 120_000 });
      await expect
        .poll(() =>
          picture.evaluate(
            (img) => img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0,
          ),
        )
        .toBe(true);
      await expect(
        page.getByText("Read image file [image/", { exact: false }).first(),
      ).toBeVisible();

      // Shown in a box no taller than 16 rem (256 px); a picture taller than that is scaled to fit it.
      const shown = await picture.boundingBox();
      expect(shown?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(256);
      await waitForFiniteAnimations(page);
      await page
        .locator('[data-slot="t1-read-card"]')
        .first()
        .screenshot({ path: join(screenshots, "fix-720-read-image", `${variant}-shown.png`) });

      // The full-size toggle shows the picture at its own pixel width, and a second press puts it back.
      const natural = await picture.evaluate((img) =>
        img instanceof HTMLImageElement ? img.naturalWidth : 0,
      );
      await page.getByRole("button", { name: "Show full size" }).click();
      await expect
        .poll(async () => (await picture.boundingBox())?.width ?? 0)
        .toBeGreaterThanOrEqual(natural - 1);
      await waitForFiniteAnimations(page);
      await page
        .locator('[data-slot="t1-read-card"]')
        .first()
        .screenshot({ path: join(screenshots, "fix-720-read-image", `${variant}-full.png`) });
      await page.getByRole("button", { name: "Show smaller" }).click();
      await expect(page.getByRole("button", { name: "Show full size" })).toBeVisible();

      // After a reload the history holds the picture: omp's saved copy comes back as base64, not as a reference.
      await page.reload();
      await expect(page.getByText("Conversation settled")).toBeVisible({ timeout: 120_000 });
      await expect(page.locator('[data-slot="u3-tool-card-trigger"]').first()).toBeVisible({
        timeout: 60_000,
      });
      await openAllToolCards(page);
      await expect(picture).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole("img", { name: "pixel.png" })).toHaveCount(1);
      await expect(
        page.getByText("The image is not in the saved chat", { exact: false }),
      ).toHaveCount(0);
    },
  );
}
