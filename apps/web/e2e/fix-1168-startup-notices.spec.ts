import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  APP_ROOT,
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

realTest.setTimeout(300_000);

/** A start-up notice that lists the tools one MCP server mounted, as omp's own notices do. */
const mounted = (server: string, tools: readonly string[]): string =>
  `xd://: mounted ${tools.map((tool) => `mcp__${server}_${tool}`).join(", ")}`;

const NOTION_MOUNT = mounted("notion", [
  "check_mcp_next_steps",
  "convert_page_to_skill",
  "create_attachment",
  "create_comment",
  "create_database",
  "create_file_upload",
  "create_folder",
  "create_pages",
  "create_view",
  "download_attachment",
  "download_skill",
  "duplicate_page",
  "fetch",
  "get_async_task",
  "wait_session",
]);
const CALENDAR_MOUNT = mounted("google_calendar", [
  "create_event",
  "delete_event",
  "get_current_time",
  "get_event",
  "get_freebusy",
  "list_calendars",
  "list_events",
  "manage_accounts",
  "search_events",
  "update_event",
]);
const CACHE_NOTICE = "Build cache warmed";
const DISK_WARNING = "Disk is almost full on the build volume";
const INFO_NOTICES = [NOTION_MOUNT, CALENDAR_MOUNT, CACHE_NOTICE];

/**
 * A fake extension. `session_start` runs as omp starts a session, before the browser has subscribed to the chat, so these
 * notices reach the page as the chat's first events: two informational notices that list tools, one short informational
 * notice, and a warning.
 */
const EXTENSION_FILE = "startup-notices-1168.ts";
const EXTENSION_SOURCE = `export default function startupNotices(pi) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.notify(${JSON.stringify(NOTION_MOUNT)}, "info");
    ctx.ui.notify(${JSON.stringify(CALENDAR_MOUNT)}, "info");
    ctx.ui.notify(${JSON.stringify(CACHE_NOTICE)}, "info");
    ctx.ui.notify(${JSON.stringify(DISK_WARNING)}, "warning");
  });
}
`;

/**
 * A chat does not load a file seeded in the agent's extensions folder here, but it loads any file named with `--extension`.
 * This wrapper adds that flag, with the run's agent folder, to every chat's command (the same wrapper issue #786 uses).
 */
const DATA_DIR = join(APP_ROOT, ".data");
mkdirSync(DATA_DIR, { recursive: true });
const OMP_WITH_EXTENSION = join(DATA_DIR, "omp-app-1168-omp-with-extension.sh");
writeFileSync(
  OMP_WITH_EXTENSION,
  `#!/bin/sh\nexec "$@" --extension "$PI_CODING_AGENT_DIR/extensions/${EXTENSION_FILE}"\n`,
);
chmodSync(OMP_WITH_EXTENSION, 0o755);

realTest.use({
  chatWrapper: OMP_WITH_EXTENSION,
  seedExtensions: { [EXTENSION_FILE]: EXTENSION_SOURCE },
});

/**
 * Issue #1168. omp's start-up notices (three informational ones) collapse into one quiet line; opening it lists them, and
 * a long one is cut with "Show all", while a warning still shows. A reload of the chat does not bring them back.
 */
realTest(
  "omp's start-up notices collapse into one line that lists them, a warning still shows, and they do not return on reload",
  async ({ realApp }) => {
    const app = await realApp.open();
    const composer = await startChat(app);

    const toggle = app.getByRole("button", { name: `${INFO_NOTICES.length} notices from omp` });
    await expect(toggle).toBeVisible({ timeout: 60_000 });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(app.getByText(CACHE_NOTICE)).toBeHidden();
    await expect(app.getByTestId("n1-notices").getByText(DISK_WARNING)).toBeVisible({
      timeout: 60_000,
    });

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(app.getByText(CACHE_NOTICE)).toBeVisible();
    // The long notices are cut where the tool list runs on; "Show all" reads the rest.
    await expect(app.getByText("mcp__notion_wait_session")).toBeHidden();
    await expect(app.getByRole("button", { name: "Show all" })).toHaveCount(2);
    await app.getByRole("button", { name: "Show all" }).first().click();
    await expect(app.getByText("mcp__notion_wait_session")).toBeVisible();

    await waitForFiniteAnimations(app);
    mkdirSync(screenshots, { recursive: true });
    await app.screenshot({
      path: join(screenshots, "fix-1168-startup-light-r1.png"),
      fullPage: true,
    });
    await app.evaluate(() => document.documentElement.classList.add("dark"));
    await expect(app.locator("html")).toHaveClass(/dark/);
    await expect(app.locator("body")).toHaveCSS("background-color", /^(rgb|oklch)/);
    await waitForFiniteAnimations(app);
    await app.screenshot({
      path: join(screenshots, "fix-1168-startup-dark-r1.png"),
      fullPage: true,
    });
    await app.evaluate(() => document.documentElement.classList.remove("dark"));
    await app.setViewportSize({ width: 390, height: 844 });
    await expect(toggle).toBeVisible();
    await waitForFiniteAnimations(app);
    await app.screenshot({
      path: join(screenshots, "fix-1168-startup-narrow-r1.png"),
      fullPage: true,
    });
    await app.setViewportSize({ width: 1280, height: 800 });

    // The chat is saved once it has answered, so a reload reopens it; an unsent chat starts afresh after a reload (#1944),
    // and a fresh chat's omp sends its own start-up notices.
    await sendPrompt(composer, "save this chat");
    const transcript = app.getByRole("region", { name: "Conversation transcript" });
    await expect(transcript.getByText("pong", { exact: true })).toBeVisible({ timeout: 90_000 });
    // The reopened chat replays what the server still holds, but applies only what came after its last answered turn
    // (#786): the start-up notices came before it. The replay is applied before the history loads, so once the answer
    // shows again, any notice the replay would bring back is already on the page.
    await app.reload();
    await expect(transcript.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(app.getByRole("button", { name: /notices? from omp/ })).toHaveCount(0);
    await expect(app.getByText(CACHE_NOTICE)).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  },
);
