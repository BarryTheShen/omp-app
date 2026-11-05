import type { Page } from "@playwright/test";
import { expect, type RealApp, realTest, startNewChat } from "./real-omp";

/** A 1 × 1 PNG. */
const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** The new UI's message box (`apps/ui`, under `/v2/`) on real omp: Edit on your messages, and images. */
realTest.describe("new UI edit and attachments", () => {
  realTest.setTimeout(240_000);

  async function newChat(realApp: RealApp): Promise<Page> {
    const page = await realApp.open({ path: "/" });
    await startNewChat(page);
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveAttribute(
      "placeholder",
      "Message omp",
      { timeout: 120_000 },
    );
    return page;
  }

  realTest(
    "Edit puts one of your messages back in the box, and sending it goes on from there without what came after",
    async ({ realApp }) => {
      const page = await newChat(realApp);
      const box = page.getByRole("textbox", { name: "Message" });
      const transcript = page.getByRole("region", { name: "Transcript" });
      const edit = page.getByRole("button", { name: "Edit this message" });

      await box.fill("first question");
      await box.press("Enter");
      await expect(transcript.getByText("pong")).toHaveCount(1, { timeout: 60_000 });
      await box.fill("second question");
      await box.press("Enter");
      await expect(transcript.getByText("pong")).toHaveCount(2, { timeout: 60_000 });
      // Edit comes once omp's turn is over and its file is read back.
      await expect(edit).toHaveCount(2, { timeout: 30_000 });

      await transcript.getByText("first question").hover();
      await edit.first().click();
      await expect(box).toHaveValue("first question");
      await expect(transcript.getByText("second question")).toHaveCount(0);
      await expect(transcript.getByText("first question")).toHaveCount(0);

      await box.fill("first question, edited");
      await box.press("Enter");
      await expect(transcript.getByText("first question, edited")).toBeVisible({ timeout: 60_000 });
      await expect(transcript.getByText("pong")).toHaveCount(1, { timeout: 60_000 });
      await expect(edit).toHaveCount(1, { timeout: 30_000 });
      await expect(transcript.getByText("second question")).toHaveCount(0);

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "Edit clicked twice while omp goes back puts the message in the box once",
    async ({ realApp }) => {
      const page = await newChat(realApp);
      const box = page.getByRole("textbox", { name: "Message" });
      const transcript = page.getByRole("region", { name: "Transcript" });
      const edit = page.getByRole("button", { name: "Edit this message" });

      await box.fill("only once");
      await box.press("Enter");
      await expect(transcript.getByText("pong")).toHaveCount(1, { timeout: 60_000 });
      await expect(edit).toHaveCount(1, { timeout: 30_000 });

      await transcript.getByText("only once").hover();
      // The second click comes while omp is still going back: it must not bring the message again.
      await edit.dblclick();
      await expect(box).toHaveValue("only once");
      await page.waitForTimeout(1_000);
      await expect(box).toHaveValue("only once");

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "a pasted or dropped image goes with the message, any other file is uploaded with it, and Remove takes one out",
    async ({ realApp }) => {
      const page = await newChat(realApp);
      const box = page.getByRole("textbox", { name: "Message" });
      const attached = page.getByRole("list", { name: "Attachments" });

      await box.evaluate((element, data) => {
        const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
        const transfer = new DataTransfer();
        transfer.items.add(new File([bytes], "pixel.png", { type: "image/png" }));
        transfer.items.add(new File(["notes"], "notes.txt", { type: "text/plain" }));
        element.dispatchEvent(
          new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
        );
      }, PIXEL);
      // The picture goes with the message; the text file is uploaded to the chat's folder (#2830).
      await expect(attached.getByRole("listitem")).toHaveCount(2);
      await expect(attached).toContainText("pixel.png");
      await expect(attached.getByRole("listitem").filter({ hasText: "notes.txt" })).toContainText(
        "5 B",
        { timeout: 30_000 },
      );

      await box.evaluate((element, data) => {
        const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
        const transfer = new DataTransfer();
        transfer.items.add(new File([bytes], "dropped.png", { type: "image/png" }));
        element.dispatchEvent(
          new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }),
        );
      }, PIXEL);
      await expect(attached.getByRole("listitem")).toHaveCount(3);
      await page.getByRole("button", { name: "Remove dropped.png" }).click();
      await expect(attached.getByRole("listitem")).toHaveCount(2);
      await expect(attached).not.toContainText("dropped.png");

      await box.fill("what is in this picture");
      await box.press("Enter");
      const transcript = page.getByRole("region", { name: "Transcript" });
      await expect(transcript.getByText("what is in this picture")).toBeVisible({
        timeout: 60_000,
      });
      await expect(transcript.getByRole("img", { name: "attachment" })).toHaveCount(1);
      await expect(transcript.getByRole("button", { name: "Download notes.txt" })).toBeVisible();
      await expect(attached).toHaveCount(0);

      expect(realApp.problems).toEqual([]);
    },
  );
});
