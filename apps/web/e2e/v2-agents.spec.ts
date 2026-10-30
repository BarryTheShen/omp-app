import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

/**
 * The new UI's Agent Hub (`apps/ui`, under `/v2/`) on real omp: a chat's subagents in a pill above the message box and
 * in the Hub, with the chosen one's transcript, Kill and a message to it; Alt+A and Esc; a task card's agent opens it.
 */

/** A subagent type that runs inline: `blocking: true` makes the parent wait, so its task card shows it running. */
const FOREGROUND_AGENT = [
  "---",
  "name: fgprobe",
  "description: Foreground probe that runs one step inline for a spec.",
  "blocking: true",
  "---",
  "Complete the assignment with the tools you have.",
  "",
].join("\n");

realTest.describe("new UI Agent Hub", () => {
  realTest.setTimeout(240_000);
  const box = (page: Page) => page.getByRole("textbox", { name: "Message" });
  const hubOf = (page: Page) => page.getByRole("complementary", { name: "Agent Hub" });

  async function newChat(page: Page): Promise<void> {
    await page
      .getByRole("navigation", { name: "Chats" })
      .getByRole("button", { name: "New chat" })
      .click();
    await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
  }

  realTest(
    "a running subagent shows in the Hub with its transcript, and Kill stops it",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await newChat(page);
      await box(page).fill("spawn_long_subagent");
      await box(page).press("Enter");
      const pill = page.getByRole("button", { name: "1 agent running" });
      await expect(pill).toBeVisible({ timeout: 60_000 });

      await pill.click();
      const hub = hubOf(page);
      await expect(hub).toBeFocused();
      await hub.getByRole("button", { name: /^LongProbe/ }).click();
      const agent = hub.getByRole("region", { name: "LongProbe", exact: true });
      await expect(agent.getByText("running", { exact: true })).toBeVisible();
      await expect(hub.getByRole("region", { name: "LongProbe's log" })).toContainText(
        "sleep 60; echo long-probe-done",
        { timeout: 30_000 },
      );

      await agent.getByRole("button", { name: "Kill" }).click();
      await expect(agent.getByText("aborted", { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(agent.getByRole("button", { name: "Kill" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "1 agent", exact: true })).toBeVisible();

      // Esc closes the Hub, also after Kill went away, and the caret goes back to the message box.
      await page.keyboard.press("Escape");
      await expect(hub).toHaveCount(0);
      await expect(box(page)).toBeFocused();
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "Alt+A opens the Hub, a message reaches a running subagent, and Alt+A closes it",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await newChat(page);
      await box(page).fill("spawn_steerable_subagent");
      await box(page).press("Enter");
      await expect(page.getByRole("button", { name: "1 agent running" })).toBeVisible({
        timeout: 60_000,
      });

      await box(page).press("Alt+a");
      const hub = hubOf(page);
      await expect(hub).toBeFocused();
      await hub.getByRole("button", { name: /^SteerProbe/ }).click();
      const agent = hub.getByRole("region", { name: "SteerProbe", exact: true });
      await agent.getByRole("textbox", { name: "Message SteerProbe" }).fill("steer_probe: wrap up");
      await agent.getByRole("button", { name: "Send" }).click();
      // The worker yields once the message reaches it.
      await expect(agent.getByText("completed", { exact: true })).toBeVisible({ timeout: 60_000 });
      await expect(agent.getByRole("textbox", { name: "Message SteerProbe" })).toHaveCount(0);

      await page.keyboard.press("Alt+a");
      await expect(hub).toHaveCount(0);
      await expect(box(page)).toBeFocused();
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest("a task card's agent opens the Hub on that agent", async ({ realApp }) => {
    // omp reads user agents from `~/.omp/agent/agents`; the fixture runs omp with HOME at `<root>/home`.
    const agents = join(dirname(realApp.agentDir), "home", ".omp", "agent", "agents");
    await mkdir(agents, { recursive: true });
    await writeFile(join(agents, "fgprobe.md"), FOREGROUND_AGENT);
    const page = await realApp.open({ path: "/" });
    await newChat(page);
    await box(page).fill("spawn_foreground_intent 8");
    await box(page).press("Enter");
    // The blocking task returns once its agent is done.
    await expect(page.getByRole("button", { name: "1 agent", exact: true })).toBeVisible({
      timeout: 90_000,
    });

    // The card's agents are in its body: open the card, then follow its agent.
    const transcript = page.getByRole("region", { name: "Transcript" });
    await transcript.getByRole("button", { name: "task fgprobe" }).click();
    const link = transcript.getByRole("button", { name: /^IntentProbe/ });
    await expect(link).toBeVisible();
    await link.click();
    const hub = hubOf(page);
    await expect(hub.getByRole("region", { name: "IntentProbe", exact: true })).toBeVisible();
    await expect(hub.getByRole("region", { name: "IntentProbe's log" })).toContainText(
      "intent-child-done",
      { timeout: 30_000 },
    );
    expect(realApp.problems).toEqual([]);
  });
});
