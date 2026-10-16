import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
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

/**
 * Issue 1691. omp cancels a branch when its `session_before_branch` hook returns `{ cancel: true }`
 * (docs/extensions.md:417 at omp v18.8.9; `#branchIntoNewSession` returns false at agent-session.ts:11739-11740, and
 * `branch()` reports `cancelled: true`). The hook awaits a release file in its run's agent folder before it cancels, so the editor can be seen
 * while the edit is sent. For the person a cancelled edit is a no-op: no failure notice, no new chat, and the edit's
 * text stays in the editor. The hook is loaded with `--extension`, as the startup-notices spec loads its own: omp does
 * not load a file seeded in the agent's extensions folder.
 */
const DATA_DIR = join(APP_ROOT, ".data");
const RELEASE_NAME = "release-1691";
const EXTENSION_FILE = "cancel-branch-1691.ts";
const EXTENSION_SOURCE = `import { existsSync } from "node:fs";
import { join } from "node:path";

export default function cancelBranch(pi) {
  pi.on("session_before_branch", async () => {
    const release = join(process.env.PI_CODING_AGENT_DIR, ${JSON.stringify(RELEASE_NAME)});
    const deadline = Date.now() + 240_000;
    while (!existsSync(release) && Date.now() < deadline) {
      const { promise, resolve } = Promise.withResolvers();
      setTimeout(resolve, 50);
      await promise;
    }
    return { cancel: true };
  });
}
`;
mkdirSync(DATA_DIR, { recursive: true });
const OMP_CANCELLING_BRANCH = join(
  DATA_DIR,
  `omp-app-1691-omp-cancelling-branch-${process.pid}.sh`,
);
writeFileSync(
  OMP_CANCELLING_BRANCH,
  `#!/bin/sh\nexec '${REAL_OMP}' --extension "$PI_CODING_AGENT_DIR/extensions/${EXTENSION_FILE}" "$@"\n`,
);
chmodSync(OMP_CANCELLING_BRANCH, 0o755);

realTest.use({
  ompBinary: OMP_CANCELLING_BRANCH,
  seedExtensions: { [EXTENSION_FILE]: EXTENSION_SOURCE },
});

/** The answer a `count_reply <tag>` prompt gets, by its tag. */
function answerTo(page: Page, tag: string) {
  return page.getByText(new RegExp(`^count-\\d+ ${tag}$`));
}

/** A transcript row by its role, found by the text it shows. */
function row(page: Page, role: "user" | "assistant", text: string) {
  return page.locator(`[data-slot="u1-message-row"][data-role="${role}"]`, { hasText: text });
}

/** The editing surface, which is the only region named for the edit. */
function editor(page: Page) {
  return page.getByRole("region", { name: "Editing an earlier message" });
}

const EDITOR_SURFACE = '[data-slot="p3-edit-surface"]';
const EDITOR_TEXTAREA = `${EDITOR_SURFACE} textarea`;

/** The design tokens have loaded: the page's background has the computed color a token sets. */
async function expectTokensLoaded(page: Page): Promise<void> {
  await expect(page.locator("body")).toHaveCSS("background-color", /^(rgb|oklch)/);
}

/**
 * The app follows the browser's colour scheme (its default theme is System), so the scheme is set on the page
 * rather than clicked: the theme radios are in the sidebar, which is off screen at 390 px.
 */
async function setScheme(page: Page, scheme: "light" | "dark"): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme });
  if (scheme === "dark") await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  else await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
  await expectTokensLoaded(page);
  await waitForFiniteAnimations(page);
}

realTest(
  "an edit omp cancels keeps its text in the editor while it is sent and after, with no notice or new chat",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(420_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    const composer = await startChat(page);

    await sendPrompt(composer, "count_reply first");
    await expect(answerTo(page, "first")).toBeVisible({ timeout: 60_000 });

    const firstTurn = row(page, "user", "count_reply first");
    await firstTurn.hover();
    await firstTurn.getByRole("button", { name: "Edit", exact: true }).click();
    const editorInput = editor(page).getByRole("textbox", { name: "Edit message" });
    await expect(editorInput).toHaveValue("count_reply first");
    await editorInput.fill("count_reply second");
    await editorInput.press("Enter");

    // omp holds the branch until the release file exists: the editor shows the edit while it is sent.
    const sending = page.getByText("Sending the edited message as a new branch…");
    await expect(sending).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(`${EDITOR_SURFACE} [inert]`)).toHaveCount(1);
    await expect(page.locator(EDITOR_TEXTAREA)).toHaveValue("count_reply second");
    await expectTokensLoaded(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1691-sending-1280-light.png"),
      fullPage: true,
    });

    // Cancel is inert while the edit is sent: a press does not reach the editor, so its text does not change.
    await page
      .locator(`${EDITOR_SURFACE} button`, { hasText: "Cancel edit" })
      .click({ force: true });
    await expect(page.locator(EDITOR_TEXTAREA)).toHaveValue("count_reply second");
    await expect(sending).toBeVisible();

    await setScheme(page, "dark");
    await page.screenshot({
      path: join(screenshots, "fix-1691-sending-1280-dark.png"),
      fullPage: true,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1691-sending-390-dark.png"),
      fullPage: true,
    });

    await setScheme(page, "light");
    await page.screenshot({
      path: join(screenshots, "fix-1691-sending-390-light.png"),
      fullPage: true,
    });

    // Release: omp answers and cancels the branch. The editor keeps the edit's text, with focus, and shows no notice.
    writeFileSync(join(realApp.agentDir, RELEASE_NAME), "");
    await expect(sending).toHaveCount(0, { timeout: 60_000 });
    await expect(editorInput).toHaveValue("count_reply second");
    await expect(editorInput).toBeFocused();
    await expect(page.getByText("omp cancelled the branch")).toHaveCount(0);
    await expect(page.getByText("Your text is kept here:")).toHaveCount(0);
    await expect(answerTo(page, "second")).toHaveCount(0);
    await expect(answerTo(page, "first")).toBeVisible();

    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1691-cancelled-390-light.png"),
      fullPage: true,
    });

    await setScheme(page, "dark");
    await page.screenshot({
      path: join(screenshots, "fix-1691-cancelled-390-dark.png"),
      fullPage: true,
    });

    await page.setViewportSize({ width: 1280, height: 900 });
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1691-cancelled-1280-dark.png"),
      fullPage: true,
    });
    await expect(editorInput).toHaveValue("count_reply second");
  },
);
