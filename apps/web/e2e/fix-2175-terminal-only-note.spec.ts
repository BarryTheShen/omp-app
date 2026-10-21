import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

/*
 * Issue 2199, S6: a typed terminal-only name shows a note with omp's own description, in place of "No matching
 * commands.". Enter still refuses it with the sentence it had, and nothing is sent. Real omp 18.12.2 on the test machine.
 */

// omp 18.12.2 is at this path in every the test machine job.
realTest.use({ ompBinary: "/cache/bun/omp-18.12.2" });

/** The 30 typed names that get a note: 27 terminal-only commands with no app row, and their 3 aliases. `queue` has none: the app answers `/queue` itself. */
const NOTE_NAMES: readonly { readonly name: string; readonly does: string }[] = [
  { name: "agents", does: "Open the agents hub (per-agent model, prewalk, and advisor)" },
  { name: "btw", does: "Ask a side question, or browse this session's BTW history" },
  { name: "cleanse", does: "Detect and fix project diagnostics with weighted parallel subagents" },
  { name: "clear", does: "Clear the conversation context in place, keeping the session" },
  { name: "collab", does: "Share this session live via a relay" },
  { name: "debug", does: "Open debug tools selector" },
  { name: "exit", does: "Exit the application" },
  { name: "extensions", does: "Open Extension Control Center dashboard" },
  { name: "status", does: "Open Extension Control Center dashboard" },
  { name: "fork", does: "Fork this session, or open it in a multiplexer pane or window" },
  { name: "git", does: "Open the git UI (split diff viewer, staging, commit composer)" },
  { name: "guided-goal", does: "Have the agent interview you in chat, then set up goal mode" },
  { name: "join", does: "Join a shared collab session" },
  { name: "leave", does: "Leave the collab session" },
  { name: "live", does: "Start Codex-backed realtime voice mode" },
  { name: "logout", does: "Logout from OAuth provider" },
  {
    name: "loop",
    does: "Toggle loop mode: the next prompt you send re-submits after every yield. A count, a duration, or --until or --while with a command bounds it.",
  },
  { name: "omfg", does: "Forge a TTSR rule from a complaint to stop a recurring behavior" },
  { name: "pause", does: "Freeze all agents (main, subagents, advisor) until resumed" },
  { name: "plan", does: "Toggle plan mode (agent plans before executing)" },
  { name: "plan-review", does: "Re-open the plan review for the latest plan (plan mode only)" },
  { name: "providers", does: "Open provider setup" },
  { name: "q", does: "Quit the application" },
  { name: "quit", does: "Quit the application" },
  { name: "restart", does: "Restart omp with the same launch flags, resuming this session" },
  { name: "resume", does: "Resume a different session" },
  { name: "setup", does: "Open provider setup" },
  { name: "skills", does: "Search, install, and update skills from the skills.omp.sh registry" },
  { name: "tan", does: "Run a full background agent on tangential work" },
  {
    name: "vibe",
    does: "Toggle vibe mode (direct persistent fast/good worker sessions; read-only toolset)",
  },
];

realTest(
  "a typed terminal-only name shows its note in place of 'No matching commands.', with no row",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(480_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    for (const { name, does } of NOTE_NAMES) {
      await composer.fill(`/${name}`);
      const note = page.locator(`[data-terminal-only-note="${name}"]`);
      await expect(note, name).toBeVisible({ timeout: 60_000 });
      await expect(note, name).toContainText(does.slice(0, 25));
      await expect(
        page.getByRole("listbox", { name: "Slash commands" }).getByRole("option"),
      ).toHaveCount(0);
      await expect(page.getByText("No matching commands.")).toHaveCount(0);
    }
  },
);

realTest(
  "Enter on a typed terminal-only name refuses it: no row is chosen, and the draft stays",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(480_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    for (const { name } of NOTE_NAMES) {
      await composer.fill(`/${name}`);
      await expect(page.locator(`[data-terminal-only-note="${name}"]`)).toBeVisible({
        timeout: 60_000,
      });
      // A refusal that is not shown yet means Enter was dropped while the list settled; a repeat is safe, since a refusal sends nothing.
      await expect(async () => {
        await composer.press("Enter");
        await expect(
          page
            .locator('[data-composer-error="true"]')
            .filter({ hasText: `/${name} only runs in omp's terminal, so nothing was sent` }),
        ).toBeVisible({ timeout: 3_000 });
      }).toPass({ timeout: 60_000 });
      await expect(composer, name).toHaveValue(`/${name}`);
    }
    await expect(page.getByText("pong")).toHaveCount(0);
  },
);

realTest(
  "/open and /record keep their app rows with omp's description, /copy keeps its row, and a path is still a prompt",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    const list = page.getByRole("listbox", { name: "Slash commands" });
    await composer.fill("/open");
    await expect(list.getByRole("option", { name: /^\/open/ })).toContainText(
      "Open the last link from the conversation in your browser",
      { timeout: 60_000 },
    );
    await expect(list.getByRole("option", { name: /^\/open/ })).toContainText(
      "Only runs in omp's terminal; nothing is sent from here.",
    );
    await composer.fill("/record");
    await expect(list.getByRole("option", { name: /^\/record/ })).toContainText(
      "Start or stop recording this screen to a replayable file",
      { timeout: 60_000 },
    );
    await expect(list.getByRole("option", { name: /^\/record/ })).toContainText(
      "Only runs in omp's terminal; nothing is sent from here.",
    );
    await composer.fill("/copy");
    await expect(list.getByRole("option", { name: /^\/copy/ })).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('[data-terminal-only-note="copy"]')).toHaveCount(0);
    await expect(page.locator('[data-terminal-only-note="open"]')).toHaveCount(0);
    await composer.fill("/etc/hosts");
    await expect(page.getByText("No matching commands.")).toBeVisible({ timeout: 60_000 });
  },
);

realTest(
  "the note for /btw and /status reads in light and dark, at 1280 and 390 px, inside the screen",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(480_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open();
    await page.evaluate(() => window.localStorage.setItem("omp-app.theme", "light"));
    await page.reload();
    let composer = await startChat(page);
    for (const theme of ["light", "dark"] as const) {
      if (theme === "dark") {
        // An unsent draft comes back after a reload, so the composer is emptied before it, and checked empty after it.
        await composer.fill("");
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.evaluate(() => window.localStorage.setItem("omp-app.theme", "dark"));
        await page.reload();
        composer = await startChat(page);
        await expect(composer).toHaveValue("");
      }
      if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
      else await expect(page.locator("html")).not.toHaveClass(/dark/);
      for (const width of [1280, 390] as const) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        for (const name of ["btw", "status"] as const) {
          await composer.fill(`/${name}`);
          const note = page.locator(`[data-terminal-only-note="${name}"]`);
          await expect(note).toBeVisible({ timeout: 60_000 });
          // The note's text is painted with the app's own colour, not the browser's default black.
          const description = note.locator("span.text-muted-foreground").first();
          expect(await description.evaluate((element) => getComputedStyle(element).color)).not.toBe(
            "rgb(0, 0, 0)",
          );
          await waitForFiniteAnimations(page);
          const box = await note.boundingBox();
          expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
          expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
          await page.screenshot({
            path: join(screenshots, `fix-2199-${name}-${theme}-${width}.png`),
            fullPage: true,
          });
        }
      }
    }
  },
);
