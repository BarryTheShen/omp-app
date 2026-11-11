import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * The new UI's Agent Hub (`apps/ui`, under `/v2/`) on real omp: a chat's subagents in a pill above the message box and
 * in the Hub, with the chosen one's transcript, Kill and a message to it; Alt+A and Esc; a task card's agent opens it;
 * on a phone, an agent picked in the chat's details opens the Hub over them (#18).
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
    await startNewChat(page);
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
      // The model it runs, by its name, with omp's own `provider/id` as the tooltip.
      const model = agent.locator(".ag-chip--model");
      await expect(model).toContainText("Fake Model", { timeout: 30_000 });
      await expect(model).toHaveAttribute("title", /^fake\/fake-model/);
      await expect(hub.getByRole("region", { name: "LongProbe's log" })).toContainText(
        "sleep 60; echo long-probe-done",
        { timeout: 30_000 },
      );

      await agent.getByRole("button", { name: "Kill" }).click();
      // The agent's status chip. omp 18.18 also ends its log with the stopped reply's own line ("aborted", "Request was
      // aborted"), as a stopped reply in a chat shows.
      await expect(agent.locator(".ag-chip", { hasText: /^aborted$/ })).toBeVisible({
        timeout: 30_000,
      });
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
    "a subagent that ended is still in the Hub with its transcript after the server restarts",
    async ({ realApp }) => {
      // The restart closes the old page's connection.
      realApp.allowProblem(/WebSocket|401|403|expired/i);
      const page = await realApp.open({ path: "/" });
      const context = page.context();
      await newChat(page);
      await box(page).fill("spawn_subagent");
      await box(page).press("Enter");
      await expect(page.getByRole("button", { name: "1 agent", exact: true })).toBeVisible({
        timeout: 90_000,
      });
      // The subagent ran as a background job: omp's row says when it is done (its text folds inside the row).
      await expect(page.getByRole("button", { name: /^Background job completed/ })).toBeVisible({
        timeout: 60_000,
      });
      // The layout keeps the chat once it is saved, so the reopened page shows it again.
      await page.waitForTimeout(1_500);

      await page.close();
      await realApp.restartServer();
      const again = await realApp.open({ path: "/", context });
      await expect(box(again)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      // omp's roster starts empty after the restart; the subagent's transcript beside the chat brings it back.
      await again.getByRole("button", { name: "1 agent", exact: true }).click({ timeout: 60_000 });
      const hub = hubOf(again);
      await hub.getByRole("button", { name: /^NestedProbe/ }).click();
      await expect(hub.getByRole("region", { name: "NestedProbe's log" })).toContainText(
        "nested_probe_child",
        { timeout: 30_000 },
      );
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

  realTest(
    "on a phone, an agent picked in the chat's details opens the Hub on it, the details stepping aside (#18)",
    async ({ realApp, browser }) => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
      });
      // A phone opens in a new chat.
      const page = await realApp.open({ path: "/", context });
      await expect(box(page)).toHaveAttribute("placeholder", /^Fake Model/, { timeout: 120_000 });
      await box(page).fill("spawn_steerable_subagent");
      await page.getByRole("button", { name: "Send" }).tap();
      // With agents, the top bar's details button says so and opens the details at Agents.
      const detailsButton = page.getByRole("button", { name: "1 agent running. Details" });
      await expect(detailsButton).toBeVisible({ timeout: 60_000 });

      await detailsButton.tap();
      const details = page.getByRole("region", { name: "Chat details" });
      await expect(details.getByRole("tab", { name: "Agents" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await details.getByRole("button", { name: /^SteerProbe/ }).tap();
      await expect(details).toHaveCount(0);
      await expect(
        hubOf(page).getByRole("region", { name: "SteerProbe", exact: true }),
      ).toBeVisible({ timeout: 30_000 });
      expect(realApp.problems).toEqual([]);
      await context.close();
    },
  );
});
