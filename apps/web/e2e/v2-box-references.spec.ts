import type { Page } from "@playwright/test";
import { expect, type RealApp, realTest, startNewChat } from "./real-omp";

/**
 * References in the message box are pointers (`boxTokens.ts`): a picture's `[Image #N, WxH]` and a secret's placeholder
 * go whole or not at all, the caret steps over them, a selection takes them whole, and each shows as a chip.
 */
const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const MARKER = "[Image #1, 1x1]";
const SECRET = "$$APIKEY_2XUBD7NWOZ1U:L$$";

const box = (page: Page) => page.getByRole("textbox", { name: "Message" });
const caret = (page: Page) =>
  box(page).evaluate((area: HTMLTextAreaElement) => [area.selectionStart, area.selectionEnd]);

async function newChat(realApp: RealApp): Promise<Page> {
  const page = await realApp.open({ path: "/" });
  await startNewChat(page);
  await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
  return page;
}

async function pastePicture(page: Page): Promise<void> {
  await box(page).evaluate((element, data) => {
    const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "pixel.png", { type: "image/png" }));
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, PIXEL);
  await expect(box(page)).toHaveValue(`${MARKER} `);
}

realTest.describe("new UI message box: references are pointers", () => {
  realTest.setTimeout(240_000);

  realTest(
    "Backspace and Delete take a picture's name whole, and the name shows as a chip",
    async ({ realApp }) => {
      const page = await newChat(realApp);
      const attached = page.getByRole("list", { name: "Attachments" }).getByRole("listitem");
      await pastePicture(page);
      await expect(page.locator("[data-tour='message-box'] mark")).toHaveText(MARKER);
      await box(page).press("End");
      await box(page).press("Backspace");
      await box(page).press("Backspace");
      await expect(box(page)).toHaveValue("");
      // The name goes whole; the picture stays as omp keeps it (a text that names none of its pictures sends them all).
      await expect(attached).toHaveCount(1);

      await box(page).fill(`${MARKER} after`);
      await box(page).press("Home");
      await box(page).press("Delete");
      await expect(box(page)).toHaveValue(" after");
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "the caret steps over a reference, a selection over half of one takes it whole, and typing never lands inside",
    async ({ realApp }) => {
      const page = await newChat(realApp);
      await pastePicture(page);
      await box(page).press("Home");
      await box(page).pressSequentially("see ");
      await box(page).press("End");
      await box(page).pressSequentially("now");
      const text = `see ${MARKER} now`;
      await expect(box(page)).toHaveValue(text);
      const start = 4;
      const end = start + MARKER.length;

      // From before it, one step right lands after it; one step left from after it lands before it.
      await box(page).evaluate(
        (area: HTMLTextAreaElement, at) => area.setSelectionRange(at, at),
        start,
      );
      await box(page).press("ArrowRight");
      expect(await caret(page)).toEqual([end, end]);
      await box(page).press("ArrowLeft");
      expect(await caret(page)).toEqual([start, start]);

      // A selection from its middle to the end, typed over: the reference goes with it.
      await box(page).evaluate(
        (area: HTMLTextAreaElement, [from, to]) =>
          area.setSelectionRange(from as number, to as number),
        [start + 5, text.length],
      );
      await box(page).pressSequentially("x");
      await expect(box(page)).toHaveValue("see x");
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest("a secret's placeholder goes whole", async ({ realApp }) => {
    const page = await newChat(realApp);
    await box(page).fill(`key ${SECRET}`);
    await box(page).press("End");
    await box(page).press("Backspace");
    await expect(box(page)).toHaveValue("key ");
    expect(realApp.problems).toEqual([]);
  });
});
