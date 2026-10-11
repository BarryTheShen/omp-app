import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { RealApp } from "./real-omp";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

const viewports = [
  { name: "390", width: 390, height: 844 },
  { name: "1280", width: 1280, height: 800 },
  { name: "1771", width: 1771, height: 1100 },
  { name: "1920", width: 1920, height: 1080 },
] as const;

async function expectComposerStyles(page: Page, dark: boolean): Promise<void> {
  const styles = await page.evaluate(() => {
    const input = document.querySelector<HTMLTextAreaElement>('[aria-label="Message input"]');
    const surface = input?.parentElement;
    if (!input || !surface) {
      return {
        dark: document.documentElement.classList.contains("dark"),
        usesCardToken: false,
        inputBorderWidth: "missing",
        inputOutlineStyle: "none",
        cardBorderStyle: "none",
        cardBorderWidth: "0px",
      };
    }
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--card)";
    document.body.append(probe);
    const expected = getComputedStyle(probe).backgroundColor;
    const actual = getComputedStyle(surface).backgroundColor;
    probe.remove();
    const surfaceStyle = getComputedStyle(surface);
    return {
      dark: document.documentElement.classList.contains("dark"),
      usesCardToken: expected !== "rgba(0, 0, 0, 0)" && actual === expected,
      inputBorderWidth: getComputedStyle(input).borderTopWidth,
      inputOutlineStyle: getComputedStyle(input).outlineStyle,
      cardBorderStyle: surfaceStyle.borderTopStyle,
      cardBorderWidth: surfaceStyle.borderTopWidth,
    };
  });
  expect(styles.dark).toBe(dark);
  expect(styles.usesCardToken).toBe(true);
  expect(styles.inputOutlineStyle).toBe("none");
  expect(styles.inputBorderWidth).toBe("0px");
  expect(styles.cardBorderStyle).toBe("solid");
  expect(styles.cardBorderWidth).not.toBe("0px");
}

async function expectFilePreview(page: Page, filename: string): Promise<void> {
  await expect(page.locator('[data-slot="u2-composer-attachments"]')).toContainText(filename);
  await expect(page.getByText(filename, { exact: true })).toHaveCount(1);
}

async function addFileByDrop(page: Page): Promise<void> {
  const composer = page.getByRole("textbox", { name: "Message input" });
  await composer.evaluate((input) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(["dropped"], "dropped.txt", { type: "text/plain" }));
    input.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
  });
  await expectFilePreview(page, "dropped.txt");
}

async function addFileByPaste(page: Page): Promise<void> {
  const composer = page.getByRole("textbox", { name: "Message input" });
  await composer.evaluate((input) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(["pasted"], "pasted.txt", { type: "text/plain" }));
    input.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer,
      }),
    );
  });
  await expectFilePreview(page, "pasted.txt");
}

async function runComposerControls({ realApp }: { readonly realApp: RealApp }): Promise<void> {
  await mkdir(screenshots, { recursive: true });

  for (const theme of ["light", "dark"] as const) {
    const page = await realApp.open({
      beforeLoad: (openedPage) => openedPage.emulateMedia({ colorScheme: theme }),
    });
    const composer = await startChat(page);

    for (const viewport of viewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await expect(composer).toBeVisible();
      await waitForFiniteAnimations(page);

      const attachment = page.getByRole("button", { name: /Add attachment/i });
      const prompt = page.getByRole("button", { name: "Prompt" });
      const bash = page.getByRole("button", { name: "Bash" });
      const python = page.getByRole("button", { name: "Python" });
      const send = page.getByRole("button", { name: "Send message" });
      const toolbar = page.getByRole("group", { name: "Input mode" });
      const reason = page.locator('[data-slot="u2-mode-indicator"] > span[title]');

      await expect(composer).toHaveValue("");
      await expect(attachment).toHaveCount(1);
      await expect(page.getByText("Add file", { exact: true })).toHaveCount(0);
      await expect(toolbar).toBeVisible();
      await expect(prompt).toBeVisible();
      await expect(bash).toBeVisible();
      await expect(python).toBeDisabled();
      await expect(send).toBeVisible();
      await expect(reason).toHaveAttribute("title", /.+/);
      const reasonText = await reason.getAttribute("title");
      if (!reasonText) throw new Error("The unavailable Python reason is missing");
      await expect(page.getByText(reasonText, { exact: true })).toHaveCount(0);
      await composer.focus();
      await expectComposerStyles(page, theme === "dark");

      const [attachmentBox, toolbarBox, sendBox, inputBox, card] = await Promise.all([
        attachment.boundingBox(),
        toolbar.boundingBox(),
        send.boundingBox(),
        composer.boundingBox(),
        composer.evaluate((input) => {
          const surface = input.parentElement;
          if (!surface) throw new Error("Composer card is missing");
          const rect = surface.getBoundingClientRect();
          return {
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            left: rect.left,
            height: rect.height,
          };
        }),
      ]);
      if (!attachmentBox || !toolbarBox || !sendBox || !inputBox)
        throw new Error("The composer controls are missing from the layout");
      const centerY = (box: { readonly y: number; readonly height: number }) =>
        box.y + box.height / 2;
      expect(Math.abs(centerY(attachmentBox) - centerY(toolbarBox))).toBeLessThanOrEqual(2);
      expect(Math.abs(centerY(sendBox) - centerY(toolbarBox))).toBeLessThanOrEqual(2);
      expect(
        card.height,
        `${viewport.name}px: empty composer card height (input ${inputBox.height}px, controls ${toolbarBox.height}px)`,
      ).toBeLessThanOrEqual(viewport.width >= 1280 ? 96 : 108);
      expect(inputBox.y + inputBox.height).toBeLessThanOrEqual(attachmentBox.y + 2);
      expect(attachmentBox.x).toBeGreaterThanOrEqual(card.left);
      expect(attachmentBox.y).toBeGreaterThanOrEqual(card.top);
      expect(attachmentBox.x + attachmentBox.width).toBeLessThanOrEqual(card.right);
      expect(sendBox.y + sendBox.height).toBeLessThanOrEqual(card.bottom);

      const buttonLabels = await page
        .locator('[data-composer-surface="u2"] button')
        .evaluateAll((buttons) =>
          buttons.map(
            (button) => button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "",
          ),
        );
      const attachmentIndex = buttonLabels.indexOf("Add attachment");
      const promptIndex = buttonLabels.indexOf("Prompt");
      const bashIndex = buttonLabels.indexOf("Bash");
      const pythonIndex = buttonLabels.indexOf("Python");
      const sendIndex = buttonLabels.indexOf("Send message");
      expect(attachmentIndex).toBeLessThan(promptIndex);
      expect(promptIndex).toBeLessThan(bashIndex);
      expect(bashIndex).toBeLessThan(pythonIndex);
      expect(pythonIndex).toBeLessThan(sendIndex);
      await composer.fill("Keyboard order");
      await composer.focus();
      await page.keyboard.press("Tab");
      await expect(attachment).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(prompt).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(bash).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(page.getByRole("button", { name: "Execution modes" })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(send).toBeFocused();
      await composer.fill("");
      await composer.focus();

      await page.screenshot({
        path: join(screenshots, `composer-controls-${theme}-${viewport.name}.png`),
        fullPage: true,
      });
    }

    if (theme === "light") {
      const fileChooserPromise = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: /Add attachment/i }).click();
      const fileChooser = await fileChooserPromise;
      await fileChooser.setFiles({
        name: "picked.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("picked through the composer"),
      });
      await expectFilePreview(page, "picked.txt");
      await addFileByDrop(page);
      await addFileByPaste(page);
    }
  }
}

realTest(
  "the composer has one compact attachment and mode row with working file input, drop and paste",
  runComposerControls,
);
