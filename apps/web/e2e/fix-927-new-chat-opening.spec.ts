import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots } from "./real-omp";

/**
 * Issue 927. A New chat takes omp a moment to start, and the page used to look unchanged for that
 * time: it still said to choose a folder and open a session. This wrapper makes a new chat's omp wait
 * 4 s before it starts, so the opening is long enough to look at. Resumed chats start at once.
 */
const REAL_OMP = "/home/user/.bun/bin/omp";
const dir = resolve(process.cwd(), "../../.data/fix-927-new-chat");
mkdirSync(dir, { recursive: true });
const delayedOmp = join(dir, "omp-new-chat-delay.sh");
writeFileSync(
  delayedOmp,
  `#!/bin/bash
chat=0
resume=0
for arg in "$@"; do
  if [ "$arg" = "rpc-ui" ]; then chat=1; fi
  if [ "$arg" = "--resume" ]; then resume=1; fi
done
if [ "$chat" = 1 ] && [ "$resume" = 0 ]; then sleep 4; fi
exec "${REAL_OMP}" "$@"
`,
);
chmodSync(delayedOmp, 0o755);
realTest.use({ ompBinary: delayedOmp });

/** Clicks New chat and checks the page while omp starts: the words say so, and no step is asked of the person. */
async function expectOpening(page: Page): Promise<void> {
  await page
    .locator('[aria-label="Sessions"]')
    .getByRole("button", { name: "New chat" })
    .first()
    .click();
  const note = page.getByText("Starting a new chat…");
  await expect(note).toBeVisible({ timeout: 3_000 });
  await expect(page.getByText("omp is starting. This can take a few seconds.")).toBeVisible();
  await expect(page.getByText("Open a session to start composing.")).toHaveCount(0);
  await expect(page.getByText("Choose a workspace folder and start a new session.")).toHaveCount(0);
  // The token styles loaded: the composer note's own background is the app's card colour, not transparent.
  const background = await note.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
}

realTest(
  "New chat says omp is starting, and does not ask for a folder or a session, until the chat opens",
  async ({ realApp }) => {
    const page = await realApp.open();
    await expectOpening(page);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "fix-927-opening-light.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(screenshots, "fix-927-opening-390.png") });

    const dark = await realApp.open({
      beforeLoad: (opened) =>
        opened.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await expectOpening(dark);
    await dark.screenshot({ path: join(screenshots, "fix-927-opening-dark.png") });

    // Once omp answers, the chat opens with its composer.
    await expect(page.getByRole("textbox", { name: "Message input" })).toBeVisible({
      timeout: 60_000,
    });
  },
);
