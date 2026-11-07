import { expect, realTest, startNewChat } from "./real-omp";

/**
 * The lite view keeps omp's start-up lines out of its chat (#2844): a seeded extension lists the tools it mounted when
 * a chat starts (a status line) and reports an error. In the lite view the list is not shown and the error is one
 * line; the full app shows both, as before.
 */
const MOUNTED = /notes: mounted notes_tool_1/;
const FAILED = /notes: could not reach the notes app/;

realTest.describe("new UI lite view without start-up lines", () => {
  realTest.setTimeout(240_000);
  realTest.use({
    // Without it the fake provider's setup turns off omp's own discovery, which loads the agent folder's extensions.
    serverEnv: { FAKE_OPENAI_ENABLE_RULES: "1" },
    seedExtensions: {
      "notes.ts": `export default function notes(pi) {
  pi.on("session_start", async (_event, ctx) => {
    const tools = Array.from({ length: 16 }, (_, index) => "notes_tool_" + (index + 1)).join(", ");
    ctx.ui.notify("notes: mounted " + tools, "info");
    ctx.ui.notify("notes: could not reach the notes app at its address, so its tools are off until it answers.\\nOpen the notes app, then start a new chat.", "error");
  });
}
`,
    },
  });

  realTest(
    "a new lite chat shows the error as one line and no list of mounted tools",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/lite" });
      const failed = page.getByRole("alert").filter({ hasText: FAILED });
      await expect(failed).toBeVisible({ timeout: 60_000 });
      const height = (await failed.boundingBox())?.height ?? 0;
      expect(height).toBeGreaterThan(0);
      expect(height).toBeLessThan(32);
      await expect(page.getByText(MOUNTED)).toHaveCount(0);
      // A click shows the whole error.
      await failed.getByRole("button", { name: FAILED }).click();
      expect((await failed.boundingBox())?.height ?? 0).toBeGreaterThan(height);
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest("the full app shows both, as before", async ({ realApp }) => {
    const page = await realApp.open({ path: "/" });
    await startNewChat(page);
    await expect(page.getByRole("alert").filter({ hasText: FAILED })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText(MOUNTED)).toBeVisible();
    expect(realApp.problems).toEqual([]);
  });
});
