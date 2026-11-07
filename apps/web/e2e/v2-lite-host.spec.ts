import type { Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * Another app's side panel names itself (`/lite?host=siyuan`) and the messages sent from it carry the name: that app's
 * extensions add what it has open only to those messages (`ctx.ui.messageHost` in their input hook), and a line an
 * extension sets for that app (`setWidget(…, { host })`) shows only in its panel. A seeded extension adds where each
 * message came from, and sets one line for the notes app and one for every view.
 */
const FOR_NOTES = "Looking at: Lab notes (the notes app's line)";
const EVERYWHERE = "An extension's line for every view";

const box = (page: Page) => page.getByRole("textbox", { name: "Message" });
/** The chat's messages: the first message also names the chat, in its header and the chat list. */
const transcript = (page: Page) => page.getByRole("region", { name: "Transcript" });

/** The chat ready for a message: the box names omp, or the model on a phone. */
async function ready(page: Page): Promise<void> {
  await expect(box(page)).toHaveAttribute("placeholder", /^(Fake Model|Message omp)/, {
    timeout: 120_000,
  });
}

realTest.describe("new UI messages and lines for another app's side panel", () => {
  realTest.setTimeout(240_000);
  realTest.use({
    // Without it the fake provider's setup turns off omp's own discovery, which loads the agent folder's extensions.
    serverEnv: { FAKE_OPENAI_ENABLE_RULES: "1" },
    seedExtensions: {
      "from.ts": `export default function from(pi) {
  pi.on("input", async (event, ctx) => ({ text: event.text + " (sent from " + (ctx.ui.messageHost ?? "the full app") + ")" }));
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setWidget("notes-open", [${JSON.stringify(FOR_NOTES)}], { host: "siyuan" });
    ctx.ui.setWidget("everywhere", [${JSON.stringify(EVERYWHERE)}]);
  });
}
`,
    },
  });

  realTest(
    "the notes app's panel shows its line, and its messages say they came from it",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/lite" });
      await page.goto(new URL("/lite?host=siyuan", page.url()).toString());
      await ready(page);
      await expect(page.getByText(FOR_NOTES)).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText(EVERYWHERE)).toBeVisible();

      await box(page).fill("hello");
      await box(page).press("Enter");
      await expect(transcript(page).getByText("hello (sent from siyuan)")).toBeVisible({
        timeout: 60_000,
      });
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "the full app, and a lite view no app names, show only the line for every view, and their messages name no app",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await startNewChat(page);
      await ready(page);
      await expect(page.getByText(EVERYWHERE)).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText(FOR_NOTES)).toHaveCount(0);
      await box(page).fill("hello");
      await box(page).press("Enter");
      await expect(transcript(page).getByText("hello (sent from the full app)")).toBeVisible({
        timeout: 60_000,
      });

      await page.goto(new URL("/lite", page.url()).toString());
      await ready(page);
      await expect(page.getByText(EVERYWHERE).first()).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText(FOR_NOTES)).toHaveCount(0);
      expect(realApp.problems).toEqual([]);
    },
  );
});
