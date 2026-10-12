/// <reference types="node" />
import type { Locator } from "@playwright/test";
import { expect, realTest, startChat } from "./real-omp";

/**
 * Ctrl+U deletes from the line start to the caret, and Ctrl+Y puts back the text the last delete removed (omp's
 * tui.editor keys; issue 1215). Nothing is sent, so no model answers. Ctrl+K is not in this batch: the app's command
 * palette already uses it.
 */

realTest.setTimeout(420_000);

async function pressTimes(composer: Locator, key: string, times: number): Promise<void> {
  for (let i = 0; i < times; i++) await composer.press(key);
}

realTest("Ctrl+U deletes from the line start to the caret", async ({ realApp }) => {
  const page = await realApp.open();
  const composer = await startChat(page);
  await composer.fill("hello world");
  await composer.press("End");
  await pressTimes(composer, "ArrowLeft", 5);
  await composer.press("Control+u");
  await expect(composer).toHaveValue("world");
});

realTest("Ctrl+Y puts back the text that Ctrl+U deleted", async ({ realApp }) => {
  const page = await realApp.open();
  const composer = await startChat(page);
  await composer.fill("hello world");
  await composer.press("End");
  await pressTimes(composer, "ArrowLeft", 5);
  await composer.press("Control+u");
  await expect(composer).toHaveValue("world");
  await composer.press("Control+y");
  await expect(composer).toHaveValue("hello world");
});
