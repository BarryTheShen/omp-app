import type { Page } from "@playwright/test";
import { expect, type RealApp, realTest, startNewChat } from "./real-omp";

/**
 * The new UI's message box (`apps/ui`, under `/v2/`) on real omp: the `/` command menu, `@` file mentions, `!` runs
 * in bash shown as run boxes, and what a built-in command prints.
 */
realTest.describe("new UI commands, mentions and shell runs", () => {
  realTest.setTimeout(240_000);
  realTest.use({
    seedWorkspace: { files: { "src/parser.ts": "export const parse = 1;\n" }, gitRepo: true },
  });

  async function newChat(realApp: RealApp): Promise<Page> {
    const page = await realApp.open({ path: "/" });
    await startNewChat(page);
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveAttribute(
      "placeholder",
      "Message omp",
      { timeout: 120_000 },
    );
    return page;
  }

  realTest("`/` lists omp's commands and `@` lists the folder's files", async ({ realApp }) => {
    const page = await newChat(realApp);
    const box = page.getByRole("textbox", { name: "Message" });

    await box.pressSequentially("/ret");
    const commands = page.getByRole("listbox", { name: "omp's commands" });
    await expect(commands.getByRole("option", { name: /^\/retry/ })).toBeVisible({
      timeout: 30_000,
    });
    await box.press("Enter");
    await expect(box).toHaveValue("/retry ");
    await expect(commands).toHaveCount(0);

    await box.fill("");
    await box.pressSequentially("/");
    await expect(commands).toBeVisible();
    await box.press("Escape");
    await expect(commands).toHaveCount(0);
    await expect(box).toHaveValue("/");
    // Once that `/` is gone, a new one opens the menu again.
    await box.fill("");
    await box.pressSequentially("/");
    await expect(commands).toBeVisible();
    await box.press("Escape");

    await box.fill("");
    await box.pressSequentially("look at @pars");
    const files = page.getByRole("listbox", { name: "Files to mention" });
    await expect(files.getByRole("option", { name: /src\/parser\.ts/ })).toBeVisible({
      timeout: 30_000,
    });
    await box.press("Enter");
    await expect(box).toHaveValue("look at @src/parser.ts ");

    expect(realApp.problems).toEqual([]);
  });

  realTest(
    "`!` runs a command in bash as a run box, Stop ends one, `!!` keeps one out of context, and a command's output shows until dismissed",
    async ({ realApp }) => {
      const page = await newChat(realApp);
      const box = page.getByRole("textbox", { name: "Message" });

      // The box's caption shows the command; only bash's output says "hello-42". The chat has no reply yet, so omp has
      // not written its file: the box comes from omp's own result.
      await box.fill("!echo hello-$((40+2))");
      await expect(page.getByText("bash", { exact: true })).toBeVisible();
      await box.press("Enter");
      const run = page.getByRole("figure", { name: "Shell run: echo hello-$((40+2))" });
      await expect(run).toContainText("hello-42", { timeout: 60_000 });
      await expect(run).toContainText("exit 0");
      await expect(box).toHaveValue("");

      await box.fill("!sleep 30; echo late-$((1+1))");
      await box.press("Enter");
      const slow = page.getByRole("figure", { name: "Shell run: sleep 30; echo late-$((1+1))" });
      await expect(slow).toContainText("running…", { timeout: 30_000 });
      await slow.getByRole("button", { name: "Stop the command" }).click();
      await expect(slow).toContainText("cancelled", { timeout: 20_000 });
      await expect(slow).not.toContainText("late-2");

      await box.fill("!!echo kept-out");
      await expect(page.getByText("bash · not in context")).toBeVisible();
      await box.press("Enter");
      const hidden = page.getByRole("figure", { name: "Shell run: echo kept-out" });
      await expect(hidden).toContainText("exit 0", { timeout: 60_000 });
      await expect(hidden).toContainText("not in context");
      await box.fill("/tools");
      await box.press("Escape");
      await box.press("Enter");
      const dismiss = page.getByRole("button", { name: "Dismiss" });
      await expect(dismiss).toBeVisible({ timeout: 60_000 });
      await dismiss.click();
      await expect(dismiss).toHaveCount(0);

      expect(realApp.problems).toEqual([]);
    },
  );
  realTest.describe("an extension that adds to the `@` menu", () => {
    // As in omp's terminal: the extension stacks a provider at session start, offering notes after an `@word`.
    realTest.use({
      // Without it the fake provider's setup turns off omp's own discovery, which loads the agent folder's extensions.
      serverEnv: { FAKE_OPENAI_ENABLE_RULES: "1" },
      seedExtensions: {
        "notes.ts": `export default function notes(pi) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.addAutocompleteProvider((current) => ({
      ...current,
      async getSuggestions(lines, line, col, signal) {
        const at = /@(\\w+)$/.exec(lines[line].slice(0, col));
        if (!at || !"lab report".includes(at[1].toLowerCase())) return current.getSuggestions(lines, line, col, signal);
        return { prefix: at[0], items: [{ value: "n1", label: "Lab report", description: "note from Notes" }] };
      },
      applyCompletion(lines, line, col, item, prefix) {
        const next = [...lines];
        const insert = "@[" + item.label + "](note:" + item.value + ") ";
        next[line] = lines[line].slice(0, col - prefix.length) + insert + lines[line].slice(col);
        return { lines: next, cursorLine: line, cursorCol: col - prefix.length + insert.length };
      },
    }));
  });
}
`,
      },
    });

    realTest(
      "its rows follow the folder's files, and taking one puts its text in the box",
      async ({ realApp }) => {
        const page = await newChat(realApp);
        const box = page.getByRole("textbox", { name: "Message" });

        await box.pressSequentially("read @lab");
        const menu = page.getByRole("listbox", { name: "Files and more to mention" });
        const note = menu.getByRole("option", { name: /Lab report.*note from Notes/ });
        await expect(note).toBeVisible({ timeout: 30_000 });
        await note.click();
        await expect(box).toHaveValue("read @[Lab report](note:n1) ");
        await expect(menu).toHaveCount(0);

        // A word the extension does not know: the folder's files alone, under their usual name.
        await box.fill("");
        await box.pressSequentially("look at @pars");
        const files = page.getByRole("listbox", { name: "Files to mention" });
        await expect(files.getByRole("option", { name: /src\/parser\.ts/ })).toBeVisible({
          timeout: 30_000,
        });
        await expect(files.getByRole("option")).toHaveCount(1);

        expect(realApp.problems).toEqual([]);
      },
    );
  });
});
