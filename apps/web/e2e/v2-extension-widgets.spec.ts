import { expect, realTest, startNewChat } from "./real-omp";

/**
 * #2842: the lines an extension shows beside the message box (omp's `ctx.ui.setWidget`), on real omp with a seeded
 * extension: above the box unless it asks for below, without the terminal's colour codes, changed and cleared as the
 * extension changes and clears them, and there for a page that opens the chat later.
 */
realTest.describe("new UI extension widgets", () => {
  realTest.setTimeout(240_000);
  realTest.use({
    // Without it the fake provider's setup turns off omp's own discovery, which loads the agent folder's extensions.
    serverEnv: { FAKE_OPENAI_ENABLE_RULES: "1" },
    seedExtensions: {
      "widgets.ts": `export default function widgets(pi) {
  let replies = 0;
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setWidget("notes", ["\\u001b[36m📎 2 blocks from Lab notes\\u001b[39m"]);
    ctx.ui.setWidget("hint", ["Attached to the next message"], { placement: "belowEditor" });
  });
  pi.on("agent_end", async (_event, ctx) => {
    replies += 1;
    if (replies === 1) ctx.ui.setWidget("notes", ["📎 1 block from Lab notes"]);
    else ctx.ui.setWidget("notes", undefined);
  });
}
`,
    },
  });

  realTest(
    "an extension's lines show above and below the box, change and go as it says, and a page opened later has them",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await startNewChat(page);
      const box = page.getByRole("textbox", { name: "Message" });
      await expect(box).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      const above = page.getByRole("region", { name: "From extensions, above the message box" });
      const below = page.getByRole("region", { name: "From extensions, below the message box" });
      await expect(above).toHaveText("📎 2 blocks from Lab notes", { timeout: 60_000 });
      await expect(below).toHaveText("Attached to the next message");
      const form = await page.locator("[data-tour='message-box']").boundingBox();
      const top = await above.boundingBox();
      const bottom = await below.boundingBox();
      if (form === null || top === null || bottom === null) throw new Error("not drawn");
      expect(top.y + top.height).toBeLessThanOrEqual(form.y);
      expect(bottom.y).toBeGreaterThanOrEqual(form.y + form.height);

      // The extension changes its line after a reply, and clears it after the next.
      await box.fill("count_reply one");
      await box.press("Enter");
      await expect(page.getByText("count-1 one")).toBeVisible({ timeout: 60_000 });
      await expect(above).toHaveText("📎 1 block from Lab notes", { timeout: 60_000 });
      await box.fill("count_reply two");
      await box.press("Enter");
      await expect(page.getByText("count-2 two")).toBeVisible({ timeout: 60_000 });
      await expect(above).toHaveCount(0, { timeout: 60_000 });
      await expect(below).toHaveText("Attached to the next message");

      // Another page opens the same chat: what the extension shows now is there too.
      const later = await realApp.open({ path: "/" });
      await later
        .getByRole("navigation", { name: "Chats" })
        .getByRole("button", { name: /count_reply one/ })
        .first()
        .click();
      await expect(later.getByText("count-2 two")).toBeVisible({ timeout: 60_000 });
      await expect(
        later.getByRole("region", { name: "From extensions, below the message box" }),
      ).toHaveText("Attached to the next message", { timeout: 30_000 });
      await expect(
        later.getByRole("region", { name: "From extensions, above the message box" }),
      ).toHaveCount(0);
      expect(realApp.problems).toEqual([]);
    },
  );
});
