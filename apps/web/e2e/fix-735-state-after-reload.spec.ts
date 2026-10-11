import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_ROOT, expect, REAL_OMP, realTest, sendPrompt, startChat } from "./real-omp";

realTest.setTimeout(300_000);

const STATUS = "Build ready";
const WIDGET_LINE = "Widget line from the fake extension";
const NOTICE = "Startup notice from the fake extension";

/**
 * A fake extension. `session_start` runs as omp starts a session, before the browser has subscribed to the chat: the
 * status, the widget and the notice are what the chat shows from then on.
 */
const EXTENSION_FILE = "state-after-reload.ts";
const EXTENSION_SOURCE = `export default function stateAfterReload(pi) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus("build", ${JSON.stringify(STATUS)});
    ctx.ui.setWidget("build", [${JSON.stringify(WIDGET_LINE)}]);
    ctx.ui.notify(${JSON.stringify(NOTICE)}, "error");
  });
}
`;

/**
 * omp does not load a file seeded in the agent's extensions folder here, but it loads any file named with `--extension`.
 * This wrapper runs the real omp with that flag and the run's agent folder (the same wrapper issue #786 uses).
 */
const DATA_DIR = join(APP_ROOT, ".data");
mkdirSync(DATA_DIR, { recursive: true });
const OMP_WITH_EXTENSION = join(DATA_DIR, "omp-app-735-omp-with-extension.sh");
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
 * Issue #735. A status and a widget omp sets are state, not events. A chat opened again (a reload) must show them even
 * when a turn has ended since they were set: the replay covers only the events after the last turn's end.
 */
realTest(
  "a status and a widget an extension sets are shown again after the page reloads, once a turn has ended",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    const transcript = page.getByRole("region", { name: "Conversation transcript" });
    await expect(page.getByText(STATUS)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(WIDGET_LINE)).toBeVisible({ timeout: 60_000 });

    await sendPrompt(composer, "ping");
    await expect(transcript.getByText("pong", { exact: true })).toHaveCount(1, { timeout: 60_000 });

    await page.reload();
    await expect(transcript.getByText("pong", { exact: true })).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByText(STATUS)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(WIDGET_LINE)).toBeVisible({ timeout: 60_000 });
    expect(realApp.problems).toEqual([]);
  },
);

/**
 * Issue #735. A notice omp replays when a chat is opened again is shown, but it is not announced a second time: the
 * screen reader read it when it was new. The chat is reloaded before any turn ends, so its notice is in the replay.
 */
realTest(
  "a notice a reloaded chat replays is shown, and no live region reads it a second time",
  async ({ realApp }) => {
    const page = await realApp.open();
    await startChat(page);
    await expect(page.getByTestId("n1-notices").getByText(NOTICE)).toBeVisible({
      timeout: 60_000,
    });

    await page.reload();
    await expect(page.getByTestId("n1-notices").getByText(NOTICE)).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.locator('[data-n1-live="assertive"]').getByText(NOTICE)).toHaveCount(0);
    await expect(page.locator('[data-n1-live="polite"]').getByText(NOTICE)).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  },
);
