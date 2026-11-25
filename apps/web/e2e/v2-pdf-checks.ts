import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, WebSocketRoute } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/** Bytes of filler after each page of the large PDF: 1.5 MB, so 40 pages make about 60 MB. */
const FILLER_BYTES = 1_500_000;

/**
 * A large PDF of `pages` pages, each a black square, each followed by an unused stream of filler (as scans and photos
 * fill a real one). The index is at the end, as in most PDFs, so drawing page 1 needs the end and the start, not all.
 */
function largePdf(pages: number): Buffer {
  const parts: Buffer[] = [];
  let length = 0;
  const offsets: number[] = [];
  const write = (part: Buffer): void => {
    parts.push(part);
    length += part.length;
  };
  const add = (body: Buffer | string): void => {
    offsets.push(length);
    write(Buffer.from(`${offsets.length} 0 obj\n`, "latin1"));
    write(typeof body === "string" ? Buffer.from(body, "latin1") : body);
    write(Buffer.from("\nendobj\n", "latin1"));
  };
  write(Buffer.from("%PDF-1.4\n", "latin1"));
  const kids = Array.from({ length: pages }, (_, index) => `${3 + index * 3} 0 R`).join(" ");
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  for (let index = 0; index < pages; index += 1) {
    const content = `0 0 0 rg 20 20 160 160 re f`;
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 260] /Contents ${4 + index * 3} 0 R >>`);
    add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    const filler = Buffer.alloc(FILLER_BYTES, 0x41);
    add(
      Buffer.concat([
        Buffer.from(`<< /Length ${filler.length} >>\nstream\n`, "latin1"),
        filler,
        Buffer.from("\nendstream", "latin1"),
      ]),
    );
  }
  const xref = length;
  const entries = offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  write(Buffer.from(`xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n${entries}`, "latin1"));
  write(
    Buffer.from(
      `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
      "latin1",
    ),
  );
  return Buffer.concat(parts);
}

/** A two-page PDF, each page a black square on white (no fonts, so nothing outside the file is needed to draw it). */
function twoPagePdf(): Buffer {
  const offsets: number[] = [];
  let pdf = "%PDF-1.4\n";
  const add = (body: string): void => {
    offsets.push(pdf.length);
    pdf += `${offsets.length} 0 obj\n${body}\nendobj\n`;
  };
  const square = (at: number, size: number): string => {
    const content = `0 0 0 rg ${at} ${at} ${size} ${size} re f`;
    return `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  };
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add("<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>");
  add("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 260] /Contents 5 0 R >>");
  add("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 260] /Contents 6 0 R >>");
  add(square(20, 160));
  add(square(60, 80));
  const xref = pdf.length;
  const entries = offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n${entries}`;
  pdf += `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

/** Whether a page's canvas holds ink: some dark pixels where PDF.js drew the page's square. */
async function inked(page: Locator): Promise<boolean> {
  return page.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
    const context = canvas.getContext("2d");
    if (context === null) return false;
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let index = 0; index < data.length; index += 4) {
      if ((data[index] ?? 255) < 64 && (data[index + 3] ?? 0) > 0) return true;
    }
    return false;
  });
}

/**
 * A PDF in the Files panel (#2785): the app draws its pages itself with PDF.js, so every engine shows them (the
 * desktop window's engine showed a blank frame where the browser's own viewer was expected).
 */
export function definePdfChecks(engine: "chromium" | "webkit"): void {
  realTest.describe(`new UI: a PDF in the Files panel (${engine})`, () => {
    realTest.setTimeout(180_000);

    realTest(
      "its pages are drawn in the panel, the second as it comes into view",
      async ({ realApp }) => {
        await writeFile(join(realApp.folder, "two-pages.pdf"), twoPagePdf());
        const page = await realApp.open({ path: "/" });
        await startNewChat(page);
        await expect(page.getByRole("textbox", { name: "Message" })).toHaveAttribute(
          "placeholder",
          "Message omp",
          { timeout: 120_000 },
        );
        await page.getByRole("button", { name: "Files", exact: true }).click();
        await page
          .getByRole("tree", { name: "Files" })
          .getByRole("treeitem", { name: "two-pages.pdf", exact: true })
          .click();

        const first = page.getByRole("img", { name: "Page 1 of 2" });
        await expect(first.locator("canvas")).toBeVisible({ timeout: 30_000 });
        await expect.poll(() => inked(first), { timeout: 10_000 }).toBe(true);
        const second = page.getByRole("img", { name: "Page 2 of 2" });
        await second.scrollIntoViewIfNeeded();
        await expect(second.locator("canvas")).toBeVisible({ timeout: 30_000 });
        await expect.poll(() => inked(second), { timeout: 10_000 }).toBe(true);
        expect(realApp.problems).toEqual([]);
      },
    );

    realTest("a drawn page is drawn again, sharp, when the panel grows", async ({ realApp }) => {
      await writeFile(join(realApp.folder, "two-pages.pdf"), twoPagePdf());
      const page = await realApp.open({ path: "/" });
      await startNewChat(page);
      await expect(page.getByRole("textbox", { name: "Message" })).toHaveAttribute(
        "placeholder",
        "Message omp",
        { timeout: 120_000 },
      );
      await page.getByRole("button", { name: "Files", exact: true }).click();
      await page
        .getByRole("tree", { name: "Files" })
        .getByRole("treeitem", { name: "two-pages.pdf", exact: true })
        .click();
      const first = page.getByRole("img", { name: "Page 1 of 2" });
      await expect(first.locator("canvas")).toBeVisible({ timeout: 30_000 });
      // Its canvas's pixels for each pixel of its place on screen, by the screen's own pixels (at least 2).
      const sharpness = (): Promise<number> =>
        first.evaluate((slot) => {
          const canvas = slot.querySelector("canvas");
          const needed = slot.clientWidth * Math.max(window.devicePixelRatio, 2);
          return canvas === null ? 0 : canvas.width / needed;
        });
      await expect.poll(sharpness, { timeout: 10_000 }).toBeGreaterThanOrEqual(0.95);
      const before = await first.evaluate((slot) => slot.clientWidth);
      const viewport = page.viewportSize();
      if (viewport === null) throw new Error("no viewport");
      await page.setViewportSize({ width: viewport.width + 500, height: viewport.height });
      await expect.poll(() => first.evaluate((slot) => slot.clientWidth)).toBeGreaterThan(before);
      // Stretched, the canvas of the narrower panel was blurred: it is drawn again for the wider one.
      await expect.poll(sharpness, { timeout: 10_000 }).toBeGreaterThanOrEqual(0.95);
      await expect.poll(() => inked(first), { timeout: 10_000 }).toBe(true);
      expect(realApp.problems).toEqual([]);
    });

    realTest(
      "a large PDF shows its first page after a small part of the file was read, and a far page when scrolled to",
      async ({ realApp }) => {
        const file = largePdf(40);
        await writeFile(join(realApp.folder, "large.pdf"), file);
        // The bytes the page asks the Files port for, read by read.
        let asked = 0;
        const page = await realApp.open({
          path: "/",
          beforeLoad: (opened) =>
            opened.routeWebSocket(/\/ws/, (socket: WebSocketRoute) => {
              const server = socket.connectToServer();
              socket.onMessage((message) => {
                const text = String(message);
                if (text.includes("A1.workspaceFiles") && text.includes('"read"')) {
                  asked += Number(/"length":(\d+)/.exec(text)?.[1] ?? 0);
                }
                server.send(message);
              });
            }),
        });
        await startNewChat(page);
        await expect(page.getByRole("textbox", { name: "Message" })).toHaveAttribute(
          "placeholder",
          "Message omp",
          { timeout: 120_000 },
        );
        await page.getByRole("button", { name: "Files", exact: true }).click();
        await page
          .getByRole("tree", { name: "Files" })
          .getByRole("treeitem", { name: "large.pdf", exact: true })
          .click();

        const first = page.getByRole("img", { name: "Page 1 of 40" });
        await expect(first.locator("canvas")).toBeVisible({ timeout: 60_000 });
        await expect.poll(() => inked(first), { timeout: 10_000 }).toBe(true);
        // The whole file was read before anything was drawn: now the file's index and page 1's part are.
        await page.waitForTimeout(1_500);
        expect(asked).toBeLessThan(file.length / 4);

        const last = page.getByRole("img", { name: "Page 40 of 40" });
        await last.scrollIntoViewIfNeeded();
        await expect(last.locator("canvas")).toBeVisible({ timeout: 60_000 });
        await expect.poll(() => inked(last), { timeout: 10_000 }).toBe(true);
        expect(realApp.problems).toEqual([]);
      },
    );

    realTest(
      "Zoom in widens the pages and draws them sharp at the new size; Fit to width brings them back",
      async ({ realApp }) => {
        await writeFile(join(realApp.folder, "two-pages.pdf"), twoPagePdf());
        const page = await realApp.open({ path: "/" });
        await startNewChat(page);
        await expect(page.getByRole("textbox", { name: "Message" })).toHaveAttribute(
          "placeholder",
          "Message omp",
          { timeout: 120_000 },
        );
        await page.getByRole("button", { name: "Files", exact: true }).click();
        await page
          .getByRole("tree", { name: "Files" })
          .getByRole("treeitem", { name: "two-pages.pdf", exact: true })
          .click();
        const first = page.getByRole("img", { name: "Page 1 of 2" });
        await expect(first.locator("canvas")).toBeVisible({ timeout: 30_000 });
        const fitted = await first.evaluate((slot) => slot.clientWidth);
        const zoom = page.getByRole("toolbar", { name: "Zoom" });
        await zoom.getByRole("button", { name: "Zoom in" }).click();
        await zoom.getByRole("button", { name: "Zoom in" }).click();
        await expect(
          zoom.getByRole("button", { name: /^Fit to width \(now 156%\)$/ }),
        ).toBeVisible();
        await expect
          .poll(() => first.evaluate((slot) => slot.clientWidth))
          .toBeGreaterThan(fitted * 1.5);
        // Drawn again for its wider place: as many canvas pixels as its place has screen pixels (at least 2 each).
        await expect
          .poll(
            () =>
              first.evaluate((slot) => {
                const canvas = slot.querySelector("canvas");
                const needed = slot.clientWidth * Math.max(window.devicePixelRatio, 2);
                return canvas === null ? 0 : canvas.width / needed;
              }),
            { timeout: 10_000 },
          )
          .toBeGreaterThanOrEqual(0.95);
        await zoom.getByRole("button", { name: /^Fit to width/ }).click();
        await expect.poll(() => first.evaluate((slot) => slot.clientWidth)).toBe(fitted);
        await expect(zoom.getByRole("button", { name: "Zoom out" })).toBeDisabled();
        expect(realApp.problems).toEqual([]);
      },
    );

    if (engine === "chromium")
      realTest(
        "two fingers pinch the PDF, not the screen (zoomed, the screen took the phone viewer's Back away)",
        async ({ realApp, browser }) => {
          await writeFile(join(realApp.folder, "two-pages.pdf"), twoPagePdf());
          const context = await browser.newContext({
            viewport: { width: 1280, height: 800 },
            hasTouch: true,
          });
          const page = await realApp.open({ path: "/", context });
          await startNewChat(page);
          await expect(page.getByRole("textbox", { name: "Message" })).toHaveAttribute(
            "placeholder",
            "Message omp",
            { timeout: 120_000 },
          );
          await page.getByRole("button", { name: "Files", exact: true }).click();
          await page
            .getByRole("tree", { name: "Files" })
            .getByRole("treeitem", { name: "two-pages.pdf", exact: true })
            .click();
          const first = page.getByRole("img", { name: "Page 1 of 2" });
          await expect(first.locator("canvas")).toBeVisible({ timeout: 30_000 });
          const pdf = page.getByRole("document", { name: "two-pages.pdf" });
          // The browser's own pinch-zoom is off over the PDF.
          expect(await pdf.evaluate((element) => getComputedStyle(element).touchAction)).toBe(
            "pan-x pan-y",
          );
          const fitted = await first.evaluate((slot) => slot.clientWidth);
          // Two fingers 100 px apart move to 200 px apart over the first page.
          await pdf.evaluate((element) => {
            const box = element.getBoundingClientRect();
            const y = box.top + 120;
            const x = box.left + box.width / 2;
            const touches = (spread: number) => [
              new Touch({ identifier: 1, target: element, clientX: x - spread, clientY: y }),
              new Touch({ identifier: 2, target: element, clientX: x + spread, clientY: y }),
            ];
            const send = (type: string, list: Touch[]) =>
              element.dispatchEvent(
                new TouchEvent(type, { touches: list, changedTouches: list, bubbles: true }),
              );
            send("touchstart", touches(50));
            for (const spread of [60, 75, 90, 100]) send("touchmove", touches(spread));
            send("touchend", []);
          });
          await expect
            .poll(() => first.evaluate((slot) => slot.clientWidth))
            .toBeGreaterThan(fitted * 1.8);
          await expect(
            page
              .getByRole("toolbar", { name: "Zoom" })
              .getByRole("button", { name: /^Fit to width \(now 200%\)$/ }),
          ).toBeVisible();
          expect(realApp.problems).toEqual([]);
          await context.close();
        },
      );
  });
}
