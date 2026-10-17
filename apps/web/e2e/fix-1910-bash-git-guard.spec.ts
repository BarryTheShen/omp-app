import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  expect,
  openToolCard,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

const STASH_REFUSAL = "git stash is blocked by workspace policy — do not work around it.";
realTest.use({
  seedWorkspace: { files: { "guarded.txt": "baseline\n" }, gitRepo: true },
});

async function openBash(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByTestId("settings-screen")).toBeVisible();
  await page.getByRole("button", { name: "Shell", exact: true }).click();
  await page.getByRole("option", { name: "Bash", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Bash", exact: true })).toBeVisible();
}

async function captureGuard(page: Page, filename: string): Promise<void> {
  const guard = page.getByRole("checkbox", { name: "Git Guard", exact: true });
  await expect(guard).toBeChecked();
  await expect(guard).toBeEnabled();
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  await guard.evaluate((element) => element.scrollIntoView({ block: "center", inline: "nearest" }));
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, filename), fullPage: true });
}

async function runStash(page: Page, expected: RegExp | string): Promise<void> {
  const existingComposer = page.getByRole("textbox", { name: "Message input" });
  const composer = (await existingComposer.count()) > 0 ? existingComposer : await startChat(page);
  await sendPrompt(composer, "run_git_stash: run git stash now");
  const card = page.locator('[data-testid^="tool-card-"]').last();
  await expect(card).toBeVisible({ timeout: 60_000 });
  await openToolCard(card);
  await expect(card.getByTestId("u3-bash-stdout")).toContainText(expected, { timeout: 30_000 });
  await expect(page.getByText("Conversation settled")).toBeVisible({ timeout: 60_000 });
}

realTest(
  "Bash Git Guard saves through ConfigStore and changes the real omp bash result",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open();
    execFileSync("git", ["add", "guarded.txt"], { cwd: realApp.folder });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Git Guard fixture",
        "-c",
        "user.email=git-guard@fixture.invalid",
        "commit",
        "-m",
        "seed guard test",
      ],
      { cwd: realApp.folder, stdio: "ignore" },
    );
    await writeFile(join(realApp.folder, "guarded.txt"), "change for guard-off stash\n");
    await page.setViewportSize({ width: 1280, height: 1200 });
    await openBash(page);

    const guard = page.getByRole("checkbox", { name: "Git Guard", exact: true });
    await expect(guard).toBeVisible();
    await expect(guard).not.toBeChecked();
    await page.getByRole("button", { name: "Close settings", exact: true }).click();

    // Git Guard is off in a throwaway repository seeded by this test; stash must run and save only its test change.
    await runStash(page, /Saved working directory and index state/);

    // Save while the app chat remains open: its next bash invocation must see omp's live setting.
    await openBash(page);
    await guard.check();
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
    await expect(guard).toBeEnabled();
    await expect
      .poll(() => readFile(join(realApp.agentDir, "config.yml"), "utf8"))
      .toContain("gitGuard: true");
    await captureGuard(page, "fix-1910-bash-guard-light.png");

    await page.setViewportSize({ width: 390, height: 844 });
    await captureGuard(page, "fix-1910-bash-guard-narrow.png");
    await page.getByRole("button", { name: "Close settings", exact: true }).click();

    await writeFile(join(realApp.folder, "guarded.txt"), "change protected by Git Guard\n");
    await runStash(page, STASH_REFUSAL);

    const dark = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await dark.setViewportSize({ width: 1280, height: 1200 });
    await openBash(dark);
    await captureGuard(dark, "fix-1910-bash-guard-dark.png");

    expect(realApp.problems).toEqual([]);
  },
);
