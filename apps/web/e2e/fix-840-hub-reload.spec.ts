import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, realTest, screenshots, sendPrompt, startChat } from "./real-omp";

/**
 * Issue #840. The Agent Hub listed a finished worker until the page reloaded, then showed "Nothing here yet":
 * omp forgets a finished worker, and the app's roster never read the chat's transcripts, which are the only
 * record left. The live playground read them, so its own reload test passed while the app did not. This drives
 * the app's own Agents tab.
 */
realTest(
  "real omp: a finished worker stays under Recent in the Agent Hub after a reload",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "spawn_subagent");
    await expect(page.getByText("Nested probe completed.").first()).toBeVisible({
      timeout: 120_000,
    });

    await page.getByRole("tab", { name: "Agents" }).click();
    const hub = page.getByRole("region", { name: "Agent Hub" });
    await expect(hub.getByRole("option", { name: /Finished.*NestedProbe/ })).toHaveCount(1, {
      timeout: 120_000,
    });

    await page.reload();
    // The chat reopens by itself; the hub is read once its answer is on screen.
    await expect(page.getByText("Nested probe completed.").first()).toBeVisible({
      timeout: 120_000,
    });
    await page.getByRole("tab", { name: "Agents" }).click();
    await expect(hub.getByRole("option", { name: /Finished.*NestedProbe/ })).toHaveCount(1, {
      timeout: 120_000,
    });
    await expect(hub.getByText("Nothing here yet")).toHaveCount(0);

    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "fix-840-hub-after-reload.png") });
  },
);
