import { expect, realTest, sendPrompt, startChat } from "./real-omp";

const TREE = { name: "Conversation messages" } as const;

realTest(
  "conversation tree accepts omp's Ctrl and Alt arrow chords without stealing them from the composer",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "first tree question");
    await expect(page.getByText("pong", { exact: true })).toHaveCount(1, { timeout: 90_000 });
    await sendPrompt(composer, "second tree question");
    await expect(page.getByText("pong", { exact: true })).toHaveCount(2, { timeout: 90_000 });

    await composer.focus();
    await page.keyboard.press("Control+Shift+H");
    const tree = page.getByRole("tree", TREE);
    await expect(tree).toBeVisible();
    await expect(tree).toHaveAttribute("data-focus-scope", "tree");
    const first = tree.getByRole("treeitem", { name: /first tree question/ });
    const second = tree.getByRole("treeitem", { name: /second tree question/ });
    const firstId = await first.getAttribute("data-tree-entry-id");
    const secondId = await second.getAttribute("data-tree-entry-id");
    if (firstId === null || secondId === null)
      throw new Error("The tree rows do not have entry ids.");
    await page.evaluate(() => {
      const probe = window as typeof window & { treeChordResults?: string[] };
      probe.treeChordResults = [];
      document.addEventListener("keydown", (event) => {
        if (!event.target || !(event.target instanceof Element)) return;
        if (event.target.closest('[data-focus-scope="tree"]') === null) return;
        if (
          (event.key !== "ArrowLeft" && event.key !== "ArrowRight") ||
          event.ctrlKey === event.altKey ||
          event.metaKey ||
          event.shiftKey
        )
          return;
        const modifier = event.ctrlKey ? "Ctrl" : "Alt";
        probe.treeChordResults?.push(
          `${modifier}+${event.key}:${event.defaultPrevented ? "prevented" : "passed"}`,
        );
      });
    });

    await second.focus();
    await page.keyboard.press("Control+ArrowLeft");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-tree-entry-id")))
      .not.toBe(secondId);
    await page.keyboard.press("Alt+ArrowRight");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-tree-entry-id")))
      .toBe(secondId);

    await first.focus();
    await page.keyboard.press("Control+ArrowRight");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-tree-entry-id")))
      .not.toBe(firstId);
    await page.keyboard.press("Alt+ArrowLeft");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-tree-entry-id")))
      .toBe(firstId);

    await second.focus();
    await page.keyboard.press("Control+ArrowRight");
    await page.keyboard.press("Alt+ArrowRight");
    const treeChordResults = await page.evaluate(
      () => (window as typeof window & { treeChordResults?: string[] }).treeChordResults,
    );
    expect(treeChordResults).toEqual([
      "Ctrl+ArrowLeft:prevented",
      "Alt+ArrowRight:prevented",
      "Ctrl+ArrowRight:prevented",
      "Alt+ArrowLeft:prevented",
      "Ctrl+ArrowRight:prevented",
      "Alt+ArrowRight:prevented",
    ]);

    await composer.focus();
    await page.evaluate(() => {
      const probe = window as typeof window & { composerChordDefaultPrevented?: boolean };
      probe.composerChordDefaultPrevented = false;
      document.addEventListener(
        "keydown",
        (event) => {
          if (event.key === "ArrowLeft" && event.ctrlKey)
            probe.composerChordDefaultPrevented = event.defaultPrevented;
        },
        { once: true },
      );
    });
    await page.keyboard.press("Control+ArrowLeft");
    await expect(composer).toBeFocused();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as typeof window & { composerChordDefaultPrevented?: boolean })
              .composerChordDefaultPrevented,
        ),
      )
      .toBe(false);
    expect(realApp.problems).toEqual([]);
  },
);
