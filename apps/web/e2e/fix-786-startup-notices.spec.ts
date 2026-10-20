import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_ROOT, expect, REAL_OMP, realTest, sendPrompt, startChat } from "./real-omp";

realTest.setTimeout(300_000);

const NOTICE = "Startup notice from the fake extension";
const TURN_NOTICE = "Turn notice from the fake extension";

/**
 * A fake extension. `session_start` runs as omp starts a session, before the browser has subscribed to the chat, so
 * that notice is the chat's first event. `agent_end` runs when a turn ends. The error type stays on screen until
 * someone dismisses it.
 */
const EXTENSION_FILE = "startup-notice.ts";
const EXTENSION_SOURCE = `export default function startupNotice(pi) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.notify(${JSON.stringify(NOTICE)}, "error");
  });
  pi.on("agent_end", (_event, ctx) => {
    ctx.ui.notify(${JSON.stringify(TURN_NOTICE)}, "error");
  });
}
`;

/**
 * omp does not load a file seeded in the agent's extensions folder here (its discovery skips it in this run), but it
 * loads any file named with `--extension`. This wrapper runs the real omp with that flag and the run's agent folder.
 */
const DATA_DIR = join(APP_ROOT, ".data");
mkdirSync(DATA_DIR, { recursive: true });
const OMP_WITH_EXTENSION = join(DATA_DIR, "omp-app-786-omp-with-extension.sh");
writeFileSync(
  OMP_WITH_EXTENSION,
  `#!/bin/sh\nexec '${REAL_OMP}' --extension "$PI_CODING_AGENT_DIR/extensions/${EXTENSION_FILE}" "$@"\n`,
);
chmodSync(OMP_WITH_EXTENSION, 0o755);

realTest.use({
  ompBinary: OMP_WITH_EXTENSION,
  seedExtensions: { [EXTENSION_FILE]: EXTENSION_SOURCE },
});

/**
 * Issue #786. A notice omp sends while a chat opens reaches the notification strip: the chat's stream replays the
 * events omp sent before the browser subscribed, so the startup notice is not lost.
 */
realTest("a notice an extension sends as omp starts shows in the strip", async ({ realApp }) => {
  const page = await realApp.open();
  await startChat(page);
  await expect(page.getByTestId("n1-notices").getByText(NOTICE)).toBeVisible({ timeout: 60_000 });
  expect(realApp.problems).toEqual([]);
});

/** Issue #786: the first turn's notice of a fresh chat (the probe in the issue lost such notices in two of three chats). */
realTest(
  "a notice sent when a fresh chat's first turn ends shows in the strip",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "ping");
    await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("n1-notices").getByText(TURN_NOTICE)).toBeVisible({
      timeout: 60_000,
    });
    expect(realApp.problems).toEqual([]);
  },
);

/** Both of a chat's first two turns send a notice, and both notices show: the second turn is the control. */
realTest(
  "a notice from each of a chat's first two turns shows in the strip",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "ping");
    await expect(page.getByText("pong", { exact: true })).toHaveCount(1, { timeout: 60_000 });
    await sendPrompt(composer, "ping");
    await expect(page.getByText("pong", { exact: true })).toHaveCount(2, { timeout: 60_000 });
    // Both turns send the same notice, so it is one entry that counts both (issue 2181: a repeat joins its entry).
    const notices = page.getByTestId("n1-notices");
    await expect(notices.getByText(TURN_NOTICE)).toHaveCount(1, { timeout: 60_000 });
    await expect(notices.getByText("×2", { exact: true })).toBeVisible();
    expect(realApp.problems).toEqual([]);
  },
);

/**
 * Issue #786, the regression side: a chat of three turns, reopened after a reload, shows each message exactly once,
 * even though the replay sends the chat's events again.
 */
realTest(
  "a chat of three turns reopened after a reload shows each message once",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    for (let turn = 1; turn <= 3; turn += 1) {
      await sendPrompt(composer, "ping");
      await expect(page.getByText("pong", { exact: true })).toHaveCount(turn, { timeout: 60_000 });
    }
    await page.reload();
    const transcript = page.getByRole("region", { name: "Conversation transcript" });
    await expect(transcript.getByText("pong", { exact: true })).toHaveCount(3, { timeout: 60_000 });
    await expect(transcript.getByText("ping", { exact: true })).toHaveCount(3);
    expect(realApp.problems).toEqual([]);
  },
);

/**
 * Issue #786, review: a notice the person dismissed does not come back when its chat is reopened. The replay sends the
 * chat's events again, dismissed notices included. A notice of a turn sent after the reload is new, so it shows, and it
 * is the only one.
 */
realTest(
  "a notice the person dismissed does not come back when its chat is reloaded",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    const strip = page.getByTestId("n1-notices");
    await expect(strip.getByText(NOTICE)).toBeVisible({ timeout: 60_000 });
    await strip.getByRole("button", { name: "Dismiss notification" }).click();
    await expect(strip.getByText(NOTICE)).toHaveCount(0);
    await sendPrompt(composer, "ping");
    await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(strip.getByText(TURN_NOTICE)).toBeVisible({ timeout: 60_000 });
    await strip.getByRole("button", { name: "Dismiss notification" }).click();
    await expect(strip.getByText(TURN_NOTICE)).toHaveCount(0);

    await page.reload();
    const transcript = page.getByRole("region", { name: "Conversation transcript" });
    await expect(transcript.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(strip.getByText(NOTICE)).toHaveCount(0);
    await expect(strip.getByText(TURN_NOTICE)).toHaveCount(0);
    await sendPrompt(page.getByRole("textbox", { name: "Message input" }), "ping");
    await expect(transcript.getByText("pong", { exact: true })).toHaveCount(2, { timeout: 60_000 });
    await expect(strip.getByText(TURN_NOTICE)).toHaveCount(1, { timeout: 60_000 });
    await expect(strip.getByText(NOTICE)).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  },
);
