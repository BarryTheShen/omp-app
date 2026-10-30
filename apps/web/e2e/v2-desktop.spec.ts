import type { Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

/** A 1 x 1 PNG, as the desktop window's clipboard command answers it. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/**
 * The new UI (`apps/ui`, under `/v2/`) in the desktop window, with the window's command bridge faked where Tauri puts it
 * on the window's pages (`window.__TAURI_INTERNALS__`). The window's own behaviour is the desktop smoke test's.
 */
realTest.describe("new UI in the desktop window", () => {
  realTest.setTimeout(240_000);

  realTest(
    "a picture pasted in the window is read from the window's clipboard; pasted text stays text",
    async ({ realApp }) => {
      const page = await realApp.open({
        path: "/v2/",
        beforeLoad: (target: Page) =>
          target.addInitScript((png) => {
            const calls: string[] = [];
            const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0));
            Object.assign(window, {
              windowCalls: calls,
              __TAURI_INTERNALS__: {
                invoke: async (command: string) => {
                  calls.push(command);
                  return command === "read_clipboard_png" ? bytes.buffer : undefined;
                },
              },
            });
          }, PNG),
      });
      await page
        .getByRole("navigation", { name: "Chats" })
        .getByRole("button", { name: "New chat" })
        .click();
      const box = page.getByRole("textbox", { name: "Message" });
      await expect(box).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      const calls = () =>
        page.evaluate(() => (window as unknown as { windowCalls: string[] }).windowCalls);
      // WebKitGTK's paste event: text when text was copied, nothing at all for a copied picture.
      const paste = (text: string) =>
        box.evaluate((element, value) => {
          const data = new DataTransfer();
          if (value !== "") data.setData("text/plain", value);
          element.dispatchEvent(
            new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
          );
        }, text);

      await paste("plain words");
      expect(await calls()).toEqual([]);
      await paste("");
      await expect(page.getByRole("button", { name: "Remove Pasted image 1.png" })).toBeVisible();
      expect(await calls()).toEqual(["read_clipboard_png"]);
      expect(realApp.problems).toEqual([]);
    },
  );
});
