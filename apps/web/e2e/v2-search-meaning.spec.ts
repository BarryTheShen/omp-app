import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * Search chats by meaning on real omp and the fake model, with a stand-in embedding service: Settings → App → Search by
 * meaning saves the service and tests it; once it is on, what you and omp wrote in each chat is indexed, and the
 * sidebar's Search and the palette list the chats whose talk is closest to the words, even when no word is shared;
 * off, the sidebar says so.
 */

/**
 * A stand-in for an embedding model: one number per group of words that mean alike, and a small constant, so texts are
 * close when they share a meaning and texts with none of these words point elsewhere.
 */
const MEANINGS = [
  ["tomatoes", "tomato", "vegetable", "vegetables"],
  ["garden", "plants", "plant", "soil"],
  ["water", "watering", "rain"],
] as const;
function vectorOf(text: string): number[] {
  const words = text
    .replace(/^Instruct:.*\nQuery: /s, "")
    .toLowerCase()
    .split(/[^a-z]+/);
  return [
    ...MEANINGS.map(
      (group) => words.filter((word) => (group as readonly string[]).includes(word)).length,
    ),
    0.1,
  ];
}

async function standIn(): Promise<{ readonly address: string; readonly server: Server }> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      const { input } = JSON.parse(body) as { input: string[] };
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          data: input.map((text, index) => ({ index, embedding: vectorOf(text) })),
        }),
      );
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { address: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, server };
}

const box = (page: Page) => page.getByRole("textbox", { name: "Message" });
const sidebar = (page: Page) => page.getByRole("navigation", { name: "Chats" });
const section = (page: Page) =>
  page
    .getByRole("dialog", { name: "Settings" })
    .getByRole("region", { name: "App settings" })
    .getByRole("region", { name: "Search by meaning" });

async function chat(page: Page, text: string): Promise<void> {
  await startNewChat(page);
  await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
  await box(page).fill(text);
  await box(page).press("Enter");
  await expect(page.locator("section[aria-label='Transcript']").getByText(text)).toBeVisible({
    timeout: 60_000,
  });
}

realTest.describe("new UI search chats by meaning", () => {
  realTest.setTimeout(300_000);

  realTest(
    "the service is set and tested in Settings; the sidebar and the palette find a chat by what was said, not its words",
    async ({ realApp }) => {
      const service = await standIn();
      try {
        const page = await realApp.open({ path: "/" });
        await page.getByRole("button", { name: "Settings", exact: true }).first().click();
        await expect(section(page)).toBeVisible({ timeout: 120_000 });
        const on = section(page).getByRole("switch", { name: "Search chats by meaning" });
        // Nothing set yet: it cannot be turned on.
        await expect(on).toBeDisabled();
        await section(page)
          .getByLabel(/^Address/)
          .fill(service.address);
        await section(page).getByLabel("Model").fill("stand-in");
        await section(page).getByRole("button", { name: "Save" }).click();
        await section(page).getByRole("button", { name: "Test" }).click();
        await expect(section(page).getByRole("status").first()).toContainText(
          "with vectors of 4 numbers.",
        );
        await on.click();
        await expect(on).toBeChecked();
        await page.keyboard.press("Escape");

        await chat(page, "When should I water the tomatoes in the garden?");
        await chat(page, "say hello");

        // Neither word is in the chat; its meaning is.
        const search = page.getByRole("searchbox", { name: "Search chats" });
        await search.fill("vegetable plants");
        const byMeaning = sidebar(page).getByRole("region", { name: "By meaning" });
        await expect(async () => {
          // A chat is indexed a few seconds after its turn ends: the search is asked again until it is.
          await search.fill("");
          await search.fill("vegetable plants");
          await expect(byMeaning).toContainText("tomatoes", { timeout: 3_000 });
        }).toPass({ timeout: 90_000 });
        await expect(byMeaning).not.toContainText("say hello");
        await expect(byMeaning.locator("mark")).toHaveCount(0);
        await search.fill("");

        await page.keyboard.press("Control+k");
        const palette = page.getByRole("dialog").filter({ has: page.getByRole("combobox") });
        await palette.getByRole("combobox").fill("vegetable plants");
        await expect(palette.getByRole("option").filter({ hasText: "tomatoes" })).toBeVisible({
          timeout: 15_000,
        });
        await page.keyboard.press("Escape");

        // Off: the sidebar says so, with the way to Settings.
        await page.getByRole("button", { name: "Settings", exact: true }).first().click();
        await on.click();
        await expect(on).not.toBeChecked();
        await page.keyboard.press("Escape");
        await search.fill("vegetable plants");
        await expect(sidebar(page)).toContainText("Search by meaning is off.");
        expect(realApp.problems).toEqual([]);
      } finally {
        service.server.close();
      }
    },
  );
});
