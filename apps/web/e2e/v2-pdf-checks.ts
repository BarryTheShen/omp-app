import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

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
  });
}
