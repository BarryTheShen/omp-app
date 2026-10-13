import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  APP_ROOT,
  expect,
  REAL_OMP,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

const NARROW = { width: 390, height: 844 } as const;
/** An extension whose `turn_start` handler throws: omp reports that as an extension error during the turn. */
const EXTENSION_FILE = "notes-ext-1283.ts";
const EXTENSION_SOURCE = `export default function notesExtension(pi) {
  pi.on("turn_start", () => {
    throw new Error("notes index is locked");
  });
}
`;
/** The name the banner gives the extension: its file's name without the extension. */
const EXTENSION_NAME = "notes-ext-1283";
const HEADING = "An extension reported an error";
const DETAIL = `${EXTENSION_NAME}: notes index is locked`;

/**
 * omp does not load a file seeded in the agent's extensions folder here, but it loads any file named with `--extension`.
 * This wrapper runs the real omp with that flag and the run's agent folder (the same wrapper issue #1168 uses).
 */
const DATA_DIR = join(APP_ROOT, ".data");
mkdirSync(DATA_DIR, { recursive: true });
const OMP_WITH_EXTENSION = join(DATA_DIR, "omp-app-1283-omp-with-extension.sh");
writeFileSync(
  OMP_WITH_EXTENSION,
  `#!/bin/sh\nexec '${REAL_OMP}' --extension "$PI_CODING_AGENT_DIR/extensions/${EXTENSION_FILE}" "$@"\n`,
);
chmodSync(OMP_WITH_EXTENSION, 0o755);

realTest.use({
  ompBinary: OMP_WITH_EXTENSION,
  seedExtensions: { [EXTENSION_FILE]: EXTENSION_SOURCE },
});
realTest.setTimeout(300_000);

/**
 * Issue #1283. An extension's failure reads under its own heading with the extension's name in front of omp's
 * reason, not as "The conversation could not continue.". The handler fails when a turn starts, so the chat is
 * already listening: a failure omp reports while the chat starts is not shown (see the follow-up issue).
 */
realTest(
  "real omp: a failing extension is named in the banner, under a heading that does not say the conversation stopped",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "hello");

    const banner = page.locator('[data-slot="u1-thread-error"]');
    await expect(banner).toBeVisible({ timeout: 120_000 });
    await expect(banner.getByText(HEADING)).toBeVisible();
    await expect(banner.getByText(DETAIL)).toBeVisible();
    await expect(page.getByText("The conversation could not continue.")).toHaveCount(0);

    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1283-extension-error-light.png") });
    await page.setViewportSize(NARROW);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1283-extension-error-390.png") });
    expect(realApp.problems).toEqual([]);
  },
);

realTest("the extension's error reads in dark mode", async ({ realApp }) => {
  const page = await realApp.open({
    beforeLoad: (target) =>
      target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
  });
  const composer = await startChat(page);
  await sendPrompt(composer, "hello");

  const banner = page.locator('[data-slot="u1-thread-error"]');
  await expect(banner).toBeVisible({ timeout: 120_000 });
  await expect(banner.getByText(DETAIL)).toBeVisible();

  await mkdir(screenshots, { recursive: true });
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "fix-1283-extension-error-dark.png") });
  expect(realApp.problems).toEqual([]);
});
