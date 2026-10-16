import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  APP_ROOT,
  expect,
  REAL_OMP,
  realTest,
  screenshots,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

const EXTENSION_FILE = "startup-error-1421.ts";
const EXTENSION_SOURCE = `export default function startupError(pi) {
  pi.on("session_start", () => {
    throw new Error("notes index is locked");
  });
}
`;
const EXTENSION_NAME = "startup-error-1421";
const HEADING = "An extension reported an error";
const DETAIL = `${EXTENSION_NAME}: notes index is locked`;
const DATA_DIR = join(APP_ROOT, ".data");
mkdirSync(DATA_DIR, { recursive: true });
const OMP_WITH_EXTENSION = join(DATA_DIR, "omp-app-1421-omp-with-extension.sh");
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

realTest("a session-start extension error reaches the chat banner", async ({ realApp }) => {
  await mkdir(screenshots, { recursive: true });
  const page = await realApp.open();
  await startChat(page);

  const banner = page.locator('[data-slot="u1-thread-error"]');
  await expect(banner).toBeVisible({ timeout: 120_000 });
  await expect(banner.getByText(HEADING)).toBeVisible();
  await expect(banner.getByText(DETAIL)).toBeVisible();
  await expect(page.getByText("The conversation could not continue.")).toHaveCount(0);
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "fix-1421-extension-startup-light.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await banner.screenshot({ path: join(screenshots, "fix-1421-extension-startup-390.png") });

  const darkPage = await realApp.open({
    beforeLoad: (target) =>
      target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
  });
  await startChat(darkPage);
  const darkBanner = darkPage.locator('[data-slot="u1-thread-error"]');
  await expect(darkBanner).toBeVisible({ timeout: 120_000 });
  await expect(darkBanner.getByText(DETAIL)).toBeVisible();
  await waitForFiniteAnimations(darkPage);
  await darkPage.screenshot({ path: join(screenshots, "fix-1421-extension-startup-dark.png") });
  expect(realApp.problems).toEqual([]);
});
